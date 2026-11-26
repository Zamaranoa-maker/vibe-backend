/* jobs.mjs — reconciliation ليلية + تحرير الحجوزات */
import { pool } from './db.mjs';
import { withTx } from './wallet.mjs';

/* ∑ ledger لازم يساوي رصيد المحفظة لكل مستخدم */
export async function reconcile() {
  const { rows } = await pool.query(`
    SELECT w.user_id, w.coins, w.diamonds,
      COALESCE((SELECT SUM(amount) FROM ledger_entries l
        WHERE l.user_id=w.user_id AND l.asset='coin'),0) AS ledger_coins,
      COALESCE((SELECT SUM(amount) FROM ledger_entries l
        WHERE l.user_id=w.user_id AND l.asset='diamond'),0) AS ledger_diamonds
    FROM wallets w`);
  const mismatches = rows.filter(r =>
    Number(r.coins) !== Number(r.ledger_coins) || Number(r.diamonds) !== Number(r.ledger_diamonds));
  if (mismatches.length) {
    console.error('[RECONCILE] MISMATCH', mismatches);
    await pool.query(`INSERT INTO alerts (kind, detail, created_at) VALUES ('reconcile',$1,now())`,
      [JSON.stringify(mismatches)]);
  }
  return { checked:rows.length, mismatches:mismatches.length };
}

export async function releaseHolds() {
  await withTx(async (c) => {
    const { rows } = await c.query(`
      UPDATE diamond_holds SET released=TRUE
      WHERE id IN (SELECT id FROM diamond_holds WHERE NOT released AND release_at<=now()
                   LIMIT 500 FOR UPDATE SKIP LOCKED)
      RETURNING id,user_id,amount,gift_tx_id`);
    for (const h of rows) {
      const flagged = await c.query(`SELECT 1 FROM fraud_flags WHERE ref_id=$1 AND resolved=FALSE`,[h.gift_tx_id]);
      if (flagged.rows.length) { await c.query(`UPDATE diamond_holds SET released=FALSE, release_at=now()+interval '3 days' WHERE id=$1`,[h.id]); continue; }
      await c.query(`UPDATE wallets SET pending_diamonds=pending_diamonds-$2 WHERE user_id=$1`,[h.user_id,h.amount]);
      const col='diamonds';
      await c.query(`UPDATE wallets SET ${col}=${col}+$2 WHERE user_id=$1`,[h.user_id,h.amount]);
      await c.query(`INSERT INTO ledger_entries (user_id,asset,amount,balance_after,type,ref_type,ref_id,idempotency_key)
        VALUES ($1,'diamond',$2,(SELECT diamonds FROM wallets WHERE user_id=$1),'gift_received','hold',$3,$4)`,
        [h.user_id,h.amount,String(h.id),'hold:'+h.id]);
    }
  });
}

export function startJobs(){
  setInterval(()=>releaseHolds().catch(e=>console.error('[hold]',e.message)), 60_000);
  // كل ليلة 3 صباحاً
  const MS_DAY=86400000;
  const now=new Date(), next=new Date(now); next.setHours(3,0,0,0);
  if(next<now)next=new Date(next.getTime()+MS_DAY);
  setTimeout(function night(){ reconcile().catch(e=>console.error('[reconcile]',e.message));
    setTimeout(night,MS_DAY); }, next-now);
}

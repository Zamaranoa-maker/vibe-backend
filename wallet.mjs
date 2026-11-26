import { pool } from './db.mjs';

export class WalletError extends Error {
  constructor(code, msg) { super(msg || code); this.code = code; }
}

// دالة واحدة تعدّل الرصيد وتكتب الـ ledger. تتنادى دايماً جوه transaction.
export async function applyEntry(client, { userId, asset, amount, type, refType, refId, key }) {
  const col = asset === 'coin' ? 'coins' : 'diamonds';
  const { rows } = await client.query(
    `UPDATE wallets SET ${col} = ${col} + $2, updated_at = now()
     WHERE user_id = $1 AND NOT frozen RETURNING ${col} AS bal`,
    [userId, amount]
  );
  if (!rows.length) throw new WalletError('WALLET_UNAVAILABLE', 'المحفظة غير متاحة');
  // لو الرصيد هيبقى سالب، CHECK constraint هيرفض العملية تلقائياً
  await client.query(
    `INSERT INTO ledger_entries (user_id, asset, amount, balance_after, type, ref_type, ref_id, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [userId, asset, amount, rows[0].bal, type, refType, refId, key]
  );
}

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    // تعارض serialization / deadlock → إعادة محاولة واحدة بيعملها الـ caller
    throw e;
  } finally { client.release(); }
}

// ---------- إرسال هدية ----------
export async function sendGift({ senderId, receiverId, giftId, quantity, videoId, liveId, key }) {
  return withTx(async (c) => {
    // 0) idempotency: لو الطلب اتنفذ قبل كده رجّع نفس النتيجة
    const dup = await c.query(
      `SELECT * FROM gift_transactions WHERE sender_id=$1 AND idempotency_key=$2`, [senderId, key]);
    if (dup.rows.length) return { ...dup.rows[0], duplicate: true };

    // 1) قفل المحفظتين بترتيب ثابت (يمنع deadlock)
    const ids = [senderId, receiverId].sort((a, b) => a - b);
    await c.query(`SELECT user_id FROM wallets WHERE user_id = ANY($1) ORDER BY user_id FOR UPDATE`, [ids]);

    // 2) قواعد العمل (من قاعدة البيانات مش من العميل)
    const { rows: [s] } = await c.query(
      `SELECT u.id, u.birth_date, u.status, w.coins FROM users u JOIN wallets w ON w.user_id=u.id WHERE u.id=$1`, [senderId]);
    if (!s || s.status !== 'active') throw new WalletError('ACCOUNT_RESTRICTED');
    if (ageOf(s.birth_date) < 18) throw new WalletError('UNDER_AGE', 'الهدايا متاحة لـ 18+ فقط');

    const { rows: [r] } = await c.query(`SELECT id, status FROM users WHERE id=$1`, [receiverId]);
    if (!r || r.status !== 'active') throw new WalletError('RECEIVER_UNAVAILABLE');
    const blocked = await c.query(
      `SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`,
      [senderId, receiverId]);
    if (blocked.rows.length) throw new WalletError('BLOCKED');

    const { rows: [g] } = await c.query(`SELECT * FROM gifts WHERE id=$1 AND active`, [giftId]);
    if (!g) throw new WalletError('GIFT_NOT_FOUND');

    const cost = g.price_coins * quantity;
    const diamonds = Math.floor((cost * g.creator_share_bps) / 10000);

    // 3) حدود الإنفاق
    await assertWithinLimits(c, senderId, cost);

    // 4) الخصم والإضافة (الخصم هيفشل لو الرصيد مش كفاية)
    try {
      await applyEntry(c, { userId: senderId, asset: 'coin', amount: -cost, type: 'gift_sent',
        refType: 'gift', refId: String(giftId), key });
    } catch (e) {
      if (e.code === '23514') throw new WalletError('INSUFFICIENT_COINS', 'الرصيد غير كافٍ');
      throw e;
    }

    // الماس يدخل "pending" الأول (7 أيام) قبل ما يبقى قابل للسحب
    await c.query(`UPDATE wallets SET pending_diamonds = pending_diamonds + $2 WHERE user_id=$1`, [receiverId, diamonds]);

    const { rows: [tx] } = await c.query(
      `INSERT INTO gift_transactions (sender_id, receiver_id, gift_id, quantity, coins_spent, diamonds_earned, video_id, live_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [senderId, receiverId, giftId, quantity, cost, diamonds, videoId ?? null, liveId ?? null, key]);

    await c.query(
      `INSERT INTO diamond_holds (user_id, amount, release_at, gift_tx_id)
       VALUES ($1,$2, now() + interval '7 days', $3)`, [receiverId, diamonds, tx.id]);

    await fraudSignals(c, tx);   // قواعد الاشتباه (تحت)
    return tx;
  });
}

async function assertWithinLimits(c, userId, cost) {
  const { rows: [lim] } = await c.query(`SELECT * FROM spending_limits WHERE user_id=$1`, [userId]);
  if (!lim) return;
  const { rows: [sp] } = await c.query(
    `SELECT
       COALESCE(SUM(-amount) FILTER (WHERE created_at >= date_trunc('day', now())),0)   AS day,
       COALESCE(SUM(-amount) FILTER (WHERE created_at >= date_trunc('month', now())),0) AS month
     FROM ledger_entries WHERE user_id=$1 AND asset='coin' AND type='gift_sent'`, [userId]);
  if (lim.daily_limit   && Number(sp.day)   + cost > lim.daily_limit)   throw new WalletError('DAILY_LIMIT', 'وصلت للحد اليومي اللي حددته');
  if (lim.monthly_limit && Number(sp.month) + cost > lim.monthly_limit) throw new WalletError('MONTHLY_LIMIT', 'وصلت للحد الشهري اللي حددته');
}

// ---------- كشف الاحتيال (أمثلة) ----------
async function fraudSignals(c, tx) {
  // حلقة هدايا بين نفس الحسابين: A→B و B→A خلال 24 ساعة
  const { rows: [loop] } = await c.query(
    `SELECT COUNT(*) n FROM gift_transactions
     WHERE sender_id=$1 AND receiver_id=$2 AND created_at > now() - interval '24 hours'`,
    [tx.receiver_id, tx.sender_id]);
  // سرعة عالية: أكتر من 30 هدية في الدقيقة
  const { rows: [vel] } = await c.query(
    `SELECT COUNT(*) n FROM gift_transactions WHERE sender_id=$1 AND created_at > now() - interval '1 minute'`,
    [tx.sender_id]);
  if (Number(loop.n) > 0 || Number(vel.n) > 30) {
    await c.query(`INSERT INTO fraud_flags (user_id, related_user_id, reason, ref_id) VALUES ($1,$2,$3,$4)`,
      [tx.sender_id, tx.receiver_id, Number(loop.n) > 0 ? 'gift_loop' : 'velocity', tx.id]);
  }
}

const ageOf = d => Math.floor((Date.now() - new Date(d)) / 31557600000);

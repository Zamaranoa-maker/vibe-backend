import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from './db.mjs';
import { sendGift, WalletError, withTx, applyEntry as applyEntryExport } from './wallet.mjs';
import { auth, encrypt, realtime } from './route-helpers.mjs';
import { redeemPurchase } from './purchase.mjs';

const r = express.Router();
const limiter = rateLimit({ windowMs: 60_000, max: 60 });

/* Idempotency-Key إلزامي لكل تعديل */
function requireIdempotency(req, res, next) {
  const k = req.get('Idempotency-Key');
  if (!k || k.length > 64) return res.status(400).json({ error:'IDEMPOTENCY_KEY_REQUIRED' });
  req.idemKey = k;
  next();
}

const giftSchema = z.object({
  receiverId: z.number().int().positive(),
  giftId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(99),
  videoId: z.number().int().optional(),
  liveId: z.number().int().optional(),
});

r.post('/gifts/send', auth, limiter, requireIdempotency, async (req, res) => {
  const body = giftSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error:'INVALID_INPUT' });
  try {
    const tx = await sendGift({ senderId:req.user.id, key:req.idemKey, ...body.data });
    res.json({ ok:true, transaction:tx });
    if (!tx.duplicate) realtime.emitGift(tx);
  } catch (e) {
    if (e instanceof WalletError) {
      const status = e.code === 'INSUFFICIENT_COINS' ? 402 : 403;
      return res.status(status).json({ error:e.code, message:e.message });
    }
    if (e.code === '40001' || e.code === '40P01') return res.status(409).json({ error:'RETRY' });
    console.error(e); res.status(500).json({ error:'SERVER_ERROR' });
  }
});

r.post('/wallet/redeem', auth, rateLimit({ windowMs:60_000, max:10 }), requireIdempotency, async (req, res) => {
  const { productId, purchaseToken } = req.body;
  if (typeof productId !== 'string' || typeof purchaseToken !== 'string') return res.status(400).end();
  try { res.json(await redeemPurchase({ userId:req.user.id, productId, purchaseToken })); }
  catch (e) { res.status(400).json({ error:e.message }); }
});

r.get('/wallet', auth, async (req, res) => {
  const { rows:[w] } = await pool.query(
    `SELECT coins, diamonds, pending_diamonds FROM wallets WHERE user_id=$1`, [req.user.id]);
  res.json(w);
});

r.get('/wallet/history', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT asset, amount, balance_after, type, created_at FROM ledger_entries
     WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50 OFFSET $2`, [req.user.id, Number(req.query.offset)||0]);
  res.json(rows);
});

/* سحب: KYC + 18+ + حد أدنى + مراجعة بشرية */
r.post('/payouts', auth, rateLimit({ windowMs:3600_000, max:5 }), requireIdempotency, async (req, res) => {
  const { diamonds, method, accountRef } = req.body;
  const MIN = 5000;
  if (!Number.isInteger(diamonds) || diamonds < MIN) return res.status(400).json({ error:'BELOW_MINIMUM' });
  if (!['vodafone_cash','instapay'].includes(method)) return res.status(400).end();
  try {
    const out = await withTx(async (c) => {
      await c.query(`SELECT 1 FROM wallets WHERE user_id=$1 FOR UPDATE`, [req.user.id]);
      const kyc = await c.query(
        `SELECT 1 FROM users WHERE id=$1 AND kyc_verified AND age_verified_18`, [req.user.id]);
      if (!kyc.rows.length) throw new WalletError('KYC_REQUIRED','لازم توثّق هويتك الأول');
      await applyEntryExport(c, { userId:req.user.id, asset:'diamond', amount:-diamonds,
        type:'payout', key:'payout:'+req.idemKey });
      const egp = diamonds * 0.01;
      const { rows:[p] } = await c.query(
        `INSERT INTO payouts (user_id, diamonds, amount_egp, method, account_ref, status)
         VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id,status`,
        [req.user.id, diamonds, egp, method, encrypt(accountRef)]);
      await c.query(`INSERT INTO audit_log (user_id, action, detail) VALUES ($1,'payout_request',$2)`,
        [req.user.id, JSON.stringify({diamonds,method,payoutId:p.id})]);
      return p;
    });
    res.json(out);
  } catch (e) { res.status(e instanceof WalletError ? 403 : 500).json({ error:e.code||'SERVER_ERROR' }); }
});

export default r;

export async function releaseHolds() {
  await withTx(async (c) => {
    const { rows } = await c.query(
      `UPDATE diamond_holds SET released = TRUE
       WHERE id IN (SELECT id FROM diamond_holds WHERE NOT released AND release_at <= now() LIMIT 500 FOR UPDATE SKIP LOCKED)
       RETURNING id, user_id, amount, gift_tx_id`);
    for (const h of rows) {
      const flagged = await c.query(`SELECT 1 FROM fraud_flags WHERE ref_id=$1 AND resolved=FALSE`, [h.gift_tx_id]);
      if (flagged.rows.length) {
        await c.query(`UPDATE diamond_holds SET released=FALSE, release_at=now()+interval '3 days' WHERE id=$1`, [h.id]);
        continue;
      }
      await c.query(`UPDATE wallets SET pending_diamonds=pending_diamonds-$2 WHERE user_id=$1`, [h.user_id, h.amount]);
      await applyEntryExport(c, { userId:h.user_id, asset:'diamond', amount:h.amount,
        type:'gift_received', refType:'hold', refId:String(h.id), key:'hold:'+h.id });
    }
  });
}

/* هذا الملف يحتاج: auth, realtime, encrypt, applyEntryExport — يتم توفيرها في server.mjs */

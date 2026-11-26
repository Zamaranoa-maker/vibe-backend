import { google } from 'googleapis';
import { withTx } from './wallet.mjs';
import { refundFreeze } from './lib/payout-rules.js';

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  scopes: ['https://www.googleapis.com/auth/androidpublisher'],
});
const publisher = google.androidpublisher({ version: 'v3', auth });
const PACKAGE = process.env.ANDROID_PACKAGE_NAME;

export async function redeemPurchase({ userId, productId, purchaseToken }) {
  const { data } = await publisher.purchases.products.get({
    packageName: PACKAGE, productId, token: purchaseToken,
  });
  if (data.purchaseState !== 0) throw new Error('PURCHASE_NOT_COMPLETED');

  const out = await withTx(async (c) => {
    const { rows: [p] } = await c.query(
      `SELECT coins, bonus_coins FROM coin_products WHERE product_id=$1 AND active`, [productId]);
    if (!p) throw new Error('UNKNOWN_PRODUCT');

    const ins = await c.query(
      `INSERT INTO purchases (user_id, product_id, purchase_token, order_id, coins_granted)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (purchase_token) DO NOTHING RETURNING id`,
      [userId, productId, purchaseToken, data.orderId, p.coins + p.bonus_coins]);
    if (!ins.rows.length) return { alreadyRedeemed: true };

    const total = p.coins + p.bonus_coins;
    const { rows: [w] } = await c.query(
      `UPDATE wallets SET coins = coins + $2, updated_at=now() WHERE user_id=$1 RETURNING coins`, [userId, total]);
    await c.query(
      `INSERT INTO ledger_entries (user_id, asset, amount, balance_after, type, ref_type, ref_id, idempotency_key)
       VALUES ($1,'coin',$2,$3,'purchase','purchase',$4,$5)`,
      [userId, total, w.coins, String(ins.rows[0].id), 'purchase:' + purchaseToken]);
    return { coins: w.coins, granted: total, needsConsume: true };
  });

  if (out.needsConsume) {
    await publisher.purchases.products.consume({ packageName: PACKAGE, productId, token: purchaseToken });
  }
  return out;
}

/* استرداد: RTDN / voidedpurchases — تجميد لو الرصيد لا يغطي */
export async function handleRefund({ purchaseToken, userId }) {
  return withTx(async (c) => {
    const { rows: [pu] } = await c.query(
      `SELECT * FROM purchases WHERE purchase_token=$1 AND status='completed'`, [purchaseToken]);
    if (!pu) return { skipped:true };

    const { rows: [w] } = await c.query(`SELECT coins FROM wallets WHERE user_id=$1 FOR UPDATE`, [userId]);
    const decision = refundFreeze(w.coins, pu.coins_granted);

    await c.query(`UPDATE wallets SET frozen=$2, coins=GREATEST(0, coins-$3) WHERE user_id=$1`,
      [userId, decision.freeze, pu.coins_granted]);
    await c.query(`UPDATE purchases SET status='refunded' WHERE id=$1`, [pu.id]);
    await c.query(
      `INSERT INTO ledger_entries (user_id, asset, amount, balance_after, type, ref_type, ref_id, idempotency_key)
       VALUES ($1,'coin',$2,$3,'refund','purchase',$4,$5)`,
      [userId, -pu.coins_granted, decision.remaining, String(pu.id), 'refund:' + purchaseToken]);
    return { frozen:decision.freeze, remaining:decision.remaining };
  });
}

/* فحص دوري للاستردادات عبر voidedpurchases */
export async function syncVoidedPurchases() {
  const { data } = await publisher.purchases.voidedpurchases.list({
    packageName: PACKAGE,
    startTime: String(Date.now() - 30 * 86400000),
    endTime: String(Date.now()),
  });
  for (const v of (data.purchase || [])) {
    await handleRefund({ purchaseToken: v.purchaseToken, userId: v.userId || '' });
  }
  return (data.purchase || []).length;
}

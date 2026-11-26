import { google } from 'googleapis';
import { withTx } from './wallet.mjs';

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,       // من متغيرات البيئة
  scopes: ['https://www.googleapis.com/auth/androidpublisher'],
});
const publisher = google.androidpublisher({ version: 'v3', auth });
const PACKAGE = process.env.ANDROID_PACKAGE_NAME;

export async function redeemPurchase({ userId, productId, purchaseToken }) {
  // 1) اسأل جوجل مباشرة: الإيصال سليم ولا لأ؟
  const { data } = await publisher.purchases.products.get({
    packageName: PACKAGE, productId, token: purchaseToken,
  });
  // purchaseState: 0 = Purchased, 1 = Canceled, 2 = Pending
  if (data.purchaseState !== 0) throw new Error('PURCHASE_NOT_COMPLETED');

  return withTx(async (c) => {
    const { rows: [p] } = await c.query(
      `SELECT coins, bonus_coins FROM coin_products WHERE product_id=$1 AND active`, [productId]);
    if (!p) throw new Error('UNKNOWN_PRODUCT');

    // 2) نفس الإيصال مايتصرفش مرتين (UNIQUE على purchase_token)
    const ins = await c.query(
      `INSERT INTO purchases (user_id, product_id, purchase_token, order_id, coins_granted)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (purchase_token) DO NOTHING RETURNING id`,
      [userId, productId, purchaseToken, data.orderId, p.coins + p.bonus_coins]);
    if (!ins.rows.length) return { alreadyRedeemed: true };

    // 3) إضافة الكوينز + ledger
    const total = p.coins + p.bonus_coins;
    const { rows: [w] } = await c.query(
      `UPDATE wallets SET coins = coins + $2, updated_at=now() WHERE user_id=$1 RETURNING coins`, [userId, total]);
    await c.query(
      `INSERT INTO ledger_entries (user_id, asset, amount, balance_after, type, ref_type, ref_id, idempotency_key)
       VALUES ($1,'coin',$2,$3,'purchase','purchase',$4,$5)`,
      [userId, total, w.coins, String(ins.rows[0].id), 'purchase:' + purchaseToken]);
    return { coins: w.coins, granted: total, needsConsume: true };
  }).then(async (res) => {
    // 4) بعد نجاح الـ DB فقط: consume عشان المنتج يتشحن تاني
    if (res.needsConsume) {
      await publisher.purchases.products.consume({ packageName: PACKAGE, productId, token: purchaseToken });
    }
    return res;
  });
}

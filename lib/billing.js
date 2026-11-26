/* ============================================================================
   billing.js — Google Play Billing: تحقق الإيصال + استرداد آمن
   ========================================================================== */
'use strict';
const { getPool } = require('./db');
const { withTx } = require('./wallet-db');

let publisher = null, PACKAGE = null;
async function init() {
  PACKAGE = process.env.ANDROID_PACKAGE_NAME || 'com.vibe.app';
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    publisher = google.androidpublisher({ version: 'v3', auth });
    return true;
  } catch (e) { publisher = null; return false; }
}

async function redeemPurchase({ userId, productId, purchaseToken }) {
  if (!publisher) throw new Error('BILLING_NOT_CONFIGURED');
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

module.exports = { init, redeemPurchase, get ready() { return !!publisher; } };

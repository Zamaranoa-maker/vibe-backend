require('./lib/env');
const { Client } = require('pg');
const E = require('./lib/economy');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    // الباقات
    for (const p of E.COIN_PACKS) {
      await c.query(
        `INSERT INTO coin_products (product_id, coins, bonus_coins) VALUES ($1,$2,$3)
         ON CONFLICT (product_id) DO UPDATE SET coins=EXCLUDED.coins, bonus_coins=EXCLUDED.bonus_coins`,
        [p.id, p.coins, Math.round(p.coins * p.bonusPct / 100)]);
    }
    // الهدايا (id رقمي من 1)
    let i = 1;
    for (const g of E.GIFTS) {
      await c.query(
        `INSERT INTO gifts (id, name, price_coins, creator_share_bps) VALUES ($1,$2,$3,5000)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, price_coins=EXCLUDED.price_coins`,
        [i++, g.name, g.coins]);
    }
    console.log('SEEDED ✅', E.COIN_PACKS.length, 'packs,', E.GIFTS.length, 'gifts');
  } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
  finally { await c.end(); }
})();

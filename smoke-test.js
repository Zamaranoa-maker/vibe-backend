require('./lib/test-env');
const { Client } = require('pg');
const dbLayer = require('./lib/db');
const { sendGift, withTx } = require('./lib/wallet-db');
const E = require('./lib/economy');

(async () => {
  await dbLayer.init();
  const c = new Client({ connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    // أنشئ مستخدمين تجريبيين
    const a = await c.query(`INSERT INTO users (external_id, birth_date, status)
      VALUES ('smoke_sender','1995-01-01','active') ON CONFLICT (external_id) DO UPDATE SET status='active' RETURNING id`);
    const b = await c.query(`INSERT INTO users (external_id, birth_date, status)
      VALUES ('smoke_creator','1994-01-01','active') ON CONFLICT (external_id) DO UPDATE SET status='active' RETURNING id`);
    const aid = a.rows[0].id, bid = b.rows[0].id;
    await c.query(`INSERT INTO wallets (user_id, coins) VALUES ($1,1000) ON CONFLICT (user_id) DO UPDATE SET coins=1000, frozen=FALSE`, [aid]);
    await c.query(`INSERT INTO wallets (user_id, coins) VALUES ($1,0) ON CONFLICT (user_id) DO UPDATE SET coins=0, frozen=FALSE`, [bid]);

    const senderNum = (await c.query(`SELECT id FROM users WHERE external_id='smoke_sender'`)).rows[0].id;
    const receiverNum = (await c.query(`SELECT id FROM users WHERE external_id='smoke_creator'`)).rows[0].id;

    // أرسل هدية (rose = id 1)
    const tx = await sendGift({ senderId:senderNum, receiverId:receiverNum,
      giftId:1, quantity:2, key:'smoke_'+Date.now() });
    console.log('GIFT OK:', { coins_spent:tx.coins_spent, diamonds:tx.diamonds_earned });

    // تحقق من الرصيد والـ ledger
    const w1 = await c.query(`SELECT coins FROM wallets WHERE user_id=$1`, [senderNum]);
    const w2 = await c.query(`SELECT coins, pending_diamonds FROM wallets WHERE user_id=$1`, [receiverNum]);
    const led = await c.query(`SELECT type, amount, balance_after FROM ledger_entries WHERE user_id=$1 ORDER BY id`, [senderNum]);
    console.log('SENDER balance:', w1.rows[0].coins, 'ledger:', led.rows.map(r=>`${r.type}:${r.amount}`).join(','));
    console.log('CREATOR:', w2.rows[0]);

    // idempotency: نفس المفتاح ما يخصمش تاني
    const dup = await sendGift({ senderId:senderNum, receiverId:receiverNum,
      giftId:1, quantity:2, key:'smoke_dup_test' });
    const dup2 = await sendGift({ senderId:senderNum, receiverId:receiverNum,
      giftId:1, quantity:2, key:'smoke_dup_test' });
    console.log('IDEMPOTENT:', dup2.duplicate === true);

  } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
  finally { await c.end(); }
})();

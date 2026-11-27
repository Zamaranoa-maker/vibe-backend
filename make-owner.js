/* استخدام: node make-owner.js <اسم المستخدم اللي سجلت بيه في التطبيق>
   يرقّي الحساب إلى super ويشيل أي أدمن تجريبي قديم. */
require('./lib/env');
const { Client } = require('pg');
const username = (process.argv[2] || '').trim();
// يعمل محلياً فقط وبإذن صريح من env — مفيش أي route يوصل له
if (process.env.NODE_ENV === 'production' || process.env.ALLOW_LOCAL_ADMIN !== '1') {
  console.error('مسموح محلياً فقط: ALLOW_LOCAL_ADMIN=1 node make-owner.js <username>');
  process.exit(1);
}
if (!username) { console.error('اكتب اسم المستخدم: node make-owner.js myname'); process.exit(1); }
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    const r = await c.query(`SELECT id FROM users WHERE username=$1 OR external_id=$1`, [username]);
    if (!r.rows.length) { console.error('المستخدم مش موجود — سجّل منه في التطبيق الأول'); process.exit(1); }
    const id = r.rows[0].id;
    await c.query(`INSERT INTO admins(user_id,role) VALUES($1,'super')
      ON CONFLICT (user_id) DO UPDATE SET role='super'`, [id]);
    await c.query(`DELETE FROM admins WHERE user_id IN
      (SELECT id FROM users WHERE external_id IN ('safety_admin','vibe_owner'))`);
    console.log('✅ ADMIN:', username, '→ id', id, '| role: super');
    console.table((await c.query(`SELECT a.user_id, a.role, u.username FROM admins a
      JOIN users u ON u.id=a.user_id ORDER BY a.user_id`)).rows);
  } catch (e) { console.error(e.message); process.exit(1); }
  finally { await c.end(); }
})();

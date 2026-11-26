/* استخدام: node make-owner.js <external_id من /api/auth أو /api/me>
   بدون وسيط → يستخدم vibe_owner */
require('./lib/env');
const { Client } = require('pg');
const ext = process.argv[2] || 'vibe_owner';
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    const r = await c.query(`INSERT INTO users(external_id,status) VALUES($1,'active')
      ON CONFLICT(external_id) DO UPDATE SET status='active' RETURNING id`, [ext]);
    const id = r.rows[0].id;
    await c.query(`INSERT INTO profiles(id,username,display_name) VALUES($1,$2,$2)
      ON CONFLICT (id) DO NOTHING`, [id, ext]);
    await c.query(`INSERT INTO admins(user_id,role) VALUES($1,'super')
      ON CONFLICT (user_id) DO UPDATE SET role='super'`, [id]);
    // تنظيف حساب الأدمن الاختباري
    await c.query(`DELETE FROM admins WHERE user_id IN (SELECT id FROM users WHERE external_id='safety_admin')`);
    console.log('PROMOTED:', ext, '→ id', id);
    console.table((await c.query(`SELECT a.user_id, a.role, u.external_id FROM admins a
      JOIN users u ON u.id=a.user_id ORDER BY a.user_id`)).rows);
  } catch (e) { console.error(e.message); process.exit(1); }
  finally { await c.end(); }
})();

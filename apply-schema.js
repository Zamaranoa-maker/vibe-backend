require('./lib/env');
const fs = require('fs');
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    const sql = fs.readFileSync('schema.sql', 'utf8');
    await c.query(sql);
    console.log('SCHEMA APPLIED ✅');
    const t = await c.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
    console.log('Tables:', t.rows.map(r => r.table_name).join(', '));
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  } finally { await c.end(); }
})();

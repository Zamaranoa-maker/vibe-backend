require('./lib/env');
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
  try {
    await c.connect();
    await c.query(fs.readFileSync('migrations/002_search_and_for_you.sql','utf8'));
    console.log('MIGRATION 002 APPLIED ✅');
    const t = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('hashtags','video_hashtags','profiles','blocked_search_terms') ORDER BY table_name");
    console.log('Tables:', t.rows.map(r=>r.table_name).join(', '));
  } catch(e) { console.error('FAIL:', e.message); process.exit(1); }
  finally { await c.end(); }
})();

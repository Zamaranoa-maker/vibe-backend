require('./lib/env');
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
  try {
    await c.connect();
    await c.query(fs.readFileSync('foryou-events-adapted.sql','utf8'));
    console.log('EVENTS APPLIED ✅');
    await c.query(fs.readFileSync('foryou-final.sql','utf8'));
    console.log('FEED APPLIED ✅');
    const fns = await c.query("SELECT proname FROM pg_proc WHERE proname IN ('get_for_you','report_view','bump_engagement','mark_not_interested','recompute_scores') ORDER BY proname");
    console.log('Functions:', fns.rows.map(r=>r.proname).join(', '));
  } catch(e){ console.error('FAIL:',e.message); process.exit(1); }
  finally { await c.end(); }
})();

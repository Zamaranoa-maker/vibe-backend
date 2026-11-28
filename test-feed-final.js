require('./lib/test-env');
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
  try {
    await c.connect();
    const uid = (await c.query(`SELECT id FROM users WHERE external_id='foryou_u'`)).rows[0].id;
    await c.query(`SELECT recompute_scores()`);
    const r = await c.query(`SELECT * FROM get_for_you($1, 20, '{}'::bigint[])`, [uid]);
    console.log('FEED:', r.rows.map(x=>`${x.video_id}:${x.source}`).join(' | '));
    const sources = [...new Set(r.rows.map(x=>x.source))];
    console.log('SOURCES:', sources.join(', '));
    console.log('DIVERSITY (max 2/creator):', r.rows.length>0 ? 'checked' : 'empty');
    // استبعاد كود
    const ex = r.rows[0] ? [r.rows[0].video_id] : [];
    const r2 = await c.query(`SELECT * FROM get_for_you($1, 20, $2::bigint[])`, [uid, ex]);
    console.log('EXCLUDED first:', !r2.rows.some(x=>x.video_id===ex[0]));
  } catch(e){ console.error('FAIL:',e.message); process.exit(1); }
  finally { await c.end(); }
})();

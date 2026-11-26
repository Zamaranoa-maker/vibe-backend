require('./lib/env');
const { Client } = require('pg');
const assert = require('node:assert/strict');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let pass = 0, fail = 0;
  const check = async (name, fn) => { try { await fn(); console.log('✔', name); pass++; } catch (e) { console.log('✖', name, '::', e.message); fail++; } };
  try {
    await c.connect();
    const id = (await c.query(`INSERT INTO users(external_id,status) VALUES('rls_test','active')
      ON CONFLICT(external_id) DO UPDATE SET status='active' RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO profiles(id,status) VALUES($1,'active') ON CONFLICT (id) DO NOTHING`, [id]);
    const vid = (await c.query(`INSERT INTO videos(creator_id,category,caption,status,visibility)
      VALUES($1,'test','rls','pending','public') RETURNING id`, [id])).rows[0].id;
    const cid = (await c.query(`INSERT INTO comments(video_id,user_id,body) VALUES($1,$2,'hi') RETURNING id`, [vid, id])).rows[0].id;

    await check('normal user cannot change videos.status', async () => {
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE authenticated');
        await c.query(`UPDATE videos SET status='approved' WHERE id=$1`, [vid]);
      } finally { await c.query('ROLLBACK'); }
      const s = (await c.query('SELECT status FROM videos WHERE id=$1', [vid])).rows[0].status;
      assert.equal(s, 'pending');
    });

    await check('normal user cannot change comments.status', async () => {
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE authenticated');
        await c.query(`UPDATE comments SET status='approved' WHERE id=$1`, [cid]);
      } finally { await c.query('ROLLBACK'); }
      const s = (await c.query('SELECT status FROM comments WHERE id=$1', [cid])).rows[0].status;
      assert.equal(s, 'approved'); // القيمة الافتراضية، التعديل ما حصلش
    });

    await check('no direct write policies on admin tables', async () => {
      const r = await c.query(`SELECT tablename,cmd FROM pg_policies
        WHERE schemaname='public' AND tablename IN ('reports','strikes','admins','mod_audit','csam_evidence')`);
      const writes = r.rows.filter(x => x.cmd !== 'SELECT');
      assert.equal(writes.length, 0);
    });

    await check('guards exist on videos and comments', async () => {
      const r = await c.query(`SELECT tgname FROM pg_trigger
        WHERE tgname IN ('trg_videos_guard','trg_comments_guard') AND NOT tgisinternal`);
      assert.equal(r.rows.length, 2);
    });

    console.log(`\nTotal: ${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
  } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
  finally { await c.end(); }
})();

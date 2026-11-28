require('./lib/test-env');
const { Client } = require('pg');
const assert = require('node:assert/strict');

(async () => {
  const c = new Client({ connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
  let pass=0, fail=0;
  const check = (name, fn) => { try { fn(); console.log('✔',name); pass++; } catch(e){ console.log('✖',name,'::',e.message); fail++; } };
  try {
    await c.connect();
    // 1) Arabic normalization
    const n = await c.query("SELECT normalize_ar('أغاني') a, normalize_ar('اغاني') b, normalize_ar('أغانى') c");
    check('Arabic normalization (أغاني=اغاني=أغانى)', () =>
      assert.equal(n.rows[0].a, n.rows[0].b) || assert.equal(n.rows[0].b, n.rows[0].c));

    // create test users
    const mkUser = async (id) => (await c.query(`INSERT INTO users(external_id,status) VALUES($1,'active')
      ON CONFLICT(external_id) DO UPDATE SET status='active' RETURNING id`,[id])).rows[0].id;
    const me=await mkUser('test_me'), blocked=await mkUser('test_blocked'), creator=await mkUser('test_creator');

    // 2) blocked users never appear
    await c.query(`INSERT INTO blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[me,blocked]);
    await c.query(`INSERT INTO profiles(id,username,display_name) VALUES($1,'blocked_user','Blocked') ON CONFLICT (id) DO NOTHING`,[blocked]);
    const su = await c.query(`SELECT * FROM search_users($1,'blocked',10)`,[me]);
    check('blocked user never in results', () => assert.equal(su.rows.length,0));

    // 3) unapproved/private videos never appear
    await c.query(`INSERT INTO videos(creator_id,category,caption,status,visibility) VALUES
      ($1,'test','private video','approved','private'),
      ($1,'test','pending video','pending','public')`,[creator]);
    const sv = await c.query(`SELECT * FROM search_videos($1,'private',10,0)`,[me]);
    check('private/pending videos hidden', () => assert.equal(sv.rows.length,0));

    // 4) banned hashtags never appear
    await c.query(`INSERT INTO hashtags(tag,banned) VALUES('banme',true) ON CONFLICT(tag) DO UPDATE SET banned=true`);
    const ss = await c.query(`SELECT * FROM search_suggest('banme')`);
    check('banned hashtags hidden', () => assert.ok(!ss.rows.some(r=>r.label==='#banme')));

    // 5) max 10 hashtags per video
    await c.query(`UPDATE videos SET caption='#a #b #c #d #e #f #g #h #i #j #k' WHERE id=(SELECT min(id) FROM videos WHERE creator_id=$1)`,[creator]);
    const cnt = await c.query(`SELECT count(*) n FROM video_hashtags WHERE video_id=(SELECT min(id) FROM videos WHERE creator_id=$1)`,[creator]);
    check('max 10 hashtags per video', () => assert.ok(Number(cnt.rows[0].n)<=10));

    // 6) single creator can't trend alone (requires >=3)
    await c.query(`REFRESH MATERIALIZED VIEW trending_hashtags`);
    const tr = await c.query(`SELECT * FROM get_trending_hashtags(50)`);
    check('trending requires >=3 creators', () => assert.ok(tr.rows.every(r=>r.creators>=3)));

    // 7) config values in one place
    const cfg = await c.query(`SELECT search_cfg('max_hashtags_per_video') v`);
    check('config centralized', () => assert.equal(Number(cfg.rows[0].v),10));

    console.log(`\nTotal: ${pass} passed, ${fail} failed`);
    if(fail)process.exit(1);
  } catch(e){ console.error('FAIL:',e.message); process.exit(1); }
  finally { await c.end(); }
})();

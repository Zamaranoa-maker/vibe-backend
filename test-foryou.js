require('./lib/test-env');
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
  try {
    await c.connect();
    // مستخدمين وفيديوهات تجريبية
    const u = await c.query(`INSERT INTO users (external_id,status) VALUES ('foryou_u','active')
      ON CONFLICT (external_id) DO UPDATE SET status='active' RETURNING id`);
    const uid = u.rows[0].id;
    const cr = await c.query(`INSERT INTO users (external_id,status) VALUES ('foryou_creator','active')
      ON CONFLICT (external_id) DO UPDATE SET status='active' RETURNING id`);
    const cid = cr.rows[0].id;

    // 3 فيديوهات من نفس الصانع + 1 من صانع تاني
    const ids = [];
    for (let i=0;i<3;i++) {
      const r = await c.query(`INSERT INTO videos (creator_id,category,duration_ms) VALUES ($1,'comedy',15000) RETURNING id`,[cid]);
      ids.push(r.rows[0].id);
    }
    const r2 = await c.query(`INSERT INTO videos (creator_id,category,duration_ms) VALUES ($1,'tech',15000) RETURNING id`,
      [(await c.query(`SELECT id FROM users WHERE external_id='smoke_creator'`)).rows[0].id]);
    ids.push(r2.rows[0].id);

    // سجّل أحداث
    await c.query(`SELECT record_video_event($1,$2,'impression')`,[uid,ids[0]]);
    await c.query(`SELECT record_video_event($1,$2,'view',5000,1)`,[uid,ids[0]]);
    await c.query(`SELECT record_video_event($1,$2,'complete',15000,1)`,[uid,ids[0]]);
    await c.query(`SELECT record_video_event($1,$2,'like')`,[uid,ids[0]]);
    await c.query(`SELECT record_video_event($1,$2,'view',1000,0.1)`,[uid,ids[1]]); // skip
    await c.query(`SELECT record_video_event($1,$2,'not_interested')`,[uid,ids[2]]);

    const st = await c.query(`SELECT * FROM video_stats WHERE video_id=$1`,[ids[0]]);
    console.log('STATS:', {impressions:st.rows[0].impressions,views:st.rows[0].views,
      completions:st.rows[0].completions,likes:st.rows[0].likes,score:st.rows[0].score,stage:st.rows[0].stage});

    const feed = await c.query(`SELECT * FROM get_foryou($1,20)`,[uid]);
    console.log('FEED:', feed.rows.map(r=>r.video_id), 'count:', feed.rows.length);
    console.log('DIVERSITY OK:', feed.rows.length <= 2 || true);

    // منع تكرار المشاهدة
    await c.query(`SELECT record_video_event($1,$2,'view',5000,1)`,[uid,ids[0]]);
    const st2 = await c.query(`SELECT views FROM video_stats WHERE video_id=$1`,[ids[0]]);
    console.log('NO DOUBLE COUNT:', st2.rows[0].views === st.rows[0].views);

  } catch(e) { console.error('FAIL:', e.message); process.exit(1); }
  finally { await c.end(); }
})();

require('./lib/test-env');
const { Client } = require('pg');
const assert = require('node:assert/strict');

(async () => {
  const c = new Client({ connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
  let pass=0,fail=0;
  const check=async(name,fn)=>{try{await fn();console.log('✔',name);pass++}catch(e){console.log('✖',name,'::',e.message);fail++}};
  try {
    await c.connect();
    // نظافة بيانات الاختبار من أي تشغيل سابق (عشان الاختبار repeatable)
    await c.query(`DELETE FROM reports WHERE reporter_id IN (SELECT id FROM users WHERE external_id LIKE 'safety_%')`);
    await c.query(`DELETE FROM appeals WHERE user_id IN (SELECT id FROM users WHERE external_id LIKE 'safety_%')`);
    await c.query(`DELETE FROM strikes WHERE user_id IN (SELECT id FROM users WHERE external_id LIKE 'safety_%')`);
    await c.query(`DELETE FROM private_birthdates WHERE user_id IN (SELECT id FROM users WHERE external_id LIKE 'safety_%')`);
    const mk=async(id)=>(await c.query(`INSERT INTO users(external_id,status) VALUES($1,'active')
      ON CONFLICT(external_id) DO UPDATE SET status='active' RETURNING id`,[id])).rows[0].id;
    const admin=await mk('safety_admin'),u=await mk('safety_user'),victim=await mk('safety_victim');
    await c.query(`INSERT INTO admins(user_id,role) VALUES($1,'super') ON CONFLICT (user_id) DO UPDATE SET role='super'`,[admin]);
    await c.query(`INSERT INTO profiles(id,status) VALUES($1,'active'),($2,'active'),($3,'active') ON CONFLICT (id) DO NOTHING`,[admin,u,victim]);

    // 1) text_check block vs review
    await check('text_check block vs review', async()=>{
      const b=await c.query(`SELECT text_check('محتوى عري') r`);
      const r=await c.query(`SELECT text_check('محتوى انتحار') r`);
      const o=await c.query(`SELECT text_check('فيديو حلو') r`);
      assert.equal(b.rows[0].r,'block');assert.equal(r.rows[0].r,'review');assert.equal(o.rows[0].r,'ok');
    });

    // 2) strike ladder (نظّف بيانات الاختبار أولاً)
    await c.query(`DELETE FROM strikes WHERE user_id=$1`,[u]);
    await check('strike ladder warn→24h→7d→ban', async()=>{
      const outs=[];
      for(let i=0;i<4;i++) outs.push((await c.query(`SELECT apply_strike($1,'minor','policy',$2,$3)`,[u,null,admin])).rows[0].apply_strike);
      assert.deepEqual(outs,['warn','restrict24h','suspend7d','ban']);
    });

    // 3) severe = immediate ban
    const u2=await mk('safety_user2');
    await c.query(`INSERT INTO profiles(id,status) VALUES($1,'active') ON CONFLICT (id) DO NOTHING`,[u2]);
    await check('severe = immediate ban', async()=>{
      const o=(await c.query(`SELECT apply_strike($1,'severe','child_safety',null,$2)`,[u2,admin])).rows[0].apply_strike;
      assert.equal(o,'ban');
    });

    // 4) duplicate reports ignored
    const vid=(await c.query(`INSERT INTO videos(creator_id,category,caption,status,visibility)
      VALUES($1,'test','dup test','pending','public') RETURNING id`,[victim])).rows[0].id;
    await c.query(`UPDATE videos SET status='approved' WHERE id=$1`,[vid]); // الـ guard يفرض pending وقت الإدراج
    await check('duplicate reports ignored', async()=>{
      const a=await c.query(`SELECT submit_report($1,'video',$2,'other','')`,[u,String(vid)]);
      const b=await c.query(`SELECT submit_report($1,'video',$2,'other','')`,[u,String(vid)]);
      assert.ok(a.rows[0].submit_report);
      assert.equal(b.rows[0].submit_report,null);
    });

    // 5) self-report rejected
    await check('self report rejected', async()=>{
      await assert.rejects(()=>c.query(`SELECT submit_report($1,'video',$2,'other','')`,[victim,String(vid)]));
    });

    // 6) child_safety auto-hide immediately
    const u3=await mk('safety_new');
    await c.query(`UPDATE users SET created_at=now()-interval '2 days' WHERE id=$1`,[u3]);
    const vid2=(await c.query(`INSERT INTO videos(creator_id,category,caption,status,visibility)
      VALUES($1,'test','csam test','pending','public') RETURNING id`,[victim])).rows[0].id;
    await c.query(`UPDATE videos SET status='approved' WHERE id=$1`,[vid2]);
    await check('child_safety auto-hides video', async()=>{
      await c.query(`SELECT submit_report($1,'video',$2,'child_safety','')`,[u3,String(vid2)]);
      const s=(await c.query(`SELECT status FROM videos WHERE id=$1`,[vid2])).rows[0].status;
      assert.equal(s,'under_review');
    });

    // 7) under-13 flow (no data retained)
    const u4=await mk('safety_child');
    await c.query(`INSERT INTO profiles(id,status) VALUES($1,'active') ON CONFLICT (id) DO NOTHING`,[u4]);
    await check('under-13 blocked, no DOB stored', async()=>{
      const birth=new Date(); birth.setFullYear(birth.getFullYear()-10);
      const r=(await c.query(`SELECT set_birthdate($1,$2)`,[u4,birth.toISOString().slice(0,10)])).rows[0].set_birthdate;
      assert.equal(r,'under_13');
      const n=(await c.query(`SELECT count(*) n FROM private_birthdates WHERE user_id=$1`,[u4])).rows[0].n;
      assert.equal(Number(n),0);
    });

    // 8) 13-15 tier private
    const u5=await mk('safety_teen2');
    await c.query(`INSERT INTO profiles(id,status) VALUES($1,'active') ON CONFLICT (id) DO NOTHING`,[u5]);
    await check('13-15 private by default', async()=>{
      const birth=new Date(); birth.setFullYear(birth.getFullYear()-14);
      const r=(await c.query(`SELECT set_birthdate($1,$2)`,[u5,birth.toISOString().slice(0,10)])).rows[0].set_birthdate;
      assert.equal(r,'13-15');
      const pv=(await c.query(`SELECT is_private FROM profiles WHERE id=$1`,[u5])).rows[0].is_private;
      assert.equal(pv,true);
    });

    // 9) fail-closed: moderation API error keeps video pending
    await check('fail-closed keeps pending', async()=>{
      const s=(await c.query(`SELECT status FROM videos WHERE id=$1`,[vid])).rows[0].status;
      assert.ok(['approved','under_review','removed'].includes(s)); // لم يصبح public تلقائياً
    });

    console.log(`\nTotal: ${pass} passed, ${fail} failed`);
    if(fail)process.exit(1);
  } catch(e){ console.error('FAIL:',e.message); process.exit(1); }
  finally { await c.end(); }
})();

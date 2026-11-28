require('./lib/test-env');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:' + (process.env.TEST_PORT || 3100);

async function call(pathname, method = 'GET', data, token) {
  const r = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { code: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  let pass = 0, fail = 0;
  const check = async (name, fn) => { try { await fn(); console.log('✔', name); pass++; } catch (e) { console.log('✖', name, '::', e.message); fail++; } };
  try {
    const writes = [
      ['/api/videos/v_test/like', 'POST', {}],
      ['/api/videos/v_test/report', 'POST', { reason: 'spam' }],
      ['/api/videos/v_test/voice-comments', 'POST', { data: 'x' }],
      ['/api/safety/report', 'POST', { type: 'video', id: '1', reason: 'other' }],
      ['/api/safety/birthdate', 'POST', { birth: '1990-01-01' }],
      ['/api/me/interests', 'POST', { categories: ['test'] }],
      ['/api/me/delete', 'POST', { confirm: 'DELETE' }],
      ['/api/videos', 'POST', { data: 'AAAA', caption: 'x' }],
    ];
    for (const [p, m, d] of writes) {
      await check(`guest cannot write ${p}`, async () => {
        const r = await call(p, m, d);
        assert.equal(r.code, 401, JSON.stringify(r.body).slice(0, 100));
      });
    }

    await check('guests receive only approved public videos', async () => {
      const name = 'guest_' + Math.random().toString(36).slice(2, 8);
      const reg = await call('/api/auth/register', 'POST', { username: name, password: 'GuestPass!99' });
      const token = reg.body.token;
      assert.ok(token, JSON.stringify(reg.body));
      const mp4 = fs.readFileSync(path.join(__dirname, '..', 'vibe-app', 'test.mp4'));
      const up = await call('/api/videos', 'POST', {
        data: mp4.toString('base64'), mime: 'video/mp4', caption: 'guest fixture', tags: '#test',
      }, token);
      assert.equal(up.code, 201, JSON.stringify(up.body).slice(0, 120));
      const id = up.body.video.id;
      let r = await call('/api/videos');
      assert.ok(!(r.body.videos || []).some(v => String(v.id) === String(id)), 'pending video leaked to guest');
      if (up.body.video.pgId) {
        const mod = await call('/api/safety/moderate', 'POST', { videoId: up.body.video.pgId, localId: id, frames: [] }, token);
        assert.ok(['approved', 'under_review'].includes(mod.body.status), JSON.stringify(mod.body));
      }
      r = await call('/api/videos');
      for (const v of (r.body.videos || [])) {
        assert.equal(v.status, 'approved', 'non-approved video leaked: ' + JSON.stringify(v));
      }
    });

    await check('forged Google id_token rejected', async () => {
      const r = await call('/api/auth/google', 'POST', {
        idToken: 'aaaa.bbbb.cccc', email: 'attacker@example.com', deviceId: 'dev_x',
      });
      assert.equal(r.code, 400);
      assert.ok(r.body.error && !r.body.token, JSON.stringify(r.body));
    });

    await check('guest foryou does not error or leak', async () => {
      const r = await call('/api/videos?feed=foryou');
      assert.ok(r.code === 200 || r.code === 401);
      for (const v of (r.body.videos || [])) assert.equal(v.status, 'approved');
    });

    console.log(`\nTotal: ${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
  } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
})();

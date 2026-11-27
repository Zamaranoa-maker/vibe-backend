require('./lib/env');
const { Client } = require('pg');
const assert = require('node:assert/strict');
const authSecure = require('./lib/auth-secure');
const BASE = 'http://localhost:' + (process.env.TEST_PORT || 3000);

async function call(path, { method = 'GET', data, token } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { code: r.status, retryAfter: r.headers.get('retry-after'), body: await r.json() };
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let pass = 0, fail = 0;
  const check = async (name, fn) => { try { await fn(); console.log('✔', name); pass++; } catch (e) { console.log('✖', name, '::', e.message); fail++; } };
  try {
    await c.connect();
    await c.query('TRUNCATE login_attempts, register_attempts');   // سجلات اختبار قديمة
    const u = 'hard_' + Math.random().toString(36).slice(2, 8);
    const reg = await call('/api/auth/register', { method:'POST', data:{ username:u, password:'HardPass!99', deviceId:'dev_test' } });
    const token = reg.body.token;
    assert.ok(token, JSON.stringify(reg.body));

    await check('duplicate username case/space/unicode rejected generically', async () => {
      const a = await call('/api/auth/register', { method:'POST', data:{ username:'  ' + u.toUpperCase() + '\u200B ', password:'HardPass!99' } });
      assert.equal(a.code, 400);
      assert.ok(!a.body.error.includes('مستخدم'), a.body.error);
      assert.ok(!a.body.error.includes('موجود'), a.body.error);
    });

    await check('privilege escalation rejected (admin endpoints)', async () => {
      for (const path of ['/api/safety/admin/queue','/api/safety/admin/appeals','/api/safety/admin/audit']) {
        const r = await call(path, { token });
        assert.ok(r.body.error || r.body.queue === undefined, path + ' → ' + JSON.stringify(r.body).slice(0,120));
      }
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE authenticated');
        await assert.rejects(() => c.query(`SELECT get_mod_queue(1)`));
        await assert.rejects(() => c.query(`SELECT admin_action(1,'dismiss')`));
        await assert.rejects(() => c.query(`SELECT apply_strike(1,'minor','x',null,null)`));
      } finally { await c.query('ROLLBACK'); }
    });

    await check('tampered token rejected', async () => {
      const r = await call('/api/auth/session', { token: token.slice(0,-2)+'xx' });
      assert.equal(r.body.loggedIn, false);
    });
    await check('other-user token cannot use my admin check', async () => {
      const r = await call('/api/safety/admin/is-admin', { token });
      assert.equal(r.body.admin, false);
    });

    await check('20 failed logins → 429 with Retry-After', async () => {
      let last;
      for (let i=0;i<21;i++) last = await call('/api/auth/login', { method:'POST', data:{ username:u, password:'wrongpass' } });
      assert.equal(last.code, 429);
      assert.ok(Number(last.retryAfter) > 0);
    });

    await check('no secrets in responses', async () => {
      const paths = ['/api/auth/session','/api/safety/config','/api/safety/status','/api/safety/notices'];
      for (const pth of paths) {
        const r = await call(pth, { token });
        const s = JSON.stringify(r.body).toLowerCase();
        for (const bad of ['password_hash','birth_date','private_birthdates','service_role','supabase_service_role_key'])
          assert.ok(!s.includes(bad), pth + ' leaked ' + bad);
      }
    });

    const u2 = 'sess_' + Math.random().toString(36).slice(2, 8);
    const reg2 = await call('/api/auth/register', { method:'POST', data:{ username:u2, password:'HardPass!99' } });
    const token2 = reg2.body.token;
    await check('session revocation + password change revokes other sessions', async () => {
      const login = await call('/api/auth/login', { method:'POST', data:{ username:u2, password:'HardPass!99' } });
      const t2 = login.body.token;
      assert.ok(t2, JSON.stringify(login.body));
      const before = await call('/api/auth/devices', { token:token2 });
      assert.ok((before.body.devices||[]).length >= 2);
      await call('/api/auth/change-password', { method:'POST', token:token2,
        data:{ currentPassword:'HardPass!99', newPassword:'NewHardPass!77' } });
      const old = await call('/api/auth/session', { token:t2 });
      assert.equal(old.body.loggedIn, false);              // التاني اتبطل
      const mine = await call('/api/auth/session', { token:token2 });
      assert.equal(mine.body.loggedIn, true);               // الحالي شغال
    });

    console.log(`\nTotal: ${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
  } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
  finally { await c.end(); }
})();

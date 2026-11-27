require('./lib/env');
const { Client } = require('pg');
const assert = require('node:assert/strict');
const authSecure = require('./lib/auth-secure');
const BASE = 'http://localhost:' + (process.env.TEST_PORT || 3000);

async function call(path, data, token) {
  const r = await fetch(BASE + path, {
    method: data ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { code: r.status, body: await r.json() };
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let pass = 0, fail = 0;
  const check = async (name, fn) => { try { await fn(); console.log('✔', name); pass++; } catch (e) { console.log('✖', name, '::', e.message); fail++; } };
  try {
    await c.connect();
    await c.query('TRUNCATE login_attempts, register_attempts');
    const u = 'secure_' + Math.random().toString(36).slice(2, 8);

    await check('username normalization', () => {
      assert.equal(authSecure.normalizeUsername('  Ahmed.Sameh  '), 'ahmed.sameh');
      assert.throws(() => authSecure.normalizeUsername('ab'), /INVALID_USERNAME/);
    });
    await check('password policy', () => {
      assert.throws(() => authSecure.validatePassword('123456', u), /WEAK_PASSWORD/);
      assert.throws(() => authSecure.validatePassword('password123', u), /WEAK_PASSWORD/);
      assert.throws(() => authSecure.validatePassword('My' + u + '99', u), /WEAK_PASSWORD/);
      authSecure.validatePassword('Str0ng!Pass99', u);
    });
    await check('s1 hash format', async () => {
      const h = await authSecure.hashPassword('Str0ng!Pass99');
      assert.ok(h.startsWith('s1$'));
      assert.equal(await authSecure.verifyPassword('Str0ng!Pass99', h), true);
      assert.equal(await authSecure.verifyPassword('wrong', h), false);
    });
    await check('legacy hash still verifies', async () => {
      const crypto = require('crypto');
      const salt = crypto.randomBytes(16).toString('hex');
      const hex = crypto.scryptSync('LegacyPass123', salt, 64).toString('hex');
      assert.equal(await authSecure.verifyPassword('LegacyPass123', salt + ':' + hex), true);
    });

    const reg = await call('/api/auth/register', { username: u, password: 'Str0ng!Pass99' });
    const stored = await c.query(`SELECT token_hash FROM sessions WHERE user_id=(SELECT id FROM users WHERE username=$1)`, [u]);
    await check('register', () => { assert.equal(reg.code, 201); assert.ok(reg.body.token); });
    const sess = await call('/api/auth/session', null, reg.body.token);
    await check('session via DB token hash', () => assert.equal(sess.body.loggedIn, true));
    await check('raw token not stored', () => {
      assert.ok(stored.rows.length > 0);
      assert.ok(!stored.rows.some(r => r.token_hash === reg.body.token));
    });
    const login = await call('/api/auth/login', { username: u, password: 'Str0ng!Pass99' });
    await check('login', () => { assert.equal(login.code, 200); assert.ok(login.body.token); });
    const bad = await call('/api/auth/login', { username: u, password: 'nope' });
    await check('bad credentials generic message', () => assert.equal(bad.body.error, 'اليوزر أو الباسورد غلط'));
    const admin = await call('/api/safety/admin/is-admin', null, login.body.token);
    await check('normal user not admin', () => assert.equal(admin.body.admin, false));

    console.log(`\nTotal: ${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
  } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
  finally { await c.end(); }
})();

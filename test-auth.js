const BASE = 'http://localhost:' + (process.env.TEST_PORT || 3116);
(async () => {
  let pass = 0, fail = 0;
  const check = (n, ok, x = '') => { ok ? (console.log('✔', n), pass++) : (console.log('✖', n, x), fail++); };
  const call = async (path, data) => {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { code: r.status, body: await r.json() };
  };
  const u = 'vibe_test_' + Date.now().toString().slice(-6);
  try {
    const reg = await call('/api/auth/register', { username: u, password: 'Strong123' });
    check('register', reg.code === 201 && !!reg.body.token, JSON.stringify(reg.body));
    const bad = await call('/api/auth/login', { username: u, password: 'wrongpass' });
    check('wrong password rejected', bad.code === 401, JSON.stringify(bad.body));
    const login = await call('/api/auth/login', { username: u, password: 'Strong123' });
    check('login', login.code === 200 && !!login.body.token, JSON.stringify(login.body));
    const sess = await (await fetch(BASE + '/api/auth/session', { headers: { Authorization: 'Bearer ' + login.body.token } })).json();
    check('session', sess.loggedIn === true && sess.user.username === u, JSON.stringify(sess));
    const dup = await call('/api/auth/register', { username: u, password: 'Strong123' });
    check('duplicate username rejected', dup.code === 409, JSON.stringify(dup.body));
    console.log(`\nTotal: ${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
  } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
})();

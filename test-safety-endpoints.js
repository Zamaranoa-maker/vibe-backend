/* اختبار نقاط الأمان على السيرفر المحلي (PORT=3111) */
const BASE = 'http://localhost:' + (process.env.TEST_PORT || 3111);
let token = '';
async function call(path, method = 'GET', data) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  return r.json();
}
(async () => {
  let pass = 0, fail = 0;
  const check = (name, ok, extra = '') => { ok ? (console.log('✔', name), pass++) : (console.log('✖', name, extra), fail++); };
  try {
    const h = await call('/api/health');
    check('health', h.ok === true, JSON.stringify(h));

    const a = await call('/api/auth', 'POST', { deviceId: 'safety_endpoint_test' });
    token = a.token || '';
    check('auth token', !!token, JSON.stringify(a));

    const cfg = await call('/api/safety/config');
    check('safety config', cfg.min_age === 13 && Array.isArray(cfg.helplines), JSON.stringify(cfg).slice(0, 160));

    const st = await call('/api/safety/status');
    check('account status', typeof st.status === 'string', JSON.stringify(st));

    const admin = await call('/api/safety/admin/is-admin');
    check('is-admin (false for normal user)', admin.admin === false, JSON.stringify(admin));

    const q = await call('/api/safety/admin/queue');
    check('non-admin queue blocked', q.error === 'FORBIDDEN' || Array.isArray(q.queue), JSON.stringify(q));

    const ns = await call('/api/safety/notices');
    check('notices endpoint', Array.isArray(ns.notices), JSON.stringify(ns));

    const ss = await call('/api/safety/strikes');
    check('strikes endpoint', Array.isArray(ss.strikes), JSON.stringify(ss));

    const bd = await call('/api/safety/birthdate', 'POST', { birth: '1998-05-12' });
    check('birthdate 18+', bd.result === '18+', JSON.stringify(bd));

    console.log(`\nTotal: ${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
  } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
})();

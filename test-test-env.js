/* اختبارات بوابةTEST_DATABASE_URL — بتشتغل على متغيرات وهمية، من غير اتصال بأي DB */
require('./lib/env');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

const PROD = 'postgres://postgres.dqpvrsgwfxzgapiqiwfq:pw@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';
const GOOD_TEST = 'postgres://postgres.abcdef123456:pw@aws-1-eu-west-2.pooler.supabase.com:5432/postgres';

function checkGate({ prod = PROD, test = GOOD_TEST, missing = false } = {}) {
  const env = { ...process.env, VIBE_SKIP_DOTENV: '1', DATABASE_URL: prod };
  if (missing) delete env.TEST_DATABASE_URL;
  else env.TEST_DATABASE_URL = test;
  const r = spawnSync(process.execPath,
    ['-e', "require('./lib/test-env'); console.log('GATE_OK')"],
    { cwd: __dirname, env, encoding: 'utf8' });
  return { code: r.status, text: (r.stdout || '') + (r.stderr || '') };
}

const cases = [
  ['missing TEST_DATABASE_URL aborts', () => {
    const r = checkGate({ missing: true });
    assert.notEqual(r.code, 0);
    assert.match(r.text, /TEST_DATABASE_URL missing/);
  }],
  ['same URL as production aborts', () => {
    const r = checkGate({ test: PROD });
    assert.notEqual(r.code, 0);
    assert.match(r.text, /يساوي DATABASE_URL/);
  }],
  ['same project ref on a different host aborts', () => {
    const r = checkGate({ test: 'postgres://postgres.dqpvrsgwfxzgapiqiwfq:pw@elsewhere.example:5432/postgres' });
    assert.notEqual(r.code, 0);
    assert.match(r.text, /نفس Supabase project ref/);
  }],
  ['unparseable test ref aborts', () => {
    const r = checkGate({ test: 'postgres://someuser:pw@elsewhere.example:5432/postgres' });
    assert.notEqual(r.code, 0);
    assert.match(r.text, /تعذّر استخراج Supabase project ref/);
  }],
  ['different ref on pooler host is allowed', () => {
    const r = checkGate();
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /GATE_OK/);
  }],
  ['ref from db.<ref>.supabase.co host is allowed', () => {
    const r = checkGate({ test: 'postgres://u:pw@db.xyz789abc.supabase.co:5432/postgres' });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /GATE_OK/);
  }],
];

let pass = 0, fail = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log('✔', name); pass++; }
  catch (e) { console.log('✖', name, '::', e.message); fail++; }
}
console.log(`\nTotal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

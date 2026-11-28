/* ============================================================================
   npm test — يشغّل كل الاختبارات على TEST_DATABASE_URL فقط
   يرفض التشغيل لو TEST_DATABASE_URL ناقص أو مساوٍ للإنتاج أو نفس host
   ========================================================================== */
'use strict';
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// التحقق أولاً — أي فشل هنا يوقف كل حاجة قبل ما نتصل بأي DB
const gate = require('./lib/test-env');
const PORT = Number(process.env.TEST_PORT || 3100);
const env = {
  ...process.env,
  DATABASE_URL: gate.testUrl,
  TEST_DATABASE_URL: gate.testUrl,
  PORT: String(PORT),
  TEST_PORT: String(PORT),
  NODE_ENV: 'test',
  ALLOW_LOCAL_ADMIN: '0',
};

const tests = [
  'test-guest.js',
  'test-auth-hardening.js',
  'test-auth-secure.js',
  'test-safety-full.js',
  'test-search-full.js',
  'test-rls-status.js',
  'test-safety.js',
  'test-economy.js',
  'test-economy-flow.js',
  'test-wallet.js',
  'test-foryou.js',
  'test-feed-final.js',
].filter(f => require('fs').existsSync(path.join(__dirname, f)));

console.log('TEST DB host:', gate.testHost, '| production host:', gate.prodHost);

function run(file) {
  return spawnSync(process.execPath, [file], { cwd: __dirname, env, stdio: 'inherit' }).status === 0;
}

(async () => {
  let failed = 0;
  // تأكد إن schema موجود في قاعدة الاختبار
  if (!run('apply-all-migrations.js')) { console.error('MIGRATIONS FAILED'); process.exit(1); }

  const server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => process.stdout.write('[server] ' + d));
  server.stderr.on('data', d => process.stderr.write('[server] ' + d));

  // استنى /health بدل أي sleep ثابت
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/health`);
      if (r.ok) { ready = true; break; }
    } catch (e) {}
    await new Promise(res => setTimeout(res, 250));
  }
  if (!ready) { console.error('TEST SERVER FAILED TO START'); server.kill(); process.exit(1); }

  for (const f of tests) {
    console.log('\n===== ' + f + ' =====');
    if (!run(f)) failed++;
  }

  server.kill();
  console.log('\n===== cleanup =====');
  run('cleanup-test-db.js');
  console.log(`\n${tests.length - failed}/${tests.length} test files passed`);
  process.exit(failed ? 1 : 0);
})();

/* تنظيف قاعدة الاختبار بعد انتهاء الاختبارات — قاعدة الاختبار فقط */
require('./lib/test-env');
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    await c.query(`DO $cleanup$
      DECLARE r RECORD;
      BEGIN
        FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
          EXECUTE 'TRUNCATE TABLE public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $cleanup$;`);
    console.log('TEST DB cleaned ✅');
  } catch (e) { console.error('CLEANUP FAIL:', e.message); process.exit(1); }
  finally { await c.end(); }
})();

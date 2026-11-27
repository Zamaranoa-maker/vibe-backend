/* يبلّغ عن أي تعارض في اليوزرات بعد التوحيد — من غير ما يدمج أو يغيّر حاجة */
require('./lib/env');
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    const { rows } = await c.query(`
      select lower(trim(regexp_replace(coalesce(username, external_id, ''),
        '[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]', '', 'g'))) as uname,
        count(*)::int as users, array_agg(id order by id) as ids
      from users where coalesce(username, external_id, '') <> ''
      group by 1 having count(*) > 1 order by 1`);
    if (!rows.length) { console.log('✅ مفيش تعارض في اليوزرات'); return; }
    console.log('⚠️ تعارضات (لم يتم دمجها):');
    console.table(rows);
    process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exit(1); }
  finally { await c.end(); }
})();

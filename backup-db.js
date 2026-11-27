/* نسخة احتياطية لبيانات Supabase (INSERTs) — بديل عن pg_dump لما مش متثبّت
   الاستعادة: طبّق migrations أولاً وبعدين شغّل الملف ده */
require('./lib/env');
const fs = require('fs');
const { Client } = require('pg');

function lit(v, type = '') {
  if (v == null) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Buffer.isBuffer(v)) return `decode('${v.toString('hex')}','hex')`;
  if (Array.isArray(v)) return `'${v.join(',').replace(/'/g, "''")}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::${type || 'jsonb'}`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const out = [];
  const d = new Date().toISOString().slice(0, 10);
  const file = `backup-${d}.sql`;
  try {
    await c.connect();
    out.push('-- VIBE+ data backup ' + new Date().toISOString());
    out.push('-- استعادة: طبّق كل migrations ثم شغّل هذا الملف');
    out.push('BEGIN;');
    const tables = await c.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
    for (const { table_name: t } of tables.rows) {
      const cols = await c.query(`SELECT column_name,data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t]);
      if (!cols.rows.length) continue;
      const names = cols.rows.map(x => x.column_name);
      const types = cols.rows.map(x => x.data_type);
      const rows = await c.query(`SELECT ${names.map(n => '"' + n + '"').join(',')} FROM public."${t}"`);
      if (!rows.rows.length) continue;
      out.push(`\n-- ${t}: ${rows.rows.length} rows`);
      for (const r of rows.rows) {
        const vals = names.map((n, i) => lit(r[n], types[i] === 'jsonb' ? 'jsonb' : types[i] === 'ARRAY' ? 'text[]' : ''));
        out.push(`INSERT INTO public."${t}" (${names.map(n => '"' + n + '"').join(',')}) VALUES (${vals.join(',')}) ON CONFLICT DO NOTHING;`);
      }
    }
    out.push('COMMIT;');
    fs.writeFileSync(file, out.join('\n'), 'utf8');
    console.log('BACKUP OK:', file, (fs.statSync(file).size / 1024).toFixed(1) + ' KB');
  } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
  finally { await c.end(); }
})();

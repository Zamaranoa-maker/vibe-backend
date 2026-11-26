require('./lib/env');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
(async () => {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    for (const f of files) {
      try { await c.query(fs.readFileSync(path.join(dir, f), 'utf8')); console.log('APPLIED ✅', f); }
      catch (e) { console.log('WARN', f, '::', e.message.slice(0, 160)); }
    }
  } finally { await c.end(); }
})();

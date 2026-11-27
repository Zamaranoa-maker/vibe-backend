/* تحديث قيمة في .env من غير ما تظهر في المحادثة أو في Git
   استخدام: node set-env.js DATABASE_URL "postgres://..." */
const fs = require('fs');
const [key, ...rest] = process.argv.slice(2);
const val = rest.join(' ');
if (!key || !val) { console.error('Usage: node set-env.js KEY value'); process.exit(1); }
const file = '.env';
let lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
let found = false;
lines = lines.map(l => {
  if (new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=').test(l)) { found = true; return key + '=' + val; }
  return l;
});
if (!found) lines.push(key + '=' + val);
fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
console.log('Updated ' + key + ' (value hidden)');

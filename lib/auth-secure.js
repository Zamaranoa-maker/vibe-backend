/* ============================================================================
   auth-secure.js — تقوية الدخول
   scrypt(s1$) + جلسات بهاش + rate limit في DB + استرداد OTP
   ========================================================================== */
'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const SESSION_DAYS = 30;

function normalizeUsername(raw) {
  const u = String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_.]{3,20}$/.test(u)) throw new Error('INVALID_USERNAME');
  return u;
}

const COMMON = new Set(['12345678','123456789','1234567890','password','password1',
  'qwerty123','11111111','00000000','iloveyou','admin123','abc12345','vibeplus','vibe1234',
  'password123','1234567a','welcome123','letmein123','qwertyuiop','123123123']);
function validatePassword(pw, username) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128) throw new Error('WEAK_PASSWORD');
  const l = pw.toLowerCase();
  if (COMMON.has(l) || /^(.)\1+$/.test(pw) || (username && l.includes(username))) throw new Error('WEAK_PASSWORD');
  // كلمات متكررة قصيرة (مثل abababab)
  if (/^(.{1,3})\1+$/.test(pw)) throw new Error('WEAK_PASSWORD');
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `s1$${salt.toString('hex')}$${key.toString('hex')}`;
}
const DUMMY = hashPassword('dummy-password-for-timing');

async function verifyPassword(pw, stored) {
  if (!stored) { await DUMMY; return false; }
  if (stored.startsWith('s1$')) {
    const [, saltHex, keyHex] = stored.split('$');
    const [key] = await Promise.all([
      scrypt(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 }), DUMMY,
    ]);
    const expected = Buffer.from(keyHex, 'hex');
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  }
  try {
    const [saltHex, hex] = stored.split(':');
    const a = await scrypt(pw, saltHex, 64);
    const b = Buffer.from(hex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

/* بصمة الجهاز: بنخزن هاش مملّح بس، مش الـ ID الخام */
function deviceHash(rawDeviceId) {
  const salt = process.env.DEVICE_HASH_SALT || 'vibe-local-device-salt';
  return rawDeviceId ? sha(salt + ':' + String(rawDeviceId)) : null;
}

async function createSession(pool, userId, req, deviceId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ip = req.clientIp || req.socket?.remoteAddress || '';
  await pool.query(
    `INSERT INTO sessions(token_hash,user_id,expires_at,ip,user_agent,device_hash)
     VALUES ($1,$2,now() + interval '30 days',$3,$4,$5)`,
    [sha(token), userId, String(ip).slice(0, 64), String(req.headers['user-agent'] || '').slice(0, 200),
     deviceHash(deviceId)]);
  return token;
}

async function checkLoginAllowed(pool, username, ip) {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE username=$1 AND NOT success AND created_at > now() - interval '15 minutes') AS by_user,
       count(*) FILTER (WHERE ip=$2 AND NOT success AND created_at > now() - interval '15 minutes') AS by_ip
     FROM login_attempts WHERE created_at > now() - interval '15 minutes'`, [username, String(ip || '')]);
  const r = rows[0] || {};
  if (Number(r.by_user) >= 5 || Number(r.by_ip) >= 20) throw new Error('TOO_MANY_ATTEMPTS');
}

async function checkRegisterAllowed(pool, ip) {
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM register_attempts
     WHERE ip=$1 AND created_at > now() - interval '1 hour'`, [String(ip || '')]);
  if (Number(rows[0]?.n || 0) >= 5) throw new Error('TOO_MANY_ATTEMPTS');
}
const logRegisterAttempt = (pool, ip) =>
  pool.query('INSERT INTO register_attempts(ip) VALUES($1)', [String(ip || '')]);

async function login(pool, req, rawUser, password, deviceId) {
  const username = normalizeUsername(rawUser);
  const ip = req.clientIp || req.socket?.remoteAddress || '';
  await checkLoginAllowed(pool, username, ip);
  const { rows } = await pool.query('SELECT id,username,password_hash,must_change_password FROM users WHERE username=$1', [username]);
  const u = rows[0];
  const ok = await verifyPassword(password, u?.password_hash);
  await pool.query('INSERT INTO login_attempts(username,ip,success,kind) VALUES ($1,$2,$3,$4)',
    [username, ip, !!(u && ok), 'login']);
  if (!u || !ok) throw new Error('BAD_CREDENTIALS');
  let mustChange = !!u.must_change_password;
  if (!mustChange) { try { validatePassword(password, username); } catch (e) { mustChange = true; } }
  if (mustChange)
    await pool.query('UPDATE users SET must_change_password=true WHERE id=$1', [u.id]);
  return { token: await createSession(pool, u.id, req, deviceId), userId: u.id, username, mustChange };
}

async function resolveSession(pool, token) {
  if (!pool || !token) return null;
  const { rows } = await pool.query(
    `SELECT u.external_id, u.username, s.user_id, s.device_hash FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash=$1 AND s.expires_at > now() AND NOT s.revoked`, [sha(token)]);
  if (!rows[0]) return null;
  return { id: rows[0].external_id || String(rows[0].user_id), username: rows[0].username,
    dbId: rows[0].user_id, deviceHash: rows[0].device_hash };
}

const listSessions = (pool, userId) => pool.query(
  `SELECT substring(token_hash,1,12) as device, ip, user_agent, device_hash is not null as has_device,
          expires_at, created_at
   FROM sessions WHERE user_id=$1 AND NOT revoked AND expires_at > now()
   ORDER BY created_at DESC`, [userId]);

const revokeSession = (pool, userId, token) =>
  pool.query('UPDATE sessions SET revoked=true WHERE user_id=$1 AND token_hash=$2',
    [userId, sha(token)]);

const revokeAllSessions = (pool, userId, exceptToken = null) =>
  pool.query('UPDATE sessions SET revoked=true WHERE user_id=$1 AND ($2::text IS NULL OR token_hash <> $2)',
    [userId, exceptToken ? sha(exceptToken) : null]);

async function changePassword(pool, userId, currentPw, newPw, currentToken) {
  const { rows } = await pool.query('SELECT password_hash,username FROM users WHERE id=$1', [userId]);
  const u = rows[0];
  if (!u || !(await verifyPassword(currentPw, u.password_hash))) throw new Error('BAD_CREDENTIALS');
  validatePassword(newPw, u.username);
  const hash = await hashPassword(newPw);
  await pool.query('UPDATE users SET password_hash=$1,must_change_password=false WHERE id=$2', [hash, userId]);
  await revokeAllSessions(pool, userId, currentToken);   // كل الأجهزة التانية
  return true;
}

/* استرداد عبر OTP (10 دقائق، استخدام واحد) */
async function requestRecovery(pool, userId) {
  const code = String(crypto.randomInt(100000, 999999));
  await pool.query('DELETE FROM recovery_codes WHERE user_id=$1 OR expires_at < now()', [userId]);
  await pool.query(`INSERT INTO recovery_codes(user_id,code_hash,expires_at)
    VALUES ($1,$2,now() + interval '10 minutes')`, [userId, sha(code)]);
  return code;   // السيرفر يرسله عبر Resend لو متهيّأ
}
async function verifyRecovery(pool, userId, code) {
  const { rows } = await pool.query(`SELECT id FROM recovery_codes
    WHERE user_id=$1 AND code_hash=$2 AND NOT used AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
    [userId, sha(String(code))]);
  if (!rows[0]) throw new Error('BAD_CODE');
  await pool.query('UPDATE recovery_codes SET used=true WHERE id=$1', [rows[0].id]);
  return true;
}

module.exports = { sha, SESSION_DAYS, normalizeUsername, validatePassword, hashPassword,
  verifyPassword, deviceHash, createSession, checkLoginAllowed, checkRegisterAllowed,
  logRegisterAttempt, login, resolveSession, listSessions, revokeSession, revokeAllSessions,
  changePassword, requestRecovery, verifyRecovery };

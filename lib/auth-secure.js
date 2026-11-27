/* ============================================================================
   auth-secure.js — يوزر/باسورد آمن (scrypt + جلسات بهاش + rate limit)
   متكيّف على معرّفات users من نوع bigint
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
  if (!/^[\p{L}\p{N}_.]{3,20}$/u.test(u)) throw new Error('INVALID_USERNAME');
  return u;
}

const COMMON = new Set(['12345678','123456789','1234567890','password','password1',
  'qwerty123','11111111','00000000','iloveyou','admin123','abc12345','vibeplus','vibe1234',
  'password123','1234567a','welcome123','letmein123']);
function validatePassword(pw, username) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128) throw new Error('WEAK_PASSWORD');
  const l = pw.toLowerCase();
  if (COMMON.has(l) || /^(.)\1+$/.test(pw) || (username && l.includes(username))) throw new Error('WEAK_PASSWORD');
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `s1$${salt.toString('hex')}$${key.toString('hex')}`;
}
const DUMMY = hashPassword('dummy-password-for-timing');   // promise، بنستنيها عند الاستخدام

async function verifyPassword(pw, stored) {
  if (!stored) { await DUMMY; return false; }
  if (stored.startsWith('s1$')) {
    const [, saltHex, keyHex] = stored.split('$');
    const [key, dummy] = await Promise.all([
      scrypt(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 }),
      DUMMY,
    ]);
    const expected = Buffer.from(keyHex, 'hex');
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  }
  // توافق مع الهاش القديم: salt:hex (scrypt بالاعدادات الافتراضية)
  try {
    const [saltHex, hex] = stored.split(':');
    const a = await scrypt(pw, saltHex, 64);
    const b = Buffer.from(hex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

async function createSession(pool, userId, ip, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions(token_hash,user_id,expires_at,ip,user_agent)
     VALUES ($1,$2,now() + interval '30 days',$3,$4)`,
    [sha(token), userId, String(ip || '').slice(0, 64), String(userAgent || '').slice(0, 200)]);
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

async function login(pool, req, rawUser, password) {
  const username = normalizeUsername(rawUser);
  const ip = req.socket?.remoteAddress || '';
  await checkLoginAllowed(pool, username, ip);
  const { rows } = await pool.query('SELECT id,password_hash FROM users WHERE username=$1', [username]);
  const u = rows[0];
  const ok = await verifyPassword(password, u?.password_hash);
  await pool.query('INSERT INTO login_attempts(username,ip,success) VALUES ($1,$2,$3)',
    [username, ip, !!(u && ok)]);
  if (!u || !ok) throw new Error('BAD_CREDENTIALS');
  return { token: await createSession(pool, u.id, ip, req.headers['user-agent']), userId: u.id, username };
}

async function resolveSession(pool, token) {
  if (!pool || !token) return null;
  const { rows } = await pool.query(
    `SELECT u.external_id, u.username, s.user_id FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash=$1 AND s.expires_at > now() AND NOT s.revoked`, [sha(token)]);
  if (!rows[0]) return null;
  return { id: rows[0].external_id || String(rows[0].user_id), username: rows[0].username, dbId: rows[0].user_id };
}

const revokeAllSessions = (pool, userId, exceptHash = null) =>
  pool.query('UPDATE sessions SET revoked=true WHERE user_id=$1 AND ($2::text IS NULL OR token_hash <> $2)', [userId, exceptHash]);

module.exports = { sha, SESSION_DAYS, normalizeUsername, validatePassword, hashPassword,
  verifyPassword, createSession, checkLoginAllowed, login, resolveSession, revokeAllSessions };

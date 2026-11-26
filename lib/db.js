/* ============================================================================
   db.js — Postgres pool (اختياري). لو مفيش DATABASE_URL → fallback للـ JSON.
   ========================================================================== */
'use strict';
let pool = null, available = false;

async function init() {
  if (!process.env.DATABASE_URL) return false;
  try {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10,
      idleTimeoutMillis: 20000, allowExitOnIdle: true,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized:false } : undefined });
    // أي قطع في اتصال خامل ما يوقفش السيرفر
    pool.on('error', e => console.warn('[db] idle connection error:', e.code || e.message));
    await pool.query('SELECT 1');
    available = true;
    console.log('[db] Postgres connected');
    return true;
  } catch (e) {
    console.warn('[db] Postgres failed, using JSON store:', e.message);
    pool = null; available = false; return false;
  }
}
const getPool = () => available ? pool : null;
module.exports = { init, getPool, get available() { return available; } };

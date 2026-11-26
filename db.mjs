/* db.mjs — Postgres pool للنسخة ESM */
import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

export async function check() { await pool.query('SELECT 1'); return true; }
export async function close() { await pool.end(); }

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 5,                     
  idleTimeoutMillis: 10000,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      id           SERIAL PRIMARY KEY,
      title        VARCHAR(200) NOT NULL,
      text         TEXT NOT NULL,
      language     VARCHAR(20) NOT NULL DEFAULT 'auto',
      duration_sec INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_transcriptions_created ON transcriptions (created_at DESC);
  `);
}

module.exports = { pool, init, query: (text, params) => pool.query(text, params) };
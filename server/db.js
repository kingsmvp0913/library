const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

function query(sql, params) {
  return getPool().query(sql, params);
}

/** 每次啟動都會跑，必須 idempotent。 */
async function migrate() {
  await query('SELECT 1');
}

module.exports = { getPool, query, migrate };

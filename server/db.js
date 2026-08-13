const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

function query(sql, params) {
  return getPool().query(sql, params);
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS shelves (
     id SERIAL PRIMARY KEY,
     code TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     -- parent_id 是早期「櫃 → 層」兩層結構的殘留，實際使用後判定太複雜已移除。
     -- 程式不再讀寫它；欄位保留是因為本專案沒有 drop column 機制。
     parent_id INTEGER REFERENCES shelves(id),
     note TEXT,
     sort_order INTEGER NOT NULL DEFAULT 0,
     active BOOLEAN NOT NULL DEFAULT TRUE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS categories (
     id SERIAL PRIMARY KEY,
     code TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('book','toy')),
     sort_order INTEGER NOT NULL DEFAULT 0,
     active BOOLEAN NOT NULL DEFAULT TRUE
   )`,
  `CREATE TABLE IF NOT EXISTS titles (
     id SERIAL PRIMARY KEY,
     isbn13 TEXT UNIQUE,
     title TEXT NOT NULL,
     subtitle TEXT,
     authors TEXT,
     publisher TEXT,
     published_date TEXT,
     description TEXT,
     cover_path TEXT,
     category_id INTEGER NOT NULL REFERENCES categories(id),
     source TEXT NOT NULL DEFAULT 'manual',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS copies (
     id SERIAL PRIMARY KEY,
     barcode TEXT NOT NULL UNIQUE,
     title_id INTEGER NOT NULL REFERENCES titles(id),
     shelf_id INTEGER REFERENCES shelves(id),
     status TEXT NOT NULL DEFAULT 'in' CHECK (status IN ('in','out','lost','repair')),
     note TEXT,
     acquired_at DATE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS borrowers (
     id SERIAL PRIMARY KEY,
     code TEXT UNIQUE,
     name TEXT NOT NULL,
     class_name TEXT,
     note TEXT,
     active BOOLEAN NOT NULL DEFAULT TRUE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS loans (
     id SERIAL PRIMARY KEY,
     copy_id INTEGER NOT NULL REFERENCES copies(id),
     borrower_id INTEGER NOT NULL REFERENCES borrowers(id),
     borrowed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     returned_at TIMESTAMPTZ,
     return_shelf_id INTEGER REFERENCES shelves(id)
   )`,
  `CREATE TABLE IF NOT EXISTS counters (
     kind TEXT PRIMARY KEY,
     last_no INTEGER NOT NULL DEFAULT 0
   )`,
];

const SEED_CATEGORIES = [
  ['picture-book', '繪本', 'book', 10],
  ['bridge-book', '橋樑書', 'book', 20],
  ['reference', '工具書', 'book', 30],
  ['teaching-aid', '教具', 'toy', 40],
  ['board-game', '桌遊', 'toy', 50],
];

/** 每次啟動都會跑，必須 idempotent。 */
async function migrate() {
  for (const ddl of DDL) await query(ddl);

  // 一冊同時只能有一筆未歸還紀錄。這是資料庫層的最後防線，不可只靠應用層檢查。
  // pg-mem 若不支援 partial index，測試環境略過，但真實 PG 必須建起來。
  try {
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS loans_one_open_per_copy
         ON loans(copy_id) WHERE returned_at IS NULL`
    );
  } catch (err) {
    console.warn('[migrate] partial unique index 未建立（測試環境常見）：' + err.message);
  }

  for (const [code, name, kind, sort] of SEED_CATEGORIES) {
    await query(
      `INSERT INTO categories (code, name, kind, sort_order) VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO NOTHING`,
      [code, name, kind, sort]
    );
  }
  // book／toy 是館藏編號；shelf／category 是主檔代碼——
  // 代碼都由系統自動產生，使用者只填看得懂的名字。
  for (const kind of ['book', 'toy', 'shelf', 'category']) {
    await query(`INSERT INTO counters (kind) VALUES ($1) ON CONFLICT (kind) DO NOTHING`, [kind]);
  }
}

module.exports = { getPool, query, migrate };

#!/usr/bin/env node
/**
 * setup.js — 一鍵安裝編排：建 config → CREATE DATABASE → migrate → 種子資料
 * 一律用 __dirname 求專案根，禁止寫死絕對路徑。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULT_DB_URL = 'postgres://postgres:postgres@localhost:5432/library';
const DEFAULT_PORT = 3940;

/** 純函式：不碰檔案系統、不讀 process.env。優先序 overrides > env > 預設。 */
function buildConfig(overrides = {}, env = {}) {
  const port = overrides.PORT
    ?? (env.PORT !== undefined ? Number(env.PORT) : undefined)
    ?? DEFAULT_PORT;
  return {
    DATABASE_URL: overrides.DATABASE_URL ?? env.DATABASE_URL ?? DEFAULT_DB_URL,
    PORT: port,
    GOOGLE_BOOKS_API_KEY: overrides.GOOGLE_BOOKS_API_KEY ?? env.GOOGLE_BOOKS_API_KEY ?? '',
  };
}

/** 已存在就原封不動讀回——使用者改過的設定必須保住。 */
function ensureConfig() {
  if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const cfg = buildConfig({}, process.env);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

/** 拆出 DB 名，並回傳連到 postgres 系統庫的 URL（用來 CREATE DATABASE）。 */
function splitDbUrl(databaseUrl) {
  const u = new URL(databaseUrl);
  const dbName = u.pathname.replace(/^\//, '');
  u.pathname = '/postgres';
  return { adminUrl: u.toString(), dbName };
}

/** 不存在才建，讓重跑安裝.bat 不會炸。 */
async function ensureDatabase(databaseUrl) {
  const { Client } = require('pg');
  const { adminUrl, dbName } = splitDbUrl(databaseUrl);
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length === 0) {
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`[OK] 已建立資料庫 ${dbName}`);
    } else {
      console.log(`[OK] 資料庫 ${dbName} 已存在`);
    }
  } finally {
    await client.end();
  }
}

async function main() {
  console.log('=== 圖書系統 安裝 ===');
  const cfg = ensureConfig();
  console.log('[OK] 設定檔就緒：' + CONFIG_PATH);

  await ensureDatabase(cfg.DATABASE_URL);

  process.env.DATABASE_URL = cfg.DATABASE_URL;
  const db = require(path.join(ROOT, 'server', 'db.js'));
  await db.migrate();
  console.log('[OK] 資料表建立完成');

  fs.mkdirSync(path.join(DATA_DIR, 'covers'), { recursive: true });
  console.log('安裝完成！請雙擊「啟動.bat」開始使用。');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[失敗] ${err.message}`);
    console.error('若您的電腦已安裝 PostgreSQL 且密碼不是 postgres，');
    console.error('請開啟 data\\config.json 修改 DATABASE_URL 的帳號密碼，再執行一次「安裝.bat」。');
    process.exit(1);
  });
}

module.exports = { buildConfig, splitDbUrl };

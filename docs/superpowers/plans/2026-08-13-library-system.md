# 幼稚園圖書／教具管理系統 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 幼稚園自用的單機館藏系統：掃 ISBN 建檔、掃編號借還、還書時提示放回哪一格，安裝與更新都只需雙擊一個檔。

**Architecture:** Express 提供 JSON API + 靜態頁面，PostgreSQL 存資料。館藏分「書目（`titles`）／單冊（`copies`）」兩層，借還一律作用在單冊。外部 ISBN 查詢隔離成可插拔的 provider，離線時整條靜默略過。`安裝.bat`／`啟動.bat` 各自只呼叫一支 node 腳本，複雜邏輯全在 node 裡以便測試。

**Tech Stack:** Node 24（原生 `fetch`）、Express 4、PostgreSQL 17、`pg`、`multer`、原生 JS/CSS 前端（無框架）、jest + pg-mem + supertest。

**Spec:** `docs/superpowers/specs/2026-08-13-library-system-design.md`

## Global Constraints

以下適用於**每一個** task，不再重複列出：

- **禁止寫死絕對路徑**（`C:\...`、`/home/...`）。一律 `path.resolve(__dirname, ...)` 或設定值。
- **所有設定集中在 `data/config.json`**（`DATABASE_URL`／`PORT`／`GOOGLE_BOOKS_API_KEY`），不建 `.env`。`data/` 不進版控。
- **埠固定 `3940`**（可由 config 覆寫）。
- **時間欄位一律 `TIMESTAMPTZ`**，不可用 `TIMESTAMP`（台灣時區會差 8 小時）。
- **取預設值用 `??` 不用 `||`**（`0` 是合法值）。
- **測試用 `npm run test:quiet`**（含 `--runInBand`）。單支除錯才用 `npx jest <檔名>`。
- **外部網路一律 mock，測試不打外網。**
- **借還功能任何情況下不得依賴網路。**
- **給使用者的錯誤訊息是「下一步該做什麼」，不是 stack trace。**
- 每個 task 最後一步都是 commit，訊息格式 `[模組]: 為什麼`。
- 完成 task 前跑一次 `npm run test:quiet`，確認沒有把既有測試弄紅。

## File Structure

| 檔案 | 職責 |
|---|---|
| `安裝.bat` | 裝 Node/PG/Git → `npm install` → 呼叫 `setup.js`。**存 CP950，不加 chcp** |
| `啟動.bat` | `git pull --ff-only` → 呼叫 `start.js`。**純 ASCII + `chcp 65001`** |
| `scripts/setup.js` | 建 config → CREATE DATABASE → migrate → 種子資料。匯出純函式 `buildConfig` |
| `scripts/free-port.js` | 找出並關閉佔用指定埠的舊 node 進程。匯出 `freePort(port)` |
| `scripts/start.js` | 讀 config → 關舊進程 → 開瀏覽器 → migrate → listen |
| `server/index.js` | `createApp()` 組裝 Express 與所有 route（**不 listen**，供測試注入） |
| `server/db.js` | 連線池、`migrate()`、`query()` |
| `server/lib/barcode-no.js` | 原子取號，產生 `B-000001`／`T-000001` |
| `server/lib/net-status.js` | 離線偵測與 60 秒快取 |
| `server/lib/isbn/google-books.js` | Google Books provider |
| `server/lib/isbn/ncl.js` | 台灣 ISBN 全國新書資訊網 provider（爬 HTML，脆弱） |
| `server/lib/isbn/index.js` | 依序嘗試 provider，任一失敗不冒泡 |
| `server/routes/crud.js` | 共用的簡單主檔 CRUD 產生器 |
| `server/routes/masters.js` | `categories`／`shelves`／`borrowers` 三個主檔 |
| `server/routes/titles.js` | 書目與單冊建檔、加冊、封面上傳 |
| `server/routes/scan.js` | `/api/scan`、`/api/loans`、`/api/returns` |
| `server/routes/lookup.js` | `/api/lookup/isbn/:isbn`、`/api/net-status` |
| `server/routes/search.js` | `/api/search/suggest` |
| `public/js/app.js` | 共用 fetch／toast／格式化 |
| `public/js/scan-input.js` | 掃碼輸入（掃碼槍 + 鏡頭備援） |
| `public/js/omnisearch.js` | 全站搜尋自動完成 |
| `public/js/barcode.js` | Code128 SVG 產生 |
| `public/*.html` | 借還台／館藏／書櫃／借閱人／借閱紀錄 |

---

### Task 1: 專案骨架與一鍵安裝腳本

跑完這個 task，雙擊 `安裝.bat` 能把環境裝起來，雙擊 `啟動.bat` 能開出一個「安裝成功」頁面。

**Files:**
- Create: `package.json`, `.gitignore`, `scripts/setup.js`, `scripts/free-port.js`, `scripts/start.js`, `server/index.js`, `server/db.js`, `public/index.html`, `安裝.bat`, `啟動.bat`
- Test: `server/tests/setup-config.test.js`

**Interfaces:**
- Produces: `buildConfig(overrides?) → {DATABASE_URL, PORT, GOOGLE_BOOKS_API_KEY}`（純函式，無 I/O）
- Produces: `freePort(port) → {killed: number[], blockedBy: string[]}`
- Produces: `createApp() → express.Application`（不 listen）
- Produces: `db.migrate() → Promise<void>`、`db.query(sql, params) → Promise<QueryResult>`

- [ ] **Step 1: 建 `package.json`**

```json
{
  "name": "library",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node scripts/start.js",
    "setup": "node scripts/setup.js",
    "test": "jest --runInBand",
    "test:quiet": "jest --runInBand --silent --noStackTrace --no-color"
  },
  "dependencies": {
    "express": "^4.19.2",
    "multer": "^2.0.0",
    "pg": "^8.11.0"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "pg-mem": "^2.9.1",
    "supertest": "^7.0.0"
  },
  "jest": {
    "testEnvironment": "node",
    "testMatch": ["**/server/tests/**/*.test.js"]
  }
}
```

- [ ] **Step 2: 建 `.gitignore`**

`data/` 含使用者設定與封面圖，絕不進版控。

```gitignore
node_modules/
data/
*.log
```

- [ ] **Step 3: 寫 `buildConfig` 的失敗測試**

`server/tests/setup-config.test.js`：

```js
const { buildConfig } = require('../../scripts/setup.js');

describe('buildConfig', () => {
  test('沒有任何覆寫時給出可直接用的預設值', () => {
    const cfg = buildConfig({}, {});
    expect(cfg.DATABASE_URL).toBe('postgres://postgres:postgres@localhost:5432/library');
    expect(cfg.PORT).toBe(3940);
    expect(cfg.GOOGLE_BOOKS_API_KEY).toBe('');
  });

  test('overrides 逐欄覆寫，未覆寫的欄位保持預設', () => {
    const cfg = buildConfig({ PORT: 4000 }, {});
    expect(cfg.PORT).toBe(4000);
    expect(cfg.DATABASE_URL).toBe('postgres://postgres:postgres@localhost:5432/library');
  });

  // PORT 0 是「合法但不同」的值：用 || 取預設會被 3940 蓋掉，用 ?? 才會保留。
  // 這個案例專門攔截 ?? 被寫成 || 的錯誤。
  test('PORT 明確給 0 時不被預設值蓋掉', () => {
    expect(buildConfig({ PORT: 0 }, {}).PORT).toBe(0);
  });

  test('env 的優先序低於 overrides、高於預設值', () => {
    expect(buildConfig({}, { PORT: '5000' }).PORT).toBe(5000);
    expect(buildConfig({ PORT: 4000 }, { PORT: '5000' }).PORT).toBe(4000);
  });
});
```

- [ ] **Step 4: 跑測試確認失敗**

Run: `npx jest server/tests/setup-config.test.js 2>&1`
Expected: FAIL —— `Cannot find module '../../scripts/setup.js'`

- [ ] **Step 5: 寫 `scripts/setup.js`**

`buildConfig` 收第二個參數 `env` 而不是直接讀 `process.env`，是為了讓它保持純函式、可測試。

```js
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
  const port = overrides.PORT ?? (env.PORT !== undefined ? Number(env.PORT) : undefined) ?? DEFAULT_PORT;
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
```

- [ ] **Step 6: 跑測試確認通過**

Run: `npx jest server/tests/setup-config.test.js 2>&1`
Expected: PASS，4 個案例全綠

- [ ] **Step 7: 寫 `server/db.js` 的最小版本**

這一版只要能連線與跑空的 migrate；建表在 Task 2。

```js
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
```

- [ ] **Step 8: 寫 `server/index.js`**

`createApp()` 不 listen —— 這樣 supertest 才能直接注入。

```js
const path = require('path');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/covers', express.static(path.join(ROOT, 'data', 'covers')));
  return app;
}

module.exports = { createApp };
```

- [ ] **Step 9: 寫 `public/index.html` 的佔位頁**

```html
<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>圖書管理系統</title></head>
<body><h1>圖書管理系統</h1><p>安裝成功，功能建置中。</p></body>
</html>
```

- [ ] **Step 10: 寫 `scripts/free-port.js`**

`netstat` 找出佔用該埠的 PID，只殺 node 進程；不是 node 的一律回報給呼叫端，不硬殺。

```js
const { execSync } = require('child_process');

/** 回傳該埠上 LISTENING 的 PID 清單。 */
function pidsOnPort(port) {
  let out = '';
  try {
    out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8' });
  } catch {
    return [];
  }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
    if (m && Number(m[1]) === port) pids.add(Number(m[2]));
  }
  return [...pids];
}

/** 取得 PID 的執行檔名，取不到回空字串。 */
function processName(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { encoding: 'utf8' });
    const m = out.match(/^"([^"]+)"/m);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/**
 * 關閉佔用該埠的舊 node 進程。
 * 非 node 的程式不硬殺，放進 blockedBy 讓呼叫端提示使用者換埠。
 */
function freePort(port) {
  const killed = [];
  const blockedBy = [];
  for (const pid of pidsOnPort(port)) {
    if (pid === process.pid) continue;
    const name = processName(pid);
    if (/^node\.exe$/i.test(name)) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
        killed.push(pid);
      } catch {
        blockedBy.push(`${name}(PID ${pid})`);
      }
    } else if (name) {
      blockedBy.push(`${name}(PID ${pid})`);
    }
  }
  return { killed, blockedBy };
}

module.exports = { freePort, pidsOnPort, processName };
```

- [ ] **Step 11: 寫 `scripts/start.js`**

**關舊進程必須排在開瀏覽器之前** —— 否則 `git pull` 拉到的新版沒生效、瀏覽器連上舊進程，畫面完全看不出異狀。

```js
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'config.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('找不到 data\\config.json，請先雙擊「安裝.bat」完成安裝。');
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch {
  console.error('data\\config.json 損毀，請重新雙擊「安裝.bat」。');
  process.exit(1);
}

const port = cfg.PORT ?? 3940;
process.env.DATABASE_URL = cfg.DATABASE_URL;
process.env.GOOGLE_BOOKS_API_KEY = cfg.GOOGLE_BOOKS_API_KEY ?? '';
process.env.PORT = String(port);

// 必須排在開瀏覽器之前，否則瀏覽器會連上剛更新前的舊進程，且畫面看不出異狀。
const { freePort } = require(path.join(ROOT, 'scripts', 'free-port.js'));
const freed = freePort(port);
if (freed.blockedBy.length) {
  console.error(`連接埠 ${port} 被 ${freed.blockedBy.join('、')} 占用，無法啟動。`);
  console.error('請先關閉該程式，或開啟 data\\config.json 把 PORT 改成別的數字。');
  process.exit(1);
}
if (freed.killed.length) console.log(`[啟動] 已關閉先前的圖書系統(PID ${freed.killed.join(', ')})`);

try {
  spawn('cmd', ['/c', 'start', '', `http://localhost:${port}`], { detached: true, stdio: 'ignore' });
} catch { /* 開不了瀏覽器不致命 */ }

const { createApp } = require(path.join(ROOT, 'server', 'index.js'));
const { migrate } = require(path.join(ROOT, 'server', 'db.js'));

migrate()
  .then(() => {
    createApp().listen(port, () => {
      console.log(`圖書系統已啟動：http://localhost:${port}`);
      console.log('（關閉這個黑色視窗就會停止系統）');
    });
  })
  .catch((err) => {
    console.error('啟動失敗：' + err.message);
    console.error('請確認 PostgreSQL 已啟動，且 data\\config.json 的 DATABASE_URL 帳號密碼正確。');
    process.exit(1);
  });
```

- [ ] **Step 12: 寫 `啟動.bat`（純 ASCII，中文交給 node 印）**

存檔編碼：**UTF-8 無 BOM 或純 ASCII 皆可，內容不得有中文**。

```bat
@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Update before node starts, so the new version takes effect this run.
rem Silently skipped when git is absent or this folder is not a git repo.
where git >nul 2>nul && git pull --ff-only
node "scripts\start.js"
if errorlevel 1 pause
```

- [ ] **Step 13: 寫 `安裝.bat`（存 CP950／Big5，不加 chcp）**

⚠️ 這個檔**必須存成 CP950（Big5）編碼、不可加 `chcp`、不可有 BOM**。它在 node 裝好之前就要印中文，沒有 node 可用。

```bat
@echo off
cd /d "%~dp0"
echo ============================================
echo    圖書管理系統 安裝（第一次使用執行這個）
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [1/5] 安裝 Node.js ...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
) else (
  echo [1/5] Node.js 已安裝，略過
)

set "PGOK="
where psql >nul 2>nul && set "PGOK=1"
reg query "HKLM\SOFTWARE\PostgreSQL\Installations" >nul 2>nul && set "PGOK=1"
if not defined PGOK (
  echo [2/5] 安裝 PostgreSQL 17 ...
  winget install -e --id PostgreSQL.PostgreSQL.17 --silent --accept-package-agreements --accept-source-agreements
) else (
  echo [2/5] PostgreSQL 已安裝，略過
)

where git >nul 2>nul
if errorlevel 1 (
  echo [3/5] 安裝 Git（啟動時自動更新需要）...
  winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements
) else (
  echo [3/5] Git 已安裝，略過
)

call :refreshpath

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node 已安裝完成，但需要重新開啟視窗才會生效。
  echo 請關掉這個視窗，再點一次「安裝.bat」即可繼續。
  echo.
  pause
  exit /b 1
)

echo [4/5] 安裝相依套件 ...
call npm install

echo [5/5] 建立資料庫並初始化 ...
node "scripts\setup.js"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo    安裝完成！請雙擊「啟動.bat」開始使用。
echo ============================================
pause
exit /b 0

:refreshpath
rem winget 裝完，本視窗的 PATH 仍是舊的，必須從登錄檔重讀
for /f "skip=2 tokens=2,*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "MPATH=%%B"
for /f "skip=2 tokens=2,*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "UPATH=%%B"
call set "PATH=%MPATH%;%UPATH%"
goto :eof
```

- [ ] **Step 14: 人工驗收（自動化測試驗不到）**

1. 雙擊 `安裝.bat` —— **用眼睛確認中文不是亂碼**，跑完出現「安裝完成」。
2. 檢查 `data/config.json` 已產生。
3. 雙擊 `啟動.bat` —— 瀏覽器自動開啟並顯示「安裝成功，功能建置中」。
4. **再雙擊一次 `啟動.bat`** —— 確認舊進程被關掉、沒有噴「埠已被占用」。

若中文是亂碼：確認 `安裝.bat` 存成 CP950 且沒有 BOM。

- [ ] **Step 15: 跑全部測試**

Run: `npm run test:quiet 2>&1`
Expected: PASS。**記下 `Tests:` 那一行的數字，這是後續所有 task 的基線。**

- [ ] **Step 16: Commit**

```bash
git add package.json .gitignore scripts server public 安裝.bat 啟動.bat
git commit -m "[Setup]: 使用者不懂電腦，安裝與啟動必須各自只有一個雙擊入口"
```

---

### Task 2: 資料庫 schema

**Files:**
- Modify: `server/db.js`
- Test: `server/tests/db-migrate.test.js`

**Interfaces:**
- Consumes: `db.query`（Task 1）
- Produces: `migrate()` 建好 7 張表與 `loans_one_open_per_copy` index，並種入預設 `categories`

- [ ] **Step 1: 寫 migration 的失敗測試**

`server/tests/db-migrate.test.js`。用 pg-mem 產生假 Pool 注入。

```js
const { newDb } = require('pg-mem');

function freshDb() {
  jest.resetModules();
  const mem = newDb();
  const pg = mem.adapters.createPg();
  jest.doMock('pg', () => pg);
  return require('../db.js');
}

describe('migrate', () => {
  test('建立所有資料表', async () => {
    const db = freshDb();
    await db.migrate();
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`
    );
    const names = rows.map((r) => r.table_name).sort();
    expect(names).toEqual(
      ['borrowers', 'categories', 'copies', 'counters', 'loans', 'shelves', 'titles'].sort()
    );
  });

  // migrate 每次啟動都會跑，不 idempotent 就會讓系統第二次開不起來。
  test('重複執行不會出錯', async () => {
    const db = freshDb();
    await db.migrate();
    await expect(db.migrate()).resolves.not.toThrow();
  });

  // 種子資料若不 idempotent，每次啟動都會多長出一組重複類型。
  test('重複執行不會重複種入類型', async () => {
    const db = freshDb();
    await db.migrate();
    await db.migrate();
    const { rows } = await db.query('SELECT code FROM categories');
    expect(rows.length).toBe(new Set(rows.map((r) => r.code)).size);
  });

  test('種入的類型同時涵蓋圖書與教具', async () => {
    const db = freshDb();
    await db.migrate();
    const { rows } = await db.query('SELECT DISTINCT kind FROM categories');
    expect(rows.map((r) => r.kind).sort()).toEqual(['book', 'toy']);
  });

  test('counters 兩種前綴都已備妥且從 0 起算', async () => {
    const db = freshDb();
    await db.migrate();
    const { rows } = await db.query('SELECT kind, last_no FROM counters ORDER BY kind');
    expect(rows).toEqual([{ kind: 'book', last_no: 0 }, { kind: 'toy', last_no: 0 }]);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx jest server/tests/db-migrate.test.js 2>&1`
Expected: FAIL —— 查不到任何資料表

- [ ] **Step 3: 實作 migrate**

改寫 `server/db.js` 的 `migrate()`：

```js
const DDL = [
  `CREATE TABLE IF NOT EXISTS shelves (
     id SERIAL PRIMARY KEY,
     code TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
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
  for (const kind of ['book', 'toy']) {
    await query(`INSERT INTO counters (kind) VALUES ($1) ON CONFLICT (kind) DO NOTHING`, [kind]);
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx jest server/tests/db-migrate.test.js 2>&1`
Expected: PASS，5 個案例全綠

- [ ] **Step 5: 回報 pg-mem 對 partial unique index 的支援度**

看 Step 4 的輸出有沒有 `[migrate] partial unique index 未建立`。

- **有出現** → 在 `.claude/rules/testing.md` 第 2 條補一行實測結論：pg-mem 不支援，Task 8 的「一冊不能借兩次」只能靠應用層檢查覆蓋。
- **沒出現** → 同樣補一行：pg-mem 支援，Task 8 要加一個「直接 INSERT 第二筆未歸還紀錄會被資料庫擋下」的測試。

這一步的產出是**寫進規則檔的一行事實**，不是口頭結論。

- [ ] **Step 6: Commit**

```bash
git add server/db.js server/tests/db-migrate.test.js .claude/rules/testing.md
git commit -m "[DB]: 借還的完整性靠資料庫保證，不能只靠應用層檢查"
```

---

### Task 3: 編號產生

**Files:**
- Create: `server/lib/barcode-no.js`
- Test: `server/tests/barcode-no.test.js`

**Interfaces:**
- Consumes: `db.query`
- Produces: `nextBarcode(kind) → Promise<string>`，`kind` 為 `'book'`／`'toy'`，回傳如 `'B-000001'`

- [ ] **Step 1: 寫失敗測試**

`server/tests/barcode-no.test.js`：

```js
const { newDb } = require('pg-mem');

function freshModules() {
  jest.resetModules();
  const mem = newDb();
  jest.doMock('pg', () => mem.adapters.createPg());
  const db = require('../db.js');
  const { nextBarcode } = require('../lib/barcode-no.js');
  return { db, nextBarcode };
}

describe('nextBarcode', () => {
  test('圖書用 B- 前綴，六位補零', async () => {
    const { db, nextBarcode } = freshModules();
    await db.migrate();
    expect(await nextBarcode('book')).toBe('B-000001');
  });

  test('教具用 T- 前綴', async () => {
    const { db, nextBarcode } = freshModules();
    await db.migrate();
    expect(await nextBarcode('toy')).toBe('T-000001');
  });

  // 兩種流水號各自獨立：共用一個計數器的話，取完 book 再取 toy 會拿到 000002。
  test('圖書與教具的流水號互不干擾', async () => {
    const { db, nextBarcode } = freshModules();
    await db.migrate();
    await nextBarcode('book');
    await nextBarcode('book');
    expect(await nextBarcode('toy')).toBe('T-000001');
    expect(await nextBarcode('book')).toBe('B-000003');
  });

  // 「先 SELECT 再 UPDATE」的寫法在這裡會產生重號。
  test('併發取號不重號', async () => {
    const { db, nextBarcode } = freshModules();
    await db.migrate();
    const got = await Promise.all(Array.from({ length: 20 }, () => nextBarcode('book')));
    expect(new Set(got).size).toBe(20);
  });

  test('未知的 kind 要明確拋錯，不可默默給錯前綴', async () => {
    const { db, nextBarcode } = freshModules();
    await db.migrate();
    await expect(nextBarcode('unknown')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx jest server/tests/barcode-no.test.js 2>&1`
Expected: FAIL —— `Cannot find module '../lib/barcode-no.js'`

- [ ] **Step 3: 實作**

`server/lib/barcode-no.js`：

```js
const db = require('../db.js');

const PREFIX = { book: 'B', toy: 'T' };

/**
 * 取下一個編號。用單一 UPDATE...RETURNING 保證原子性——
 * 拆成「先 SELECT 再 UPDATE」在並行下會產生重號。
 */
async function nextBarcode(kind) {
  const prefix = PREFIX[kind];
  if (!prefix) throw new Error(`未知的館藏種類：${kind}`);
  const { rows } = await db.query(
    'UPDATE counters SET last_no = last_no + 1 WHERE kind = $1 RETURNING last_no',
    [kind]
  );
  if (!rows.length) throw new Error(`counters 缺少 ${kind} 這一列，請重新執行安裝`);
  return `${prefix}-${String(rows[0].last_no).padStart(6, '0')}`;
}

module.exports = { nextBarcode };
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx jest server/tests/barcode-no.test.js 2>&1`
Expected: PASS，5 個案例全綠

- [ ] **Step 5: Commit**

```bash
git add server/lib/barcode-no.js server/tests/barcode-no.test.js
git commit -m "[Barcode]: 編號貼在實體書上就不能改，取號必須原子避免重號"
```

---

### Task 4: 主檔 CRUD（類型／書櫃／借閱人）

**Files:**
- Create: `server/routes/crud.js`, `server/routes/masters.js`
- Modify: `server/index.js`
- Test: `server/tests/masters.test.js`

**Interfaces:**
- Consumes: `db.query`、`createApp`
- Produces: `makeCrudRouter({table, fields, searchFields}) → express.Router`
- Produces: 路由 `/api/categories`、`/api/shelves`、`/api/borrowers`（GET 列表含 `?q=`、POST、PUT `/:id`、DELETE `/:id`）

- [ ] **Step 1: 寫失敗測試**

`server/tests/masters.test.js`：

```js
const request = require('supertest');
const { newDb } = require('pg-mem');

async function freshApp() {
  jest.resetModules();
  const mem = newDb();
  jest.doMock('pg', () => mem.adapters.createPg());
  const db = require('../db.js');
  await db.migrate();
  const { createApp } = require('../index.js');
  return { app: createApp(), db };
}

describe('主檔 CRUD', () => {
  test('借閱人可以新增並讀回', async () => {
    const { app } = await freshApp();
    const created = await request(app)
      .post('/api/borrowers')
      .send({ name: '小明', class_name: '小班' })
      .expect(200);
    expect(created.body.id).toBeGreaterThan(0);

    const list = await request(app).get('/api/borrowers').expect(200);
    expect(list.body.map((b) => b.name)).toContain('小明');
  });

  // 下拉要能搜尋，所以 ?q= 必須真的過濾，不能整包回傳讓前端自己篩。
  test('借閱人可用 ?q= 過濾', async () => {
    const { app } = await freshApp();
    await request(app).post('/api/borrowers').send({ name: '小明' });
    await request(app).post('/api/borrowers').send({ name: '小華' });
    const res = await request(app).get('/api/borrowers?q=華').expect(200);
    expect(res.body.map((b) => b.name)).toEqual(['小華']);
  });

  test('缺必填欄位回 400 而非 500', async () => {
    const { app } = await freshApp();
    await request(app).post('/api/borrowers').send({ class_name: '小班' }).expect(400);
  });

  test('可以修改與刪除', async () => {
    const { app } = await freshApp();
    const { body } = await request(app).post('/api/borrowers').send({ name: '小明' });
    await request(app).put(`/api/borrowers/${body.id}`).send({ name: '大明' }).expect(200);
    const after = await request(app).get('/api/borrowers?q=大明');
    expect(after.body.length).toBe(1);
    await request(app).delete(`/api/borrowers/${body.id}`).expect(200);
    expect((await request(app).get('/api/borrowers')).body.length).toBe(0);
  });

  test('安裝時種入的類型讀得到，且圖書與教具都有', async () => {
    const { app } = await freshApp();
    const res = await request(app).get('/api/categories').expect(200);
    expect(new Set(res.body.map((c) => c.kind))).toEqual(new Set(['book', 'toy']));
  });

  test('書櫃可以建立第二層', async () => {
    const { app } = await freshApp();
    const { body: top } = await request(app).post('/api/shelves').send({ code: 'A', name: 'A櫃' });
    await request(app)
      .post('/api/shelves')
      .send({ code: 'A-2', name: '第2層', parent_id: top.id })
      .expect(200);
    const list = await request(app).get('/api/shelves');
    expect(list.body.find((s) => s.code === 'A-2').parent_id).toBe(top.id);
  });

  // 只允許兩層。掛在第二層底下會讓「櫃 · 層」的顯示邏輯無從組起。
  test('書櫃不可建立第三層', async () => {
    const { app } = await freshApp();
    const { body: top } = await request(app).post('/api/shelves').send({ code: 'A', name: 'A櫃' });
    const { body: mid } = await request(app)
      .post('/api/shelves')
      .send({ code: 'A-2', name: '第2層', parent_id: top.id });
    await request(app)
      .post('/api/shelves')
      .send({ code: 'A-2-1', name: '第3層', parent_id: mid.id })
      .expect(400);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx jest server/tests/masters.test.js 2>&1`
Expected: FAIL —— 404（路由還不存在）

- [ ] **Step 3: 實作共用 CRUD 產生器**

`server/routes/crud.js`：

```js
const express = require('express');
const db = require('../db.js');

/**
 * 產生單一主檔的 CRUD router。
 * @param {{table:string, fields:string[], required:string[], searchFields:string[],
 *          orderBy?:string, beforeWrite?:(body:object, id:number|null)=>Promise<void>}} opts
 */
function makeCrudRouter(opts) {
  const { table, fields, required, searchFields, orderBy = 'id', beforeWrite } = opts;
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const q = (req.query.q ?? '').trim();
      if (!q) {
        const { rows } = await db.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
        return res.json(rows);
      }
      const where = searchFields.map((f, i) => `${f} ILIKE $${i + 1}`).join(' OR ');
      const params = searchFields.map(() => `%${q}%`);
      const { rows } = await db.query(
        `SELECT * FROM ${table} WHERE ${where} ORDER BY ${orderBy}`, params
      );
      res.json(rows);
    } catch (err) { next(err); }
  });

  router.post('/', async (req, res, next) => {
    try {
      for (const f of required) {
        if (req.body[f] === undefined || req.body[f] === null || req.body[f] === '') {
          return res.status(400).json({ error: `缺少必填欄位：${f}` });
        }
      }
      if (beforeWrite) {
        const err = await beforeWrite(req.body, null);
        if (err) return res.status(400).json({ error: err });
      }
      const cols = fields.filter((f) => req.body[f] !== undefined);
      const vals = cols.map((f) => req.body[f]);
      const holes = cols.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await db.query(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${holes}) RETURNING *`, vals
      );
      res.json(rows[0]);
    } catch (err) { next(err); }
  });

  router.put('/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (beforeWrite) {
        const err = await beforeWrite(req.body, id);
        if (err) return res.status(400).json({ error: err });
      }
      const cols = fields.filter((f) => req.body[f] !== undefined);
      if (!cols.length) return res.status(400).json({ error: '沒有要修改的欄位' });
      const sets = cols.map((f, i) => `${f} = $${i + 1}`).join(',');
      const { rows } = await db.query(
        `UPDATE ${table} SET ${sets} WHERE id = $${cols.length + 1} RETURNING *`,
        [...cols.map((f) => req.body[f]), id]
      );
      if (!rows.length) return res.status(404).json({ error: '找不到資料' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      await db.query(`DELETE FROM ${table} WHERE id = $1`, [Number(req.params.id)]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { makeCrudRouter };
```

- [ ] **Step 4: 實作三個主檔**

`server/routes/masters.js`：

```js
const db = require('../db.js');
const { makeCrudRouter } = require('./crud.js');

// 只允許兩層：父層自己必須是頂層。第三層會讓「櫃 · 層」的顯示無從組起。
async function shelfDepthGuard(body) {
  if (!body.parent_id) return null;
  const { rows } = await db.query('SELECT parent_id FROM shelves WHERE id = $1', [body.parent_id]);
  if (!rows.length) return '找不到指定的上層書櫃';
  if (rows[0].parent_id) return '書櫃最多只能兩層（櫃 → 層）';
  return null;
}

const categories = makeCrudRouter({
  table: 'categories',
  fields: ['code', 'name', 'kind', 'sort_order', 'active'],
  required: ['code', 'name', 'kind'],
  searchFields: ['code', 'name'],
  orderBy: 'sort_order, id',
});

const shelves = makeCrudRouter({
  table: 'shelves',
  fields: ['code', 'name', 'parent_id', 'note', 'sort_order', 'active'],
  required: ['code', 'name'],
  searchFields: ['code', 'name'],
  orderBy: 'sort_order, id',
  beforeWrite: shelfDepthGuard,
});

const borrowers = makeCrudRouter({
  table: 'borrowers',
  fields: ['code', 'name', 'class_name', 'note', 'active'],
  required: ['name'],
  searchFields: ['name', 'class_name', 'code'],
  orderBy: 'name',
});

module.exports = { categories, shelves, borrowers };
```

- [ ] **Step 5: 掛上 route 並加錯誤處理**

改 `server/index.js` 的 `createApp()`，在 `express.static` 之後加：

```js
  const masters = require('./routes/masters.js');
  app.use('/api/categories', masters.categories);
  app.use('/api/shelves', masters.shelves);
  app.use('/api/borrowers', masters.borrowers);

  // 統一錯誤處理：不把 stack trace 丟給前端
  app.use((err, req, res, _next) => {
    console.error('[API]', err.message);
    res.status(500).json({ error: '系統錯誤：' + err.message });
  });
```

- [ ] **Step 6: 跑測試確認通過**

Run: `npx jest server/tests/masters.test.js 2>&1`
Expected: PASS，7 個案例全綠

- [ ] **Step 7: 跑全部測試確認沒弄紅既有的**

Run: `npm run test:quiet 2>&1`
Expected: `Tests:` 數字 = Task 1 的基線 + 本次新增

- [ ] **Step 8: Commit**

```bash
git add server/routes server/index.js server/tests/masters.test.js
git commit -m "[Masters]: 三個主檔行為一致，用共用產生器避免三份會各自漂移的 CRUD"
```

---

### Task 5: 離線偵測

**Files:**
- Create: `server/lib/net-status.js`
- Test: `server/tests/net-status.test.js`

**Interfaces:**
- Produces: `isOnline(deps?) → Promise<boolean>`，`deps = {fetchImpl, now}`（可注入以便測試）
- Produces: `markOffline()`、`resetCache()`（`resetCache` 供測試與「重新偵測」按鈕使用）

- [ ] **Step 1: 寫失敗測試**

`server/tests/net-status.test.js`：

```js
describe('isOnline', () => {
  let net;
  beforeEach(() => {
    jest.resetModules();
    net = require('../lib/net-status.js');
    net.resetCache();
  });

  test('探測成功視為線上', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    expect(await net.isOnline({ fetchImpl, now: () => 1000 })).toBe(true);
  });

  test('探測拋錯視為離線，不冒泡', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
    await expect(net.isOnline({ fetchImpl, now: () => 1000 })).resolves.toBe(false);
  });

  // 快取的意義就是「不要每次都等 timeout」。少了它，離線時每一次掃碼都要卡 3 秒。
  test('60 秒內只探測一次', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    await net.isOnline({ fetchImpl, now: () => 1000 });
    await net.isOnline({ fetchImpl, now: () => 30000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('超過 60 秒後會重新探測', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    await net.isOnline({ fetchImpl, now: () => 1000 });
    await net.isOnline({ fetchImpl, now: () => 1000 + 60001 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('markOffline 後在快取期內直接回離線且不再探測', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    net.markOffline(1000);
    expect(await net.isOnline({ fetchImpl, now: () => 5000 })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('探測有 timeout，不會無限等待', async () => {
    const fetchImpl = jest.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const p = net.isOnline({ fetchImpl, now: () => 1000, timeoutMs: 10 });
    await expect(p).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx jest server/tests/net-status.test.js 2>&1`
Expected: FAIL —— `Cannot find module '../lib/net-status.js'`

- [ ] **Step 3: 實作**

`server/lib/net-status.js`：

```js
const TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 3000;
// 探測對象選 OpenLibrary：它是本系統本來就會用的來源，探得通就代表查得到書。
const PROBE_URL = 'https://openlibrary.org/api/books?bibkeys=ISBN:0&format=json';

let cache = { online: null, at: 0 };

function resetCache() {
  cache = { online: null, at: 0 };
}

/** 對外呼叫失敗時由呼叫端主動標記，省下後續每次都等 timeout。 */
function markOffline(at = Date.now()) {
  cache = { online: false, at };
}

/**
 * 是否連得上外網。結果快取 60 秒。
 * 離線時上層必須直接跳過所有網路查詢，不可讓使用者空等。
 */
async function isOnline({ fetchImpl = fetch, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const t = now();
  if (cache.online !== null && t - cache.at < TTL_MS) return cache.online;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let online = false;
  try {
    const res = await fetchImpl(PROBE_URL, { signal: controller.signal });
    online = !!res?.ok;
  } catch {
    online = false;
  } finally {
    clearTimeout(timer);
  }
  cache = { online, at: t };
  return online;
}

module.exports = { isOnline, markOffline, resetCache };
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx jest server/tests/net-status.test.js 2>&1`
Expected: PASS，6 個案例全綠

- [ ] **Step 5: Commit**

```bash
git add server/lib/net-status.js server/tests/net-status.test.js
git commit -m "[Net]: 沒網路是常態不是故障，離線要靜默略過而不是讓使用者等 timeout"
```

---

### Task 6: ISBN 查詢（多來源 fallback）

**Files:**
- Create: `server/lib/isbn/google-books.js`, `server/lib/isbn/ncl.js`, `server/lib/isbn/index.js`, `server/routes/lookup.js`
- Create: `server/tests/fixtures/ncl-sample.html`
- Modify: `server/index.js`
- Test: `server/tests/isbn-lookup.test.js`

**Interfaces:**
- Consumes: `isOnline`（Task 5）、`db.query`
- Produces: `lookupIsbn(isbn, deps) → Promise<BookInfo|null>`
- Produces: `BookInfo = {isbn13, title, subtitle, authors, publisher, published_date, description, coverUrl, source}`
- Produces: 路由 `GET /api/lookup/isbn/:isbn`、`GET /api/net-status`

- [ ] **Step 1: 準備 NCL 的 HTML 樣本**

`server/tests/fixtures/ncl-sample.html` —— 爬蟲測試不打外網，用固定樣本驗證解析邏輯：

```html
<html><body>
<table class="table_data">
  <tr><th>題名</th><td>好餓的毛毛蟲</td></tr>
  <tr><th>作者</th><td>艾瑞．卡爾</td></tr>
  <tr><th>出版者</th><td>上誼文化</td></tr>
  <tr><th>出版日期</th><td>2018/03</td></tr>
  <tr><th>ISBN</th><td>9789577625519</td></tr>
</table>
</body></html>
```

- [ ] **Step 2: 寫失敗測試**

`server/tests/isbn-lookup.test.js`：

```js
const fs = require('fs');
const path = require('path');

const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ncl-sample.html'), 'utf8');

function okJson(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}
function okText(text) {
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });
}

const GOOGLE_HIT = {
  totalItems: 1,
  items: [{
    volumeInfo: {
      title: '好餓的毛毛蟲',
      authors: ['艾瑞．卡爾'],
      publisher: '上誼文化',
      publishedDate: '2018-03',
      description: '一隻毛毛蟲的故事',
      imageLinks: { thumbnail: 'http://books.google.com/cover.jpg' },
    },
  }],
};

describe('google-books provider', () => {
  test('解析出標準格式，作者陣列合併成字串', async () => {
    const { lookup } = require('../lib/isbn/google-books.js');
    const info = await lookup('9789577625519', {
      apiKey: 'k', fetchImpl: () => okJson(GOOGLE_HIT),
    });
    expect(info).toMatchObject({
      title: '好餓的毛毛蟲', authors: '艾瑞．卡爾', publisher: '上誼文化', source: 'google',
    });
    expect(info.coverUrl).toContain('cover.jpg');
  });

  test('查無資料回 null 而不是拋錯', async () => {
    const { lookup } = require('../lib/isbn/google-books.js');
    await expect(lookup('9789577625519', {
      apiKey: 'k', fetchImpl: () => okJson({ totalItems: 0 }),
    })).resolves.toBeNull();
  });

  // 429 是配額爆掉，代表「這個來源現在不能用」，必須讓上層換下一個來源，
  // 不能跟「查無此書」混為一談——後者不該再試別的來源以外的處理。
  test('配額爆掉(429)要拋錯讓上層換來源', async () => {
    const { lookup } = require('../lib/isbn/google-books.js');
    await expect(lookup('9789577625519', {
      apiKey: 'k', fetchImpl: () => Promise.resolve({ ok: false, status: 429 }),
    })).rejects.toThrow();
  });

  test('沒有金鑰時直接回 null，不發請求', async () => {
    const { lookup } = require('../lib/isbn/google-books.js');
    const fetchImpl = jest.fn();
    await expect(lookup('9789577625519', { apiKey: '', fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('ncl provider', () => {
  test('從 HTML 解析出書目', async () => {
    const { lookup } = require('../lib/isbn/ncl.js');
    const info = await lookup('9789577625519', { fetchImpl: () => okText(SAMPLE) });
    expect(info).toMatchObject({
      title: '好餓的毛毛蟲', authors: '艾瑞．卡爾', publisher: '上誼文化', source: 'ncl',
    });
  });

  // 對方改版時 HTML 會完全不同。解析不出來必須當「查無」，絕不可讓例外冒泡炸掉整個查詢。
  test('HTML 格式不符時回 null 而不是拋錯', async () => {
    const { lookup } = require('../lib/isbn/ncl.js');
    await expect(lookup('9789577625519', {
      fetchImpl: () => okText('<html><body>找不到</body></html>'),
    })).resolves.toBeNull();
  });
});

describe('lookupIsbn 協調', () => {
  test('Google 有結果就不再問 NCL', async () => {
    const { lookupIsbn } = require('../lib/isbn/index.js');
    const google = { lookup: jest.fn().mockResolvedValue({ title: 'G', source: 'google' }) };
    const ncl = { lookup: jest.fn() };
    const info = await lookupIsbn('9789577625519', { providers: [google, ncl], apiKey: 'k' });
    expect(info.title).toBe('G');
    expect(ncl.lookup).not.toHaveBeenCalled();
  });

  test('Google 爆掉時換 NCL 接手', async () => {
    const { lookupIsbn } = require('../lib/isbn/index.js');
    const google = { lookup: jest.fn().mockRejectedValue(new Error('429')) };
    const ncl = { lookup: jest.fn().mockResolvedValue({ title: 'N', source: 'ncl' }) };
    const info = await lookupIsbn('9789577625519', { providers: [google, ncl], apiKey: 'k' });
    expect(info.title).toBe('N');
  });

  test('全部來源都失敗時回 null，不拋錯', async () => {
    const { lookupIsbn } = require('../lib/isbn/index.js');
    const bad = { lookup: jest.fn().mockRejectedValue(new Error('boom')) };
    await expect(lookupIsbn('9789577625519', { providers: [bad, bad], apiKey: 'k' }))
      .resolves.toBeNull();
  });
});

describe('GET /api/lookup/isbn/:isbn', () => {
  const request = require('supertest');
  const { newDb } = require('pg-mem');

  async function freshApp() {
    jest.resetModules();
    jest.doMock('pg', () => newDb().adapters.createPg());
    const db = require('../db.js');
    await db.migrate();
    const { createApp } = require('../index.js');
    return { app: createApp(), db };
  }

  test('已建過的 ISBN 直接從本地回，並附上現有冊數', async () => {
    const { app, db } = await freshApp();
    const { rows: [cat] } = await db.query(`SELECT id FROM categories WHERE kind='book' LIMIT 1`);
    const { rows: [t] } = await db.query(
      `INSERT INTO titles (isbn13, title, category_id) VALUES ($1,$2,$3) RETURNING id`,
      ['9789577625519', '好餓的毛毛蟲', cat.id]
    );
    await db.query(`INSERT INTO copies (barcode, title_id) VALUES ('B-000001', $1)`, [t.id]);

    const res = await request(app).get('/api/lookup/isbn/9789577625519').expect(200);
    expect(res.body.found).toBe(true);
    expect(res.body.source).toBe('local');
    expect(res.body.existingCopies).toBe(1);
  });

  // 這是離線需求的核心斷言：不只是「回得快」，而是「完全沒發出請求」。
  test('離線時直接回 online:false，且完全不發網路請求', async () => {
    jest.resetModules();
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    jest.doMock('../lib/net-status.js', () => ({
      isOnline: async () => false, markOffline: () => {}, resetCache: () => {},
    }));
    const { newDb: nd } = require('pg-mem');
    jest.doMock('pg', () => nd().adapters.createPg());
    const db = require('../db.js');
    await db.migrate();
    const { createApp } = require('../index.js');

    const res = await request(createApp()).get('/api/lookup/isbn/9789577625519').expect(200);
    expect(res.body.online).toBe(false);
    expect(res.body.found).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npx jest server/tests/isbn-lookup.test.js 2>&1`
Expected: FAIL —— 找不到模組

- [ ] **Step 4: 實作 google-books provider**

`server/lib/isbn/google-books.js`：

```js
/**
 * Google Books。中文童書涵蓋率最好的來源，但**必須自備 API 金鑰**——
 * 匿名配額是全球共用的，實測會回 429。
 */
async function lookup(isbn, { apiKey, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  if (!apiKey) return null;                       // 沒金鑰就不浪費一次網路往返
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    // 4xx/5xx 一律拋錯，讓上層換下一個來源；與「查得到但沒這本」區分開來。
    if (!res.ok) throw new Error(`Google Books 回應 ${res.status}`);
    const data = await res.json();
    if (!data.totalItems || !data.items?.length) return null;
    const v = data.items[0].volumeInfo ?? {};
    return {
      isbn13: isbn,
      title: v.title ?? '',
      subtitle: v.subtitle ?? null,
      authors: Array.isArray(v.authors) ? v.authors.join('、') : (v.authors ?? null),
      publisher: v.publisher ?? null,
      published_date: v.publishedDate ?? null,
      description: v.description ?? null,
      coverUrl: (v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail ?? '').replace(/^http:/, 'https:') || null,
      source: 'google',
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { lookup, name: 'google' };
```

- [ ] **Step 5: 實作 ncl provider**

`server/lib/isbn/ncl.js`：

```js
/**
 * 台灣 ISBN 全國新書資訊網。**沒有官方 API，靠解析 HTML，對方改版就會壞。**
 * 因此解析不出來一律回 null（視為查無），絕不讓例外冒泡。
 */
const SEARCH_URL = 'https://isbn.ncl.edu.tw/NEW_ISBNNet/main_ProcessMenuItems.php?Pfn=OpenIsbnSearch&isbn=';

function pickField(html, label) {
  const re = new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i');
  const m = html.match(re);
  if (!m) return null;
  const text = m[1].replace(/<[^>]+>/g, '').trim();
  return text || null;
}

async function lookup(isbn, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(SEARCH_URL + encodeURIComponent(isbn), { signal: controller.signal });
    if (!res.ok) throw new Error(`ISBN 網回應 ${res.status}`);
    const html = await res.text();
    const title = pickField(html, '題名');
    if (!title) return null;                      // 版面不符 = 查無，不是錯誤
    return {
      isbn13: isbn,
      title,
      subtitle: null,
      authors: pickField(html, '作者'),
      publisher: pickField(html, '出版者'),
      published_date: pickField(html, '出版日期'),
      description: null,
      coverUrl: null,                             // 此來源沒有封面圖
      source: 'ncl',
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { lookup, name: 'ncl' };
```

- [ ] **Step 6: 實作協調層**

`server/lib/isbn/index.js`：

```js
const google = require('./google-books.js');
const ncl = require('./ncl.js');

const DEFAULT_PROVIDERS = [google, ncl];

/**
 * 依序嘗試各來源，第一個有結果就回。
 * 任一來源拋錯只記 log 換下一個——單一來源壞掉不該讓整個查詢失敗。
 */
async function lookupIsbn(isbn, { providers = DEFAULT_PROVIDERS, apiKey = '', fetchImpl } = {}) {
  for (const p of providers) {
    try {
      const info = await p.lookup(isbn, { apiKey, ...(fetchImpl ? { fetchImpl } : {}) });
      if (info) return info;
    } catch (err) {
      console.warn(`[isbn] ${p.name ?? '來源'} 查詢失敗，改用下一個：${err.message}`);
    }
  }
  return null;
}

module.exports = { lookupIsbn, DEFAULT_PROVIDERS };
```

- [ ] **Step 7: 實作 lookup route**

`server/routes/lookup.js`：

```js
const express = require('express');
const db = require('../db.js');
const net = require('../lib/net-status.js');
const { lookupIsbn } = require('../lib/isbn/index.js');

const router = express.Router();

router.get('/net-status', async (req, res) => {
  res.json({ online: await net.isOnline() });
});

router.get('/lookup/isbn/:isbn', async (req, res, next) => {
  try {
    const isbn = String(req.params.isbn).replace(/[^0-9Xx]/g, '');

    // 1) 本地已建過的書目：離線也查得到，而且能提示「要不要只加冊」
    const local = await db.query(
      `SELECT t.*, (SELECT COUNT(*) FROM copies c WHERE c.title_id = t.id) AS copy_count
         FROM titles t WHERE t.isbn13 = $1`, [isbn]
    );
    if (local.rows.length) {
      const t = local.rows[0];
      return res.json({
        found: true, online: true, source: 'local', titleId: t.id,
        existingCopies: Number(t.copy_count),
        info: {
          isbn13: t.isbn13, title: t.title, subtitle: t.subtitle, authors: t.authors,
          publisher: t.publisher, published_date: t.published_date,
          description: t.description, coverUrl: t.cover_path, source: 'local',
        },
      });
    }

    // 2) 離線：直接回，不發任何請求，也不讓使用者等 timeout
    if (!(await net.isOnline())) {
      return res.json({ found: false, online: false, info: null });
    }

    // 3) 外部來源
    const info = await lookupIsbn(isbn, { apiKey: process.env.GOOGLE_BOOKS_API_KEY ?? '' });
    if (!info) return res.json({ found: false, online: true, info: null });
    res.json({ found: true, online: true, source: info.source, info });
  } catch (err) { next(err); }
});

module.exports = router;
```

- [ ] **Step 8: 掛上 route**

在 `server/index.js` 的 `createApp()` 中，錯誤處理**之前**加：

```js
  app.use('/api', require('./routes/lookup.js'));
```

- [ ] **Step 9: 跑測試確認通過**

Run: `npx jest server/tests/isbn-lookup.test.js 2>&1`
Expected: PASS，11 個案例全綠

- [ ] **Step 10: 跑全部測試**

Run: `npm run test:quiet 2>&1`

- [ ] **Step 11: Commit**

```bash
git add server/lib/isbn server/routes/lookup.js server/index.js server/tests/isbn-lookup.test.js server/tests/fixtures
git commit -m "[ISBN]: 單一來源必壞（實測 Google 匿名配額已爆），查詢要能換手且離線不卡"
```

---

### Task 7: 書目與單冊建檔

**Files:**
- Create: `server/routes/titles.js`, `server/lib/cover.js`
- Modify: `server/index.js`
- Test: `server/tests/titles.test.js`

**Interfaces:**
- Consumes: `nextBarcode`（Task 3）、`db.query`
- Produces: `saveCoverFromUrl(url, isbn, deps) → Promise<string|null>`（回相對路徑）
- Produces: `POST /api/titles`、`POST /api/titles/:id/copies`、`POST /api/titles/:id/cover`、`GET /api/titles`、`GET /api/titles/:id`

- [ ] **Step 1: 寫失敗測試**

`server/tests/titles.test.js`：

```js
const request = require('supertest');
const { newDb } = require('pg-mem');

async function freshApp() {
  jest.resetModules();
  jest.doMock('pg', () => newDb().adapters.createPg());
  jest.doMock('../lib/cover.js', () => ({ saveCoverFromUrl: async () => null }));
  const db = require('../db.js');
  await db.migrate();
  const { createApp } = require('../index.js');
  const { rows } = await db.query(`SELECT id, kind FROM categories ORDER BY sort_order`);
  return {
    app: createApp(), db,
    bookCat: rows.find((r) => r.kind === 'book').id,
    toyCat: rows.find((r) => r.kind === 'toy').id,
  };
}

describe('POST /api/titles', () => {
  test('一次建立書目與指定冊數，回傳每一冊的編號', async () => {
    const { app, bookCat } = await freshApp();
    const res = await request(app).post('/api/titles').send({
      isbn13: '9789577625519', title: '好餓的毛毛蟲', category_id: bookCat, copies: 3,
    }).expect(200);
    expect(res.body.copies).toHaveLength(3);
    expect(res.body.copies.map((c) => c.barcode)).toEqual(['B-000001', 'B-000002', 'B-000003']);
  });

  test('教具沒有 ISBN 也能建，編號用 T- 前綴', async () => {
    const { app, toyCat } = await freshApp();
    const res = await request(app).post('/api/titles').send({
      title: '木製積木組', category_id: toyCat, copies: 1,
    }).expect(200);
    expect(res.body.copies[0].barcode).toBe('T-000001');
    expect(res.body.title.isbn13).toBeNull();
  });

  // 沒指定冊數時預設 1 冊。給 0 冊等於建了一筆借不到的書目。
  test('未指定冊數時建 1 冊', async () => {
    const { app, bookCat } = await freshApp();
    const res = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat }).expect(200);
    expect(res.body.copies).toHaveLength(1);
  });

  test('缺書名回 400', async () => {
    const { app, bookCat } = await freshApp();
    await request(app).post('/api/titles').send({ category_id: bookCat }).expect(400);
  });

  test('同一 ISBN 重複建立時回 409，並附上既有書目 id', async () => {
    const { app, bookCat } = await freshApp();
    await request(app).post('/api/titles')
      .send({ isbn13: '9789577625519', title: 'A', category_id: bookCat });
    const res = await request(app).post('/api/titles')
      .send({ isbn13: '9789577625519', title: 'A', category_id: bookCat }).expect(409);
    expect(res.body.titleId).toBeGreaterThan(0);
  });

  test('建立時可直接指定櫃位，每一冊都套用', async () => {
    const { app, db, bookCat } = await freshApp();
    const { rows: [shelf] } = await db.query(
      `INSERT INTO shelves (code, name) VALUES ('A','A櫃') RETURNING id`
    );
    const res = await request(app).post('/api/titles').send({
      title: '測試書', category_id: bookCat, copies: 2, shelf_id: shelf.id,
    }).expect(200);
    expect(res.body.copies.every((c) => c.shelf_id === shelf.id)).toBe(true);
  });
});

describe('POST /api/titles/:id/copies', () => {
  test('加冊會接續既有編號', async () => {
    const { app, bookCat } = await freshApp();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat, copies: 2 });
    const res = await request(app).post(`/api/titles/${body.title.id}/copies`)
      .send({ copies: 2 }).expect(200);
    expect(res.body.copies.map((c) => c.barcode)).toEqual(['B-000003', 'B-000004']);
  });
});

describe('GET /api/titles', () => {
  test('帶回每個書目的總冊數與在架冊數', async () => {
    const { app, bookCat } = await freshApp();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat, copies: 3 });
    await request(app).get(`/api/titles`);
    const res = await request(app).get('/api/titles').expect(200);
    const row = res.body.find((t) => t.id === body.title.id);
    expect(row.total_copies).toBe(3);
    expect(row.available_copies).toBe(3);
  });

  test('?q= 同時比對書名、作者與 ISBN', async () => {
    const { app, bookCat } = await freshApp();
    await request(app).post('/api/titles')
      .send({ title: '好餓的毛毛蟲', authors: '艾瑞．卡爾', isbn13: '9789577625519', category_id: bookCat });
    await request(app).post('/api/titles').send({ title: '不相干的書', category_id: bookCat });
    expect((await request(app).get('/api/titles?q=毛毛蟲')).body).toHaveLength(1);
    expect((await request(app).get('/api/titles?q=艾瑞')).body).toHaveLength(1);
    expect((await request(app).get('/api/titles?q=9789577625519')).body).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx jest server/tests/titles.test.js 2>&1`
Expected: FAIL —— 404

- [ ] **Step 3: 實作封面下載**

`server/lib/cover.js`：

```js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const COVER_DIR = path.join(ROOT, 'data', 'covers');

/**
 * 下載封面存成本地檔，回傳可放進 cover_path 的相對路徑。
 * 失敗一律回 null——沒有封面只是難看，不該讓建檔失敗。
 */
async function saveCoverFromUrl(url, name, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(COVER_DIR, { recursive: true });
    const file = `${String(name).replace(/[^0-9A-Za-z_-]/g, '')}.jpg`;
    fs.writeFileSync(path.join(COVER_DIR, file), buf);
    return `/covers/${file}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { saveCoverFromUrl, COVER_DIR };
```

- [ ] **Step 4: 實作 titles route**

`server/routes/titles.js`：

```js
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('../db.js');
const { nextBarcode } = require('../lib/barcode-no.js');
const { saveCoverFromUrl, COVER_DIR } = require('../lib/cover.js');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      require('fs').mkdirSync(COVER_DIR, { recursive: true });
      cb(null, COVER_DIR);
    },
    filename: (req, file, cb) => cb(null, `title-${req.params.id}${path.extname(file.originalname) || '.jpg'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

/** 依類型的 kind 決定編號前綴，並建立 n 冊。 */
async function createCopies(titleId, categoryId, n, shelfId) {
  const { rows } = await db.query('SELECT kind FROM categories WHERE id = $1', [categoryId]);
  if (!rows.length) throw new Error('找不到指定的類型');
  const kind = rows[0].kind;
  const out = [];
  for (let i = 0; i < n; i++) {
    const barcode = await nextBarcode(kind);
    const { rows: [copy] } = await db.query(
      `INSERT INTO copies (barcode, title_id, shelf_id) VALUES ($1,$2,$3) RETURNING *`,
      [barcode, titleId, shelfId ?? null]
    );
    out.push(copy);
  }
  return out;
}

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.title) return res.status(400).json({ error: '缺少書名／品名' });
    if (!b.category_id) return res.status(400).json({ error: '缺少類型' });

    const isbn = b.isbn13 ? String(b.isbn13).replace(/[^0-9Xx]/g, '') : null;
    if (isbn) {
      const dup = await db.query('SELECT id FROM titles WHERE isbn13 = $1', [isbn]);
      if (dup.rows.length) {
        return res.status(409).json({
          error: '這本書已經建過了，可以直接加冊', titleId: dup.rows[0].id,
        });
      }
    }

    const coverPath = b.coverUrl ? await saveCoverFromUrl(b.coverUrl, isbn ?? `t${Date.now()}`) : null;

    const { rows: [title] } = await db.query(
      `INSERT INTO titles (isbn13, title, subtitle, authors, publisher, published_date,
                           description, cover_path, category_id, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [isbn, b.title, b.subtitle ?? null, b.authors ?? null, b.publisher ?? null,
       b.published_date ?? null, b.description ?? null, coverPath, b.category_id,
       b.source ?? 'manual']
    );

    const n = Math.max(1, Number(b.copies ?? 1));
    const copies = await createCopies(title.id, b.category_id, n, b.shelf_id);
    res.json({ title, copies });
  } catch (err) { next(err); }
});

router.post('/:id/copies', async (req, res, next) => {
  try {
    const titleId = Number(req.params.id);
    const { rows } = await db.query('SELECT category_id FROM titles WHERE id = $1', [titleId]);
    if (!rows.length) return res.status(404).json({ error: '找不到書目' });
    const n = Math.max(1, Number(req.body.copies ?? 1));
    const copies = await createCopies(titleId, rows[0].category_id, n, req.body.shelf_id);
    res.json({ copies });
  } catch (err) { next(err); }
});

router.post('/:id/cover', upload.single('cover'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '請選擇一張圖片（5MB 以內）' });
    const rel = `/covers/${req.file.filename}`;
    await db.query('UPDATE titles SET cover_path = $1, updated_at = NOW() WHERE id = $2',
      [rel, Number(req.params.id)]);
    res.json({ cover_path: rel });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q ?? '').trim();
    const params = [];
    const where = [];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(t.title ILIKE $${params.length} OR t.authors ILIKE $${params.length}
                   OR t.isbn13 ILIKE $${params.length})`);
    }
    if (req.query.category) { params.push(Number(req.query.category)); where.push(`t.category_id = $${params.length}`); }
    const sql = `
      SELECT t.*, c.name AS category_name, c.kind,
             (SELECT COUNT(*) FROM copies cp WHERE cp.title_id = t.id) AS total_copies,
             (SELECT COUNT(*) FROM copies cp WHERE cp.title_id = t.id AND cp.status = 'in') AS available_copies
        FROM titles t JOIN categories c ON c.id = t.category_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY t.created_at DESC, t.id DESC`;
    const { rows } = await db.query(sql, params);
    res.json(rows.map((r) => ({
      ...r, total_copies: Number(r.total_copies), available_copies: Number(r.available_copies),
    })));
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query(
      `SELECT t.*, c.name AS category_name, c.kind FROM titles t
         JOIN categories c ON c.id = t.category_id WHERE t.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: '找不到書目' });
    const copies = await db.query(
      `SELECT cp.*, s.name AS shelf_name FROM copies cp
         LEFT JOIN shelves s ON s.id = cp.shelf_id
        WHERE cp.title_id = $1 ORDER BY cp.barcode`, [id]);
    res.json({ ...rows[0], copies: copies.rows });
  } catch (err) { next(err); }
});

module.exports = router;
```

- [ ] **Step 5: 補「改單冊櫃位／狀態」的測試**

書搬櫃、書弄丟了都要能改。加進 `server/tests/titles.test.js`：

```js
describe('PUT /api/copies/:id', () => {
  test('可以改單冊的櫃位', async () => {
    const { app, db, bookCat } = await freshApp();
    const { rows: [shelf] } = await db.query(
      `INSERT INTO shelves (code,name) VALUES ('B','B櫃') RETURNING id`);
    const { body } = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat, copies: 1 });
    const res = await request(app).put(`/api/copies/${body.copies[0].id}`)
      .send({ shelf_id: shelf.id }).expect(200);
    expect(res.body.shelf_id).toBe(shelf.id);
  });

  test('可以標記遺失', async () => {
    const { app, bookCat } = await freshApp();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat, copies: 1 });
    const res = await request(app).put(`/api/copies/${body.copies[0].id}`)
      .send({ status: 'lost' }).expect(200);
    expect(res.body.status).toBe('lost');
  });

  // 編號是貼在實體書上的，改了就跟現實對不起來。必須擋。
  test('不可修改編號', async () => {
    const { app, bookCat } = await freshApp();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat, copies: 1 });
    await request(app).put(`/api/copies/${body.copies[0].id}`)
      .send({ barcode: 'B-999999' }).expect(400);
  });

  test('不認得的狀態值要擋下來', async () => {
    const { app, bookCat } = await freshApp();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat, copies: 1 });
    await request(app).put(`/api/copies/${body.copies[0].id}`)
      .send({ status: 'whatever' }).expect(400);
  });
});
```

- [ ] **Step 6: 實作 `server/routes/copies.js`**

```js
const express = require('express');
const db = require('../db.js');

const router = express.Router();
const STATUSES = ['in', 'out', 'lost', 'repair'];

router.put('/:id', async (req, res, next) => {
  try {
    // 編號貼在實體書上，改了就跟現實對不起來——沒有「重新編號」這回事。
    if (req.body.barcode !== undefined) {
      return res.status(400).json({ error: '編號已經貼在書上，不能修改' });
    }
    if (req.body.status !== undefined && !STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: '不認得的狀態' });
    }
    const cols = ['shelf_id', 'status', 'note'].filter((f) => req.body[f] !== undefined);
    if (!cols.length) return res.status(400).json({ error: '沒有要修改的欄位' });
    const sets = cols.map((f, i) => `${f} = $${i + 1}`).join(',');
    const { rows } = await db.query(
      `UPDATE copies SET ${sets} WHERE id = $${cols.length + 1} RETURNING *`,
      [...cols.map((f) => req.body[f]), Number(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: '找不到這一冊' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
```

- [ ] **Step 7: 掛上 route**

`server/index.js` 加：

```js
  app.use('/api/titles', require('./routes/titles.js'));
  app.use('/api/copies', require('./routes/copies.js'));
```

- [ ] **Step 8: 跑測試確認通過**

Run: `npx jest server/tests/titles.test.js 2>&1`
Expected: PASS，13 個案例全綠

- [ ] **Step 9: Commit**

```bash
git add server/routes/titles.js server/routes/copies.js server/lib/cover.js server/index.js server/tests/titles.test.js
git commit -m "[Titles]: 教具沒有 ISBN，建檔流程不能綁死在掃碼上"
```

---

### Task 8: 掃碼借還

**Files:**
- Create: `server/routes/scan.js`, `server/lib/shelf-label.js`
- Modify: `server/index.js`
- Test: `server/tests/scan.test.js`

**Interfaces:**
- Consumes: `db.query`
- Produces: `shelfLabelOf(shelfId) → Promise<string>`（`'A櫃 · 第2層'`／`'尚未指定櫃位'`）
- Produces: `POST /api/scan`、`POST /api/loans`、`POST /api/returns`、`GET /api/loans`

- [ ] **Step 1: 寫失敗測試**

`server/tests/scan.test.js`：

```js
const request = require('supertest');
const { newDb } = require('pg-mem');

async function setup() {
  jest.resetModules();
  jest.doMock('pg', () => newDb().adapters.createPg());
  jest.doMock('../lib/cover.js', () => ({ saveCoverFromUrl: async () => null, COVER_DIR: '/tmp' }));
  const db = require('../db.js');
  await db.migrate();
  const { createApp } = require('../index.js');
  const app = createApp();

  const { rows: [cat] } = await db.query(`SELECT id FROM categories WHERE kind='book' LIMIT 1`);
  const { rows: [top] } = await db.query(`INSERT INTO shelves (code,name) VALUES ('A','A櫃') RETURNING id`);
  const { rows: [lv] } = await db.query(
    `INSERT INTO shelves (code,name,parent_id) VALUES ('A-2','第2層',$1) RETURNING id`, [top.id]);
  const { body } = await request(app).post('/api/titles')
    .send({ title: '好餓的毛毛蟲', category_id: cat.id, copies: 1, shelf_id: lv.id });
  const { rows: [borrower] } = await db.query(
    `INSERT INTO borrowers (name, class_name) VALUES ('小明','小班') RETURNING id`);

  return { app, db, barcode: body.copies[0].barcode, copyId: body.copies[0].id, borrowerId: borrower.id, topId: top.id, lvId: lv.id };
}

describe('POST /api/scan', () => {
  test('在架的冊回 borrow 動作與書名', async () => {
    const { app, barcode } = await setup();
    const res = await request(app).post('/api/scan').send({ barcode }).expect(200);
    expect(res.body.action).toBe('borrow');
    expect(res.body.title.title).toBe('好餓的毛毛蟲');
  });

  // 還書時最重要的資訊就是「放回哪一格」。少了它，這套系統對老師沒有意義。
  test('已借出的冊回 return 動作，並附上完整櫃位字串', async () => {
    const { app, barcode, borrowerId } = await setup();
    await request(app).post('/api/loans').send({ barcode, borrower_id: borrowerId });
    const res = await request(app).post('/api/scan').send({ barcode }).expect(200);
    expect(res.body.action).toBe('return');
    expect(res.body.shelfLabel).toBe('A櫃 · 第2層');
    expect(res.body.borrower.name).toBe('小明');
  });

  test('查無此編號回 404 與白話訊息', async () => {
    const { app } = await setup();
    const res = await request(app).post('/api/scan').send({ barcode: 'B-999999' }).expect(404);
    expect(res.body.error).toContain('找不到');
  });
});

describe('POST /api/loans', () => {
  test('借出後單冊狀態變成 out', async () => {
    const { app, db, barcode, borrowerId } = await setup();
    await request(app).post('/api/loans').send({ barcode, borrower_id: borrowerId }).expect(200);
    const { rows } = await db.query('SELECT status FROM copies WHERE barcode = $1', [barcode]);
    expect(rows[0].status).toBe('out');
  });

  // 這是資料完整性的核心：同一冊被借兩次，系統就再也說不清書在誰手上。
  test('已借出的冊不能再借一次', async () => {
    const { app, barcode, borrowerId } = await setup();
    await request(app).post('/api/loans').send({ barcode, borrower_id: borrowerId });
    const res = await request(app).post('/api/loans').send({ barcode, borrower_id: borrowerId }).expect(409);
    expect(res.body.error).toContain('已經借出');
  });

  test('沒有借閱人不能借出', async () => {
    const { app, barcode } = await setup();
    await request(app).post('/api/loans').send({ barcode }).expect(400);
  });
});

describe('POST /api/returns', () => {
  test('歸還後狀態回 in，並回傳要放回的櫃位', async () => {
    const { app, db, barcode, borrowerId } = await setup();
    await request(app).post('/api/loans').send({ barcode, borrower_id: borrowerId });
    const res = await request(app).post('/api/returns').send({ barcode }).expect(200);
    expect(res.body.shelfLabel).toBe('A櫃 · 第2層');
    const { rows } = await db.query('SELECT status FROM copies WHERE barcode = $1', [barcode]);
    expect(rows[0].status).toBe('in');
  });

  test('沒借出的冊不能歸還', async () => {
    const { app, barcode } = await setup();
    await request(app).post('/api/returns').send({ barcode }).expect(409);
  });

  // 沒設櫃位時必須講清楚，不能回空字串讓畫面顯示「請放回：」
  test('未指定櫃位時回明確字樣', async () => {
    const { app, db, borrowerId } = await setup();
    const { rows: [cat] } = await db.query(`SELECT id FROM categories WHERE kind='book' LIMIT 1`);
    const { body } = await request(app).post('/api/titles')
      .send({ title: '沒櫃位的書', category_id: cat.id, copies: 1 });
    const bc = body.copies[0].barcode;
    await request(app).post('/api/loans').send({ barcode: bc, borrower_id: borrowerId });
    const res = await request(app).post('/api/returns').send({ barcode: bc }).expect(200);
    expect(res.body.shelfLabel).toBe('尚未指定櫃位');
  });
});

describe('GET /api/loans', () => {
  test('?open=1 只回未歸還的', async () => {
    const { app, barcode, borrowerId } = await setup();
    await request(app).post('/api/loans').send({ barcode, borrower_id: borrowerId });
    expect((await request(app).get('/api/loans?open=1')).body).toHaveLength(1);
    await request(app).post('/api/returns').send({ barcode });
    expect((await request(app).get('/api/loans?open=1')).body).toHaveLength(0);
    expect((await request(app).get('/api/loans')).body).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx jest server/tests/scan.test.js 2>&1`
Expected: FAIL —— 404

- [ ] **Step 3: 實作櫃位字串**

`server/lib/shelf-label.js`：

```js
const db = require('../db.js');

const UNSET = '尚未指定櫃位';

/**
 * 組出「A櫃 · 第2層」。這是老師還書時唯一要看的資訊，
 * 沒設櫃位時要明確講出來，不可回空字串（畫面會變成「請放回：」）。
 */
async function shelfLabelOf(shelfId) {
  if (!shelfId) return UNSET;
  const { rows } = await db.query('SELECT id, name, parent_id FROM shelves WHERE id = $1', [shelfId]);
  if (!rows.length) return UNSET;
  const self = rows[0];
  if (!self.parent_id) return self.name;
  const parent = await db.query('SELECT name FROM shelves WHERE id = $1', [self.parent_id]);
  return parent.rows.length ? `${parent.rows[0].name} · ${self.name}` : self.name;
}

module.exports = { shelfLabelOf, UNSET };
```

- [ ] **Step 4: 實作 scan route**

`server/routes/scan.js`：

```js
const express = require('express');
const db = require('../db.js');
const { shelfLabelOf } = require('../lib/shelf-label.js');

const router = express.Router();

async function findCopy(barcode) {
  const { rows } = await db.query(
    `SELECT cp.*, t.title, t.authors, t.cover_path, t.isbn13
       FROM copies cp JOIN titles t ON t.id = cp.title_id
      WHERE cp.barcode = $1`, [String(barcode ?? '').trim()]
  );
  return rows[0] ?? null;
}

async function openLoanOf(copyId) {
  const { rows } = await db.query(
    `SELECT l.*, b.name AS borrower_name, b.class_name
       FROM loans l JOIN borrowers b ON b.id = l.borrower_id
      WHERE l.copy_id = $1 AND l.returned_at IS NULL
      ORDER BY l.id DESC LIMIT 1`, [copyId]
  );
  return rows[0] ?? null;
}

router.post('/scan', async (req, res, next) => {
  try {
    const copy = await findCopy(req.body.barcode);
    if (!copy) return res.status(404).json({ error: '找不到這個編號，請確認條碼是否正確' });

    const shelfLabel = await shelfLabelOf(copy.shelf_id);
    const base = {
      copy: { id: copy.id, barcode: copy.barcode, status: copy.status, shelf_id: copy.shelf_id },
      title: { title: copy.title, authors: copy.authors, cover_path: copy.cover_path, isbn13: copy.isbn13 },
      shelfLabel,
    };

    if (copy.status === 'out') {
      const loan = await openLoanOf(copy.id);
      return res.json({
        ...base, action: 'return',
        borrower: loan ? { id: loan.borrower_id, name: loan.borrower_name, class_name: loan.class_name } : null,
        borrowed_at: loan?.borrowed_at ?? null,
      });
    }
    if (copy.status !== 'in') {
      return res.json({ ...base, action: 'blocked',
        message: copy.status === 'lost' ? '這一冊被標記為遺失' : '這一冊正在修繕中' });
    }
    res.json({ ...base, action: 'borrow' });
  } catch (err) { next(err); }
});

router.post('/loans', async (req, res, next) => {
  try {
    const copy = req.body.barcode
      ? await findCopy(req.body.barcode)
      : (await db.query('SELECT * FROM copies WHERE id = $1', [Number(req.body.copy_id)])).rows[0];
    if (!copy) return res.status(404).json({ error: '找不到這一冊' });
    if (!req.body.borrower_id) return res.status(400).json({ error: '請先選擇借閱人' });
    if (copy.status === 'out') return res.status(409).json({ error: '這一冊已經借出了' });
    if (copy.status !== 'in') return res.status(409).json({ error: '這一冊目前不可外借' });

    // 應用層先擋一次；資料庫的 loans_one_open_per_copy 是最後防線。
    if (await openLoanOf(copy.id)) return res.status(409).json({ error: '這一冊已經借出了' });

    const { rows: [loan] } = await db.query(
      `INSERT INTO loans (copy_id, borrower_id) VALUES ($1,$2) RETURNING *`,
      [copy.id, Number(req.body.borrower_id)]
    );
    await db.query(`UPDATE copies SET status = 'out' WHERE id = $1`, [copy.id]);
    res.json({ loan, shelfLabel: await shelfLabelOf(copy.shelf_id) });
  } catch (err) { next(err); }
});

router.post('/returns', async (req, res, next) => {
  try {
    const copy = await findCopy(req.body.barcode);
    if (!copy) return res.status(404).json({ error: '找不到這個編號' });
    const loan = await openLoanOf(copy.id);
    if (!loan) return res.status(409).json({ error: '這一冊沒有借出中的紀錄' });

    const shelfLabel = await shelfLabelOf(copy.shelf_id);
    await db.query(
      `UPDATE loans SET returned_at = NOW(), return_shelf_id = $1 WHERE id = $2`,
      [copy.shelf_id ?? null, loan.id]
    );
    await db.query(`UPDATE copies SET status = 'in' WHERE id = $1`, [copy.id]);
    res.json({
      shelfLabel,
      title: { title: copy.title, cover_path: copy.cover_path },
      borrower: { name: loan.borrower_name, class_name: loan.class_name },
    });
  } catch (err) { next(err); }
});

router.get('/loans', async (req, res, next) => {
  try {
    const where = req.query.open === '1' ? 'WHERE l.returned_at IS NULL' : '';
    const { rows } = await db.query(`
      SELECT l.*, cp.barcode, t.title, b.name AS borrower_name, b.class_name
        FROM loans l
        JOIN copies cp ON cp.id = l.copy_id
        JOIN titles t ON t.id = cp.title_id
        JOIN borrowers b ON b.id = l.borrower_id
      ${where}
       ORDER BY l.borrowed_at DESC, l.id DESC`);
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
```

- [ ] **Step 5: 掛上 route**

`server/index.js` 加：`app.use('/api', require('./routes/scan.js'));`

- [ ] **Step 6: 跑測試確認通過**

Run: `npx jest server/tests/scan.test.js 2>&1`
Expected: PASS，10 個案例全綠

- [ ] **Step 7: 若 Task 2 測出 pg-mem 支援 partial unique index，補一支資料庫層測試**

只有在 Task 2 Step 5 確認支援時才加。直接繞過 API 塞第二筆未歸還紀錄，驗證資料庫會擋：

```js
test('資料庫層擋下重複的未歸還紀錄', async () => {
  const { db, copyId, borrowerId } = await setup();
  await db.query('INSERT INTO loans (copy_id, borrower_id) VALUES ($1,$2)', [copyId, borrowerId]);
  await expect(
    db.query('INSERT INTO loans (copy_id, borrower_id) VALUES ($1,$2)', [copyId, borrowerId])
  ).rejects.toThrow();
});
```

- [ ] **Step 8: Commit**

```bash
git add server/routes/scan.js server/lib/shelf-label.js server/index.js server/tests/scan.test.js
git commit -m "[Scan]: 還書時老師只需要知道放回哪一格，這是整套系統的核心產出"
```

---

### Task 9: 全站搜尋自動完成

**Files:**
- Create: `server/routes/search.js`
- Modify: `server/index.js`
- Test: `server/tests/search.test.js`

**Interfaces:**
- Produces: `GET /api/search/suggest?q=` → `{groups: [{type, label, items: [{id, title, subtitle, href}]}]}`

- [ ] **Step 1: 寫失敗測試**

`server/tests/search.test.js`：

```js
const request = require('supertest');
const { newDb } = require('pg-mem');

async function setup() {
  jest.resetModules();
  jest.doMock('pg', () => newDb().adapters.createPg());
  jest.doMock('../lib/cover.js', () => ({ saveCoverFromUrl: async () => null, COVER_DIR: '/tmp' }));
  const db = require('../db.js');
  await db.migrate();
  const { createApp } = require('../index.js');
  const app = createApp();
  const { rows: [cat] } = await db.query(`SELECT id FROM categories WHERE kind='book' LIMIT 1`);
  await db.query(`INSERT INTO shelves (code,name) VALUES ('MAO','毛毛櫃')`);
  await db.query(`INSERT INTO borrowers (name,class_name) VALUES ('毛毛','小班')`);
  const { body } = await request(app).post('/api/titles')
    .send({ title: '好餓的毛毛蟲', category_id: cat.id, copies: 1 });
  return { app, db, barcode: body.copies[0].barcode };
}

describe('GET /api/search/suggest', () => {
  test('同一個關鍵字同時命中書目、借閱人與書櫃', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api/search/suggest?q=毛毛').expect(200);
    const types = res.body.groups.filter((g) => g.items.length).map((g) => g.type);
    expect(types).toEqual(expect.arrayContaining(['title', 'borrower', 'shelf']));
  });

  test('用編號搜得到單冊', async () => {
    const { app, barcode } = await setup();
    const res = await request(app).get(`/api/search/suggest?q=${barcode}`).expect(200);
    const copies = res.body.groups.find((g) => g.type === 'copy');
    expect(copies.items[0].title).toBe(barcode);
  });

  test('每一類最多 5 筆', async () => {
    const { app, db } = await setup();
    for (let i = 0; i < 8; i++) {
      await db.query(`INSERT INTO borrowers (name) VALUES ($1)`, [`毛毛${i}`]);
    }
    const res = await request(app).get('/api/search/suggest?q=毛毛').expect(200);
    expect(res.body.groups.find((g) => g.type === 'borrower').items.length).toBe(5);
  });

  // 空字串若不擋，會把整個資料庫撈出來當建議清單。
  test('空關鍵字回空結果，不撈全表', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api/search/suggest?q=').expect(200);
    expect(res.body.groups.every((g) => g.items.length === 0)).toBe(true);
  });

  test('每一筆都帶可跳轉的 href', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api/search/suggest?q=毛毛').expect(200);
    const all = res.body.groups.flatMap((g) => g.items);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((i) => typeof i.href === 'string' && i.href.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx jest server/tests/search.test.js 2>&1`
Expected: FAIL —— 404

- [ ] **Step 3: 實作**

`server/routes/search.js`：

```js
const express = require('express');
const db = require('../db.js');

const router = express.Router();
const LIMIT = 5;

// 資料量在幾千筆等級，ILIKE 完全足夠；不上 pg_trgm 以免多一個 extension 依賴。
router.get('/search/suggest', async (req, res, next) => {
  try {
    const q = (req.query.q ?? '').trim();
    const empty = [
      { type: 'title', label: '書目', items: [] },
      { type: 'copy', label: '單冊編號', items: [] },
      { type: 'borrower', label: '借閱人', items: [] },
      { type: 'shelf', label: '書櫃', items: [] },
    ];
    if (!q) return res.json({ groups: empty });

    const like = `%${q}%`;
    const [titles, copies, borrowers, shelves] = await Promise.all([
      db.query(
        `SELECT id, title, authors, isbn13 FROM titles
          WHERE title ILIKE $1 OR authors ILIKE $1 OR isbn13 ILIKE $1
          ORDER BY title LIMIT ${LIMIT}`, [like]),
      db.query(
        `SELECT cp.id, cp.barcode, cp.status, t.title FROM copies cp
           JOIN titles t ON t.id = cp.title_id
          WHERE cp.barcode ILIKE $1 ORDER BY cp.barcode LIMIT ${LIMIT}`, [like]),
      db.query(
        `SELECT id, name, class_name FROM borrowers
          WHERE name ILIKE $1 OR class_name ILIKE $1 OR code ILIKE $1
          ORDER BY name LIMIT ${LIMIT}`, [like]),
      db.query(
        `SELECT id, code, name FROM shelves
          WHERE name ILIKE $1 OR code ILIKE $1 ORDER BY name LIMIT ${LIMIT}`, [like]),
    ]);

    res.json({ groups: [
      { type: 'title', label: '書目', items: titles.rows.map((r) => ({
        id: r.id, title: r.title, subtitle: [r.authors, r.isbn13].filter(Boolean).join(' · '),
        href: `/catalog.html?title=${r.id}` })) },
      { type: 'copy', label: '單冊編號', items: copies.rows.map((r) => ({
        id: r.id, title: r.barcode, subtitle: `${r.title}（${r.status === 'in' ? '在架' : '借出中'}）`,
        href: `/index.html?barcode=${encodeURIComponent(r.barcode)}` })) },
      { type: 'borrower', label: '借閱人', items: borrowers.rows.map((r) => ({
        id: r.id, title: r.name, subtitle: r.class_name ?? '',
        href: `/borrowers.html?id=${r.id}` })) },
      { type: 'shelf', label: '書櫃', items: shelves.rows.map((r) => ({
        id: r.id, title: r.name, subtitle: r.code,
        href: `/shelves.html?id=${r.id}` })) },
    ] });
  } catch (err) { next(err); }
});

module.exports = router;
```

- [ ] **Step 4: 掛上 route**

`server/index.js` 加：`app.use('/api', require('./routes/search.js'));`

- [ ] **Step 5: 跑測試確認通過**

Run: `npx jest server/tests/search.test.js 2>&1`
Expected: PASS，5 個案例全綠

- [ ] **Step 6: 跑全部測試**

Run: `npm run test:quiet 2>&1`
Expected: 全綠。後端到此完成。

- [ ] **Step 7: Commit**

```bash
git add server/routes/search.js server/index.js server/tests/search.test.js
git commit -m "[Search]: 老師記得書名記不得編號，搜尋要四類一起找"
```

---

### Task 10: 前端共用元件

前端沒有自動化測試（見 `.claude/rules/frontend.md` 第 1 條），本 task 的驗收全靠瀏覽器人工實測。

**Files:**
- Create: `public/css/app.css`, `public/js/app.js`, `public/js/barcode.js`, `public/js/scan-input.js`, `public/js/omnisearch.js`

**Interfaces:**
- Produces: `Api.get(url)`、`Api.post(url, body)`、`Api.put(url, body)`、`Api.del(url)`（皆回 Promise，非 2xx 會 throw 帶 `message`）
- Produces: `showToast(message, type)`，`type` 為 `'ok'`／`'error'`
- Produces: `renderCode39(text) → SVGElement`
- Produces: `createScanInput({onScan, cameraButton}) → {focus()}`
- Produces: `createOmniSearch(inputEl, panelEl)`

- [ ] **Step 1: 寫 `public/css/app.css`**

顏色一律走變數，深色模式靠 `prefers-color-scheme` —— 寫死淺色會在深色模式變成刺眼白塊。

```css
:root {
  --bg: #f7f7f8; --card: #ffffff; --text: #1a1a1a; --muted: #666;
  --border: #ddd; --accent: #2563eb; --ok: #16a34a; --danger: #dc2626;
  --shelf-bg: #fef3c7; --shelf-text: #92400e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181c; --card: #1f2227; --text: #e8e8ea; --muted: #9aa0a6;
    --border: #33363c; --accent: #60a5fa; --ok: #4ade80; --danger: #f87171;
    --shelf-bg: #422006; --shelf-text: #fcd34d;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font-family: "Microsoft JhengHei", system-ui, sans-serif;
       background: var(--bg); color: var(--text); }
nav { display: flex; gap: 4px; padding: 8px 16px; background: var(--card);
      border-bottom: 1px solid var(--border); align-items: center; flex-wrap: wrap; }
nav a { padding: 8px 14px; border-radius: 8px; text-decoration: none; color: var(--text); }
nav a.active, nav a:hover { background: var(--accent); color: #fff; }
main { padding: 16px; max-width: 1100px; margin: 0 auto; }
.card { background: var(--card); border: 1px solid var(--border);
        border-radius: 12px; padding: 16px; margin-bottom: 16px; }
button { font: inherit; padding: 10px 18px; border-radius: 8px; cursor: pointer;
         border: 1px solid var(--border); background: var(--card); color: var(--text); }
button.primary { background: var(--accent); color: #fff; border-color: transparent; }
button.danger { background: var(--danger); color: #fff; border-color: transparent; }
input, select, textarea { font: inherit; padding: 10px; border-radius: 8px;
         border: 1px solid var(--border); background: var(--card); color: var(--text); width: 100%; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px; border-bottom: 1px solid var(--border); }
.muted { color: var(--muted); }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }

/* 掃碼輸入：老師站著操作，字要夠大 */
.scan-box input { font-size: 24px; padding: 16px; }

/* 還書時「請放回哪一格」是畫面上最重要的資訊 */
.shelf-banner { background: var(--shelf-bg); color: var(--shelf-text);
  font-size: 42px; font-weight: 700; padding: 28px; border-radius: 14px;
  text-align: center; margin: 16px 0; }

.badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 13px; }
.badge-in { background: var(--ok); color: #fff; }
.badge-out { background: var(--danger); color: #fff; }
.net-badge { margin-left: auto; font-size: 13px; padding: 6px 12px;
  border-radius: 999px; border: 1px solid var(--border); }
.net-badge.offline { background: var(--danger); color: #fff; border-color: transparent; }

#toast { position: fixed; right: 16px; bottom: 16px; display: flex;
  flex-direction: column; gap: 8px; z-index: 50; }
#toast div { padding: 12px 18px; border-radius: 8px; color: #fff; background: var(--ok); }
#toast div.error { background: var(--danger); }

/* 全站搜尋建議面板 */
.omni { position: relative; flex: 1; min-width: 240px; }
.omni-panel { position: absolute; top: 100%; left: 0; right: 0; z-index: 40;
  background: var(--card); border: 1px solid var(--border); border-radius: 10px;
  max-height: 380px; overflow-y: auto; display: none; }
.omni-panel.open { display: block; }
.omni-group { padding: 6px 12px; font-size: 12px; color: var(--muted);
  border-bottom: 1px solid var(--border); }
.omni-item { padding: 10px 12px; cursor: pointer; }
.omni-item.active, .omni-item:hover { background: var(--accent); color: #fff; }
.omni-item small { display: block; opacity: .75; }
@media print { nav, .no-print { display: none !important; } }
```

- [ ] **Step 2: 寫 `public/js/app.js`**

```js
async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error ?? `發生錯誤（${res.status}）`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

const Api = {
  get: (url) => req('GET', url),
  post: (url, body) => req('POST', url, body),
  put: (url, body) => req('PUT', url, body),
  del: (url) => req('DELETE', url),
};

function showToast(message, type = 'ok') {
  let host = document.getElementById('toast');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.textContent = message;
  if (type === 'error') el.className = 'error';
  host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/** 每頁右上的離線徽章。離線時要講清楚影響範圍，不能只顯示一個紅點。 */
async function mountNetBadge() {
  const el = document.querySelector('.net-badge');
  if (!el) return;
  const paint = (online) => {
    el.classList.toggle('offline', !online);
    el.textContent = online ? '🟢 已連線' : '🔴 離線 · 自動補資料已停用（借還書不受影響）';
  };
  const check = async () => {
    try { paint((await Api.get('/api/net-status')).online); }
    catch { paint(false); }
  };
  el.title = '點一下重新偵測';
  el.addEventListener('click', check);
  await check();
}

document.addEventListener('DOMContentLoaded', mountNetBadge);
```

- [ ] **Step 3: 寫 `public/js/barcode.js`（Code39）**

選 Code39 而非 Code128：編碼表小、掃碼槍普遍支援，`B-000001` 的字元全在其字集內。

```js
// Code39：每個字元 9 個元素（5 條 4 空），n=窄 w=寬。前後必須加 * 當起訖符。
const CODE39 = {
  '0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw',
  '5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn',
  'A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn',
  'F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn',
  'K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn',
  'P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn',
  'U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn',
  'Z':'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','$':'nwnwnwnnn',
  '/':'nwnwnnnwn','+':'nwnnnwnwn','%':'nnnwnwnwn','*':'nwnnwnwnn',
};

const NARROW = 2, WIDE = 5, HEIGHT = 60;

/** 產生 Code39 條碼 SVG。text 會轉大寫；不支援的字元會拋錯。 */
function renderCode39(text) {
  const chars = ('*' + String(text).toUpperCase() + '*').split('');
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  let x = 0;
  for (const ch of chars) {
    const pattern = CODE39[ch];
    if (!pattern) throw new Error(`條碼不支援這個字元：${ch}`);
    for (let i = 0; i < pattern.length; i++) {
      const w = pattern[i] === 'w' ? WIDE : NARROW;
      if (i % 2 === 0) {                       // 偶數位是黑條，奇數位是空白
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', x); rect.setAttribute('y', 0);
        rect.setAttribute('width', w); rect.setAttribute('height', HEIGHT);
        rect.setAttribute('fill', '#000');
        svg.appendChild(rect);
      }
      x += w;
    }
    x += NARROW;                                // 字元間隔
  }
  svg.setAttribute('width', x);
  svg.setAttribute('height', HEIGHT);
  svg.setAttribute('viewBox', `0 0 ${x} ${HEIGHT}`);
  svg.style.background = '#fff';                // 條碼底色必須是白的，深色模式也一樣
  return svg;
}
```

- [ ] **Step 4: 寫 `public/js/scan-input.js`**

掃碼槍是模擬鍵盤的，**輸入框失焦就掃不進去**；但也不能在使用者正在填別的欄位時把焦點搶走。

```js
/**
 * 掃碼輸入。掃碼槍為主（鍵盤 + Enter），鏡頭為備援。
 * @param {{input:HTMLInputElement, onScan:(code:string)=>void, cameraButton?:HTMLButtonElement,
 *          video?:HTMLVideoElement}} opts
 */
function createScanInput({ input, onScan, cameraButton, video }) {
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = input.value.trim();
    if (!code) return;
    input.value = '';
    onScan(code);
  });

  // 點到頁面空白處後把焦點搶回來，但使用者正在填其他欄位時不動它。
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.matches('input, select, textarea, button, a, .omni-item')) return;
    input.focus();
  });

  // 鏡頭備援：失敗一律靜默退回掃碼槍，不可跳錯誤中斷作業。
  if (cameraButton && video) {
    cameraButton.addEventListener('click', async () => {
      if (!('BarcodeDetector' in window)) {
        showToast('這個瀏覽器不支援鏡頭掃碼，請用掃碼槍', 'error');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = stream;
        video.hidden = false;
        await video.play();
        const detector = new BarcodeDetector({ formats: ['ean_13', 'code_39', 'code_128'] });
        const stop = () => {
          stream.getTracks().forEach((t) => t.stop());
          video.hidden = true;
        };
        const tick = async () => {
          if (video.hidden) return;
          try {
            const found = await detector.detect(video);
            if (found.length) { stop(); onScan(found[0].rawValue); return; }
          } catch { /* 單張辨識失敗就繼續下一張 */ }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setTimeout(() => { if (!video.hidden) { stop(); showToast('鏡頭沒掃到，請改用掃碼槍'); } }, 30000);
      } catch {
        showToast('無法開啟鏡頭，請用掃碼槍', 'error');
      }
    });
  }

  input.focus();
  return { focus: () => input.focus() };
}
```

- [ ] **Step 5: 寫 `public/js/omnisearch.js`**

**Enter 鍵要小心**：掃碼槍也會送 Enter，所以建議面板沒開時 Enter 不可誤觸任何項目。

```js
/** 全站搜尋自動完成。debounce 200ms，方向鍵選、Enter 進、Esc 關。 */
function createOmniSearch(input, panel) {
  let timer = null;
  let items = [];
  let active = -1;

  const close = () => { panel.classList.remove('open'); active = -1; items = []; };

  const paint = (groups) => {
    panel.innerHTML = '';
    items = [];
    for (const g of groups) {
      if (!g.items.length) continue;
      const head = document.createElement('div');
      head.className = 'omni-group';
      head.textContent = g.label;
      panel.appendChild(head);
      for (const it of g.items) {
        const el = document.createElement('div');
        el.className = 'omni-item';
        el.innerHTML = `${escapeHtml(it.title)}<small>${escapeHtml(it.subtitle ?? '')}</small>`;
        el.addEventListener('click', () => { location.href = it.href; });
        panel.appendChild(el);
        items.push({ el, href: it.href });
      }
    }
    panel.classList.toggle('open', items.length > 0);
  };

  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const highlight = () => items.forEach((it, i) => it.el.classList.toggle('active', i === active));

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { close(); return; }
    timer = setTimeout(async () => {
      try { paint((await Api.get(`/api/search/suggest?q=${encodeURIComponent(q)}`)).groups); }
      catch { close(); }
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    if (!panel.classList.contains('open')) return;   // 面板沒開時完全不攔按鍵
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); location.href = items[active].href; }
    else if (e.key === 'Escape') { close(); }
  });

  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== input) close();
  });
}
```

- [ ] **Step 6: 人工驗收**

暫時把這些檔掛進 `public/index.html` 驗證：

1. `showToast('測試')` 能顯示、3 秒後消失。
2. `document.body.appendChild(renderCode39('B-000001'))` 畫得出條碼。
3. **用實體掃碼槍掃這個畫出來的條碼**，確認讀到 `B-000001`。**這一步不可省** —— 條碼編碼表錯了畫面上看起來仍然正常，只有掃了才知道。
4. 切換系統深色／淺色模式，確認沒有刺眼白塊、文字都看得清楚。

- [ ] **Step 7: Commit**

```bash
git add public/css public/js
git commit -m "[UI]: 掃碼槍失焦就掃不進去，輸入焦點要自己搶回來"
```

---

### Task 11: 借還台與館藏頁

**Files:**
- Modify: `public/index.html`
- Create: `public/catalog.html`, `public/js/page-scan.js`, `public/js/page-catalog.js`

- [ ] **Step 1: 寫共用的導覽列片段**

每一頁的 `<nav>` 都用這段（含全站搜尋與離線徽章）：

```html
<nav>
  <a href="/index.html">借還台</a>
  <a href="/catalog.html">館藏</a>
  <a href="/shelves.html">書櫃</a>
  <a href="/borrowers.html">借閱人</a>
  <a href="/loans.html">借閱紀錄</a>
  <span class="omni">
    <input id="omni" placeholder="搜尋書名、作者、編號、借閱人、書櫃…" autocomplete="off">
    <div class="omni-panel" id="omniPanel"></div>
  </span>
  <span class="net-badge">偵測中…</span>
</nav>
```

- [ ] **Step 2: 寫 `public/index.html`（借還台）**

```html
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>借還台 · 圖書管理系統</title>
  <link rel="stylesheet" href="/css/app.css">
</head>
<body>
  <!-- 這裡貼上 Step 1 的 nav，並把 index.html 那個 a 加上 class="active" -->
  <main>
    <div class="card scan-box">
      <div class="row">
        <input id="scan" placeholder="掃描書本上的編號（或直接輸入後按 Enter）" autocomplete="off">
        <button id="camera" class="no-print">📷 用鏡頭掃</button>
      </div>
      <video id="video" hidden playsinline style="width:100%;max-width:420px;margin-top:12px"></video>
    </div>
    <div id="result"></div>
    <div class="card">
      <h3>目前外借中</h3>
      <table><tbody id="openLoans"></tbody></table>
    </div>
  </main>
  <script src="/js/app.js"></script>
  <script src="/js/omnisearch.js"></script>
  <script src="/js/scan-input.js"></script>
  <script src="/js/page-scan.js"></script>
</body>
</html>
```

- [ ] **Step 3: 寫 `public/js/page-scan.js`**

掃到「已借出」時，**櫃位是畫面上最大的元素** —— 那是老師唯一需要的資訊。

```js
const resultEl = document.getElementById('result');

async function loadOpenLoans() {
  const rows = await Api.get('/api/loans?open=1');
  document.getElementById('openLoans').innerHTML = rows.length
    ? rows.map((r) => `<tr><td>${r.barcode}</td><td>${r.title}</td>
        <td>${r.borrower_name}${r.class_name ? '（' + r.class_name + '）' : ''}</td>
        <td class="muted">${new Date(r.borrowed_at).toLocaleDateString('zh-TW')}</td></tr>`).join('')
    : '<tr><td class="muted">目前沒有外借中的書</td></tr>';
}

async function renderBorrow(data) {
  const borrowers = await Api.get('/api/borrowers');
  resultEl.innerHTML = `
    <div class="card">
      <h2>${data.title.title} <span class="badge badge-in">在架</span></h2>
      <p class="muted">${data.copy.barcode}　${data.title.authors ?? ''}</p>
      <div class="row">
        <select id="borrower">
          <option value="">請選擇借閱人…</option>
          ${borrowers.map((b) => `<option value="${b.id}">${b.name}${b.class_name ? '（' + b.class_name + '）' : ''}</option>`).join('')}
        </select>
        <button class="primary" id="doBorrow">確認借出</button>
      </div>
    </div>`;
  document.getElementById('doBorrow').addEventListener('click', async () => {
    const borrowerId = document.getElementById('borrower').value;
    if (!borrowerId) return showToast('請先選擇借閱人', 'error');
    try {
      await Api.post('/api/loans', { barcode: data.copy.barcode, borrower_id: Number(borrowerId) });
      showToast('借出成功');
      resultEl.innerHTML = '';
      loadOpenLoans();
      document.getElementById('scan').focus();
    } catch (err) { showToast(err.message, 'error'); }
  });
}

function renderReturn(data) {
  resultEl.innerHTML = `
    <div class="card">
      <h2>${data.title.title} <span class="badge badge-out">借出中</span></h2>
      <p class="muted">${data.copy.barcode}　借閱人：${data.borrower?.name ?? '未知'}</p>
      <div class="shelf-banner">請放回：${data.shelfLabel}</div>
      <button class="primary" id="doReturn">確認歸還</button>
    </div>`;
  document.getElementById('doReturn').addEventListener('click', async () => {
    try {
      const r = await Api.post('/api/returns', { barcode: data.copy.barcode });
      showToast('歸還完成，請放回 ' + r.shelfLabel);
      loadOpenLoans();
      document.getElementById('scan').focus();
    } catch (err) { showToast(err.message, 'error'); }
  });
}

async function handleScan(code) {
  try {
    const data = await Api.post('/api/scan', { barcode: code });
    if (data.action === 'borrow') return renderBorrow(data);
    if (data.action === 'return') return renderReturn(data);
    resultEl.innerHTML = `<div class="card"><h2>${data.title.title}</h2>
      <p class="muted">${data.message}</p></div>`;
  } catch (err) {
    resultEl.innerHTML = `<div class="card"><p>${err.message}</p></div>`;
  }
}

createScanInput({
  input: document.getElementById('scan'),
  onScan: handleScan,
  cameraButton: document.getElementById('camera'),
  video: document.getElementById('video'),
});
createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));
loadOpenLoans();

// 從全站搜尋跳過來時直接帶入編號
const preset = new URLSearchParams(location.search).get('barcode');
if (preset) handleScan(preset);
```

- [ ] **Step 4: 寫 `public/catalog.html`（館藏）**

```html
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>館藏 · 圖書管理系統</title>
  <link rel="stylesheet" href="/css/app.css">
</head>
<body>
  <!-- Step 1 的 nav，catalog.html 加 class="active" -->
  <main>
    <div class="card">
      <div class="row">
        <button class="primary" id="addBook">📕 新增圖書（掃 ISBN）</button>
        <button id="addToy">🧩 新增教具（手動）</button>
        <input id="filter" placeholder="篩選書名／作者／ISBN" style="max-width:280px">
      </div>
    </div>
    <div id="form"></div>
    <div class="card"><table>
      <thead><tr><th>書名</th><th>作者</th><th>類型</th><th>在架／總數</th><th></th></tr></thead>
      <tbody id="list"></tbody>
    </table></div>
  </main>
  <script src="/js/app.js"></script>
  <script src="/js/omnisearch.js"></script>
  <script src="/js/barcode.js"></script>
  <script src="/js/page-catalog.js"></script>
</body>
</html>
```

- [ ] **Step 5: 寫 `public/js/page-catalog.js`**

```js
let categories = [], shelves = [];

async function loadRefs() {
  [categories, shelves] = await Promise.all([Api.get('/api/categories'), Api.get('/api/shelves')]);
}

function shelfOptions() {
  const label = (s) => {
    const p = shelves.find((x) => x.id === s.parent_id);
    return p ? `${p.name} · ${s.name}` : s.name;
  };
  return `<option value="">未指定櫃位</option>` +
    shelves.map((s) => `<option value="${s.id}">${label(s)}</option>`).join('');
}

async function loadList(q = '') {
  const rows = await Api.get('/api/titles' + (q ? `?q=${encodeURIComponent(q)}` : ''));
  document.getElementById('list').innerHTML = rows.length ? rows.map((t) => `
    <tr><td>${t.title}</td><td>${t.authors ?? ''}</td><td>${t.category_name}</td>
        <td>${t.available_copies} / ${t.total_copies}</td>
        <td><button data-id="${t.id}" class="detail">明細</button></td></tr>`).join('')
    : '<tr><td class="muted">還沒有任何館藏</td></tr>';
  document.querySelectorAll('.detail').forEach((b) =>
    b.addEventListener('click', () => showDetail(Number(b.dataset.id))));
}

/**
 * 明細含每一冊的編號條碼，可直接列印貼紙。
 * 同時是「補封面／教具照片」與「改櫃位」的入口——教具沒有 ISBN 抓不到圖，
 * 圖書也常常查不到封面，兩者都需要手動補。
 */
async function showDetail(id) {
  const t = await Api.get(`/api/titles/${id}`);
  const host = document.getElementById('form');
  host.innerHTML = `<div class="card">
    <h2>${t.title}</h2>
    <img id="cover" src="${t.cover_path ?? ''}" style="max-height:160px${t.cover_path ? '' : ';display:none'}">
    <p class="muted">${t.authors ?? ''}　${t.isbn13 ?? ''}</p>
    <div class="row no-print">
      <button id="addCopy">加冊</button>
      <button id="printAll">列印全部條碼</button>
      <label class="muted">${t.cover_path ? '換一張圖片' : '上傳圖片'}：
        <input type="file" id="coverFile" accept="image/*" style="max-width:230px"></label>
    </div>
    <div id="copies"></div>
  </div>`;

  const box = document.getElementById('copies');
  for (const c of t.copies) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:inline-block;margin:10px;text-align:center;vertical-align:top';
    wrap.appendChild(renderCode39(c.barcode));
    wrap.insertAdjacentHTML('beforeend', `
      <div>${c.barcode}</div>
      <div class="muted">${c.status === 'in' ? '在架' : c.status === 'out' ? '借出中' : c.status}</div>
      <select class="shelf-pick no-print" data-copy="${c.id}" style="margin-top:6px">
        ${shelfOptions()}
      </select>`);
    box.appendChild(wrap);
    const pick = wrap.querySelector('.shelf-pick');
    pick.value = c.shelf_id ?? '';
    pick.addEventListener('change', async () => {
      try {
        await Api.put(`/api/copies/${c.id}`, { shelf_id: Number(pick.value) || null });
        showToast('已更新櫃位');
      } catch (err) { showToast(err.message, 'error'); }
    });
  }

  document.getElementById('printAll').addEventListener('click', () => window.print());

  document.getElementById('addCopy').addEventListener('click', async () => {
    await Api.post(`/api/titles/${id}/copies`, { copies: 1 });
    showToast('已加 1 冊');
    showDetail(id); loadList();
  });

  // 檔案上傳要用 FormData，不能走 Api.post（那會把內容 JSON.stringify）。
  document.getElementById('coverFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('cover', file);
    try {
      const res = await fetch(`/api/titles/${id}/cover`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '上傳失敗');
      const img = document.getElementById('cover');
      img.src = data.cover_path + '?t=' + Date.now();   // 檔名固定，要破快取才看得到新圖
      img.style.display = '';
      showToast('圖片已更新');
    } catch (err) { showToast(err.message, 'error'); }
  });
}

/** 圖書：掃 ISBN → 預覽卡 → 確認建檔。離線時直接展開空白表單。 */
function showBookForm() {
  document.getElementById('form').innerHTML = `<div class="card">
    <h3>新增圖書</h3>
    <div class="row scan-box">
      <input id="isbn" placeholder="掃描書背 ISBN 條碼，或手動輸入後按 Enter" autocomplete="off">
    </div>
    <div id="preview"></div>
  </div>`;
  const isbnEl = document.getElementById('isbn');
  isbnEl.focus();
  isbnEl.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const isbn = isbnEl.value.trim();
    if (!isbn) return;
    let r;
    try { r = await Api.get(`/api/lookup/isbn/${encodeURIComponent(isbn)}`); }
    catch { r = { found: false, online: false, info: null }; }

    if (r.found && r.source === 'local') {
      showToast(`這本已經有 ${r.existingCopies} 冊，請用「明細 → 加冊」`, 'error');
      return;
    }
    if (!r.online) showToast('目前離線，請自行填寫書名');
    else if (!r.found) showToast('查不到這本書的資料，請自行填寫');
    renderTitleForm({ ...(r.info ?? {}), isbn13: isbn }, 'book');
  });
}

function showToyForm() {
  document.getElementById('form').innerHTML = '';
  renderTitleForm({}, 'toy');
}

function renderTitleForm(info, kind) {
  const cats = categories.filter((c) => c.kind === kind);
  const host = document.getElementById('form');
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h3>${kind === 'book' ? '確認書目資料' : '新增教具'}</h3>
    ${info.coverUrl ? `<img src="${info.coverUrl}" style="max-height:180px">` : ''}
    <p><input id="f-title" placeholder="書名／品名" value="${info.title ?? ''}"></p>
    <p><input id="f-authors" placeholder="作者" value="${info.authors ?? ''}"></p>
    <p><input id="f-publisher" placeholder="出版社" value="${info.publisher ?? ''}"></p>
    <div class="row">
      <select id="f-category">${cats.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}</select>
      <select id="f-shelf">${shelfOptions()}</select>
      <input id="f-copies" type="number" min="1" value="1" style="max-width:110px" title="冊數">
      <button class="primary" id="f-save">建立並產生編號</button>
    </div>`;
  host.appendChild(card);
  document.getElementById('f-save').addEventListener('click', async () => {
    const body = {
      isbn13: info.isbn13 ?? null,
      title: document.getElementById('f-title').value.trim(),
      authors: document.getElementById('f-authors').value.trim() || null,
      publisher: document.getElementById('f-publisher').value.trim() || null,
      description: info.description ?? null,
      published_date: info.published_date ?? null,
      coverUrl: info.coverUrl ?? null,
      source: info.source ?? 'manual',
      category_id: Number(document.getElementById('f-category').value),
      shelf_id: Number(document.getElementById('f-shelf').value) || null,
      copies: Number(document.getElementById('f-copies').value) || 1,
    };
    if (!body.title) return showToast('請填寫書名／品名', 'error');
    try {
      const r = await Api.post('/api/titles', body);
      showToast(`建立完成，編號 ${r.copies.map((c) => c.barcode).join('、')}`);
      await loadList();
      showDetail(r.title.id);
    } catch (err) { showToast(err.message, 'error'); }
  });
}

document.getElementById('addBook').addEventListener('click', showBookForm);
document.getElementById('addToy').addEventListener('click', showToyForm);
document.getElementById('filter').addEventListener('input', (e) => loadList(e.target.value.trim()));
createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));

loadRefs().then(() => {
  loadList();
  const preset = new URLSearchParams(location.search).get('title');
  if (preset) showDetail(Number(preset));
});
```

- [ ] **Step 6: 人工驗收**

1. 借還台掃一個編號 → 出現借閱人下拉 → 借出 → 「目前外借中」多一筆。
2. 再掃同一個編號 → **出現大字「請放回：A櫃 · 第2層」** → 歸還。
3. 館藏頁「新增圖書」掃一個真實 ISBN → 有網路時出現預覽（書名／封面）。
4. **拔掉網路線或關 Wi-Fi**，重新整理 → 右上徽章變紅 → 再掃 ISBN → **立刻**展開空白表單（不可轉圈等待）→ 手動填完能建檔 → **借還書照常可用**。
5. 深色模式看一次全部頁面。

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/catalog.html public/js/page-scan.js public/js/page-catalog.js
git commit -m "[UI]: 還書畫面以櫃位為主角，掃完不必再問「這本放哪」"
```

---

### Task 12: 其餘管理頁與整體驗收

**Files:**
- Create: `public/shelves.html`, `public/borrowers.html`, `public/loans.html`, `public/js/page-masters.js`, `public/js/page-loans.js`
- Create: `README.md`

- [ ] **Step 1: 寫 `public/js/page-masters.js`**

三個主檔畫面共用一份程式碼，靠頁面上的 `data-resource` 決定操作哪一個。

```js
const RESOURCES = {
  shelves: {
    api: '/api/shelves', title: '書櫃',
    columns: [['code', '代碼'], ['name', '名稱'], ['parentLabel', '所屬櫃']],
    fields: [
      { key: 'code', label: '代碼', required: true },
      { key: 'name', label: '名稱', required: true },
      { key: 'parent_id', label: '所屬櫃（留空代表這是一個獨立的櫃）', type: 'parent' },
    ],
  },
  borrowers: {
    api: '/api/borrowers', title: '借閱人',
    columns: [['name', '姓名'], ['class_name', '班級'], ['code', '編號']],
    fields: [
      { key: 'name', label: '姓名', required: true },
      { key: 'class_name', label: '班級' },
      { key: 'code', label: '編號（選填）' },
    ],
  },
};

const key = document.body.dataset.resource;
const cfg = RESOURCES[key];
let rows = [];

function parentLabelOf(r) {
  if (!r.parent_id) return '（獨立櫃）';
  return rows.find((x) => x.id === r.parent_id)?.name ?? '';
}

async function load() {
  rows = await Api.get(cfg.api);
  document.getElementById('list').innerHTML = rows.length ? rows.map((r) => `
    <tr>${cfg.columns.map(([k]) => `<td>${k === 'parentLabel' ? parentLabelOf(r) : (r[k] ?? '')}</td>`).join('')}
      <td><button class="danger del" data-id="${r.id}">刪除</button></td></tr>`).join('')
    : `<tr><td class="muted">還沒有${cfg.title}資料</td></tr>`;
  document.querySelectorAll('.del').forEach((b) => b.addEventListener('click', async () => {
    try { await Api.del(`${cfg.api}/${b.dataset.id}`); showToast('已刪除'); load(); }
    catch (err) { showToast(err.message, 'error'); }
  }));
  renderForm();
}

function renderForm() {
  const tops = rows.filter((r) => !r.parent_id);
  document.getElementById('form').innerHTML = `<div class="card"><div class="row">
    ${cfg.fields.map((f) => f.type === 'parent'
      ? `<select id="in-${f.key}" style="max-width:220px"><option value="">${f.label}</option>
           ${tops.map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}</select>`
      : `<input id="in-${f.key}" placeholder="${f.label}" style="max-width:220px">`).join('')}
    <button class="primary" id="add">新增</button>
  </div></div>`;
  document.getElementById('add').addEventListener('click', async () => {
    const body = {};
    for (const f of cfg.fields) {
      const v = document.getElementById(`in-${f.key}`).value.trim();
      if (f.required && !v) return showToast(`請填寫${f.label}`, 'error');
      if (v) body[f.key] = f.type === 'parent' ? Number(v) : v;
    }
    try { await Api.post(cfg.api, body); showToast('已新增'); load(); }
    catch (err) { showToast(err.message, 'error'); }
  });
}

createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));
load();
```

- [ ] **Step 2: 寫 `public/shelves.html` 與 `public/borrowers.html`**

兩頁結構相同，只差 `data-resource` 與標題。`shelves.html`：

```html
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>書櫃 · 圖書管理系統</title>
  <link rel="stylesheet" href="/css/app.css">
</head>
<body data-resource="shelves">
  <!-- Step 1 (Task 11) 的 nav，shelves.html 加 class="active" -->
  <main>
    <div id="form"></div>
    <div class="card"><table>
      <thead><tr><th>代碼</th><th>名稱</th><th>所屬櫃</th><th></th></tr></thead>
      <tbody id="list"></tbody>
    </table></div>
  </main>
  <script src="/js/app.js"></script>
  <script src="/js/omnisearch.js"></script>
  <script src="/js/page-masters.js"></script>
</body>
</html>
```

`borrowers.html`：

```html
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>借閱人 · 圖書管理系統</title>
  <link rel="stylesheet" href="/css/app.css">
</head>
<body data-resource="borrowers">
  <!-- Step 1 (Task 11) 的 nav，borrowers.html 加 class="active" -->
  <main>
    <div id="form"></div>
    <div class="card"><table>
      <thead><tr><th>姓名</th><th>班級</th><th>編號</th><th></th></tr></thead>
      <tbody id="list"></tbody>
    </table></div>
  </main>
  <script src="/js/app.js"></script>
  <script src="/js/omnisearch.js"></script>
  <script src="/js/page-masters.js"></script>
</body>
</html>
```

- [ ] **Step 3: 寫 `public/loans.html` 與 `public/js/page-loans.js`**

`page-loans.js`：

```js
async function load(openOnly) {
  const rows = await Api.get('/api/loans' + (openOnly ? '?open=1' : ''));
  document.getElementById('list').innerHTML = rows.length ? rows.map((r) => `
    <tr><td>${r.barcode}</td><td>${r.title}</td>
      <td>${r.borrower_name}${r.class_name ? '（' + r.class_name + '）' : ''}</td>
      <td>${new Date(r.borrowed_at).toLocaleString('zh-TW')}</td>
      <td>${r.returned_at ? new Date(r.returned_at).toLocaleString('zh-TW')
                          : '<span class="badge badge-out">借出中</span>'}</td></tr>`).join('')
    : '<tr><td class="muted">沒有借閱紀錄</td></tr>';
}

document.getElementById('openOnly').addEventListener('change', (e) => load(e.target.checked));
createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));
load(false);
```

`loans.html` 的 `<main>`：

```html
  <main>
    <div class="card"><label><input type="checkbox" id="openOnly" style="width:auto"> 只看未歸還</label></div>
    <div class="card"><table>
      <thead><tr><th>編號</th><th>書名</th><th>借閱人</th><th>借出時間</th><th>歸還時間</th></tr></thead>
      <tbody id="list"></tbody>
    </table></div>
  </main>
```

- [ ] **Step 4: 寫 `README.md`**

給的是**未來的自己**看的，不是給幼稚園老師看的（老師只需要知道點哪個檔）。

```markdown
# 幼稚園圖書／教具管理系統

單機使用，管圖書與教具：掃 ISBN 建檔、掃編號借還、還書時提示放回哪一格。

## 給使用者

- 第一次使用：雙擊 **`安裝.bat`**
- 之後每次：雙擊 **`啟動.bat`**（會自動更新到最新版）
- 關閉：關掉黑色視窗

## 給維護者

- 首次部署必須用 `git clone`（不能解壓 zip），否則 `啟動.bat` 的自動更新不會生效。
- 設定都在 `data/config.json`：`DATABASE_URL`、`PORT`、`GOOGLE_BOOKS_API_KEY`。
- 加了新的 npm 套件之後，要請使用者重跑一次 `安裝.bat`。
- 開發規則見 `.claude/CLAUDE.md`，設計規格見 `docs/superpowers/specs/`。

## 測試

    npm run test:quiet
```

- [ ] **Step 5: 全套端到端人工驗收**

模擬幼稚園一天的實際流程：

1. 建兩個書櫃（`A櫃`，其下 `第2層`）。
2. 建兩個借閱人（小明／小班、王老師）。
3. 新增一本真實的書（掃 ISBN，確認有帶出書名與封面），冊數填 2，櫃位選「A櫃 · 第2層」。
4. 新增一個教具（手動填名稱），確認編號是 `T-000001`。
5. 列印條碼 → **用掃碼槍掃列印出來的紙本條碼**，確認讀得到編號。
6. 掃編號借給小明 → 再掃同一個編號 → 確認大字顯示「請放回：A櫃 · 第2層」→ 歸還。
7. 全站搜尋輸入「小明」「毛毛」「B-000001」「A櫃」，四類都要跳得到對的頁面。
8. **關掉網路**重試第 3 步：徽章變紅、立刻展開手動表單、借還照常。
9. 深色模式把五頁都看一遍。

- [ ] **Step 6: 跑全部測試**

Run: `npm run test:quiet 2>&1`
Expected: 全綠

- [ ] **Step 7: Commit 並推上 GitHub**

```bash
git add public README.md
git commit -m "[UI]: 主檔三頁共用一份程式碼，避免各自漂移出不同的操作方式"
git push -u origin main
```

---

## 完成後仍未解決的事

實作完這 12 個 task 之後，以下項目**仍然待辦**，不要當成已完成：

1. **Google Books API 金鑰** —— 使用者尚未提供。未填時系統可運作，但中文童書大多要人工填寫。填進 `data/config.json` 即生效，不需改程式。
2. **NCL 爬蟲的實機驗證** —— `ncl.js` 的解析邏輯只用存檔樣本測過。真實網站的 HTML 結構**必須實際打一次確認**；若對不上，修 `pickField` 的選擇器即可，不影響其他來源。
3. **部署到幼稚園的電腦** —— 需要在目標機器上 `git clone` 一次，並實測 `安裝.bat` 全流程（特別是 winget 裝 PostgreSQL 的環節與中文顯示）。

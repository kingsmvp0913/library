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

// 直接下載 ZIP 的資料夾沒有 .git，「啟動.bat」的自動更新會整段跳過，
// 而畫面上完全看不出來——使用者會一直以為自己用的是最新版。不能只是靜默略過。
if (!fs.existsSync(path.join(ROOT, '.git'))) {
  console.warn('[更新] 這份是直接下載的，不會自動更新到新版本。');
  console.warn('       請雙擊一次「安裝.bat」補好，之後每次啟動就會自動更新。');
}

const port = cfg.PORT ?? 3940;
process.env.DATABASE_URL = cfg.DATABASE_URL;
process.env.PORT = String(port);
// 金鑰刻意不注入 env：它由 lib/settings.js 在需要時直接讀設定檔，
// 使用者從設定頁改完才能立刻生效。放這裡會變成第二個來源，改了卻要重啟。

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

const { saveAutoBackup } = require(path.join(ROOT, 'server', 'lib', 'backup.js'));
const logger = require(path.join(ROOT, 'server', 'lib', 'logger.js'));

migrate()
  .then(async () => {
    logger.pruneLogs();
    logger.info(`系統啟動（埠 ${port}）`);
    // 每次啟動自動留一份備份。使用者不會記得手動備份，而資料沒了是不可逆的。
    // 失敗只印一行警告——少一層保險，總比整套開不起來好。
    try {
      const r = await saveAutoBackup();
      if (r.file) console.log(`[備份] 已自動保留一份：data\\backups\\${r.file}`);
    } catch (err) {
      console.warn('[備份] 這次沒有備份成功（不影響使用）：' + err.message);
    }

    createApp().listen(port, () => {
      console.log(`圖書系統已啟動：http://localhost:${port}`);
      console.log('（關閉這個黑色視窗就會停止系統）');
    });
  })
  .catch((err) => {
    console.error('啟動失敗：' + err.message);
    console.error('請確認 PostgreSQL 已啟動，且 data\\config.json 的 DATABASE_URL 帳號密碼正確。');
    // 開不起來的原因最需要留下來——使用者這時只看得到一閃而過的黑色視窗
    logger.error('啟動失敗：' + err.message);
    process.exit(1);
  });

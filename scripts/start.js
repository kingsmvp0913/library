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

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT, 'data', 'logs');
const KEEP_DAYS = 14;

/**
 * 執行期紀錄。
 *
 * 為什麼需要：系統跑在使用者自己的電腦上，錯誤原本只印在那個黑色視窗，關掉就沒了。
 * 老師遇到狀況只會說「不能用了」，維護者看不到現場也問不出來。
 * 有這個檔，他只要到「匯入匯出」頁按一下就能把紀錄傳出來。
 *
 * 刻意只記「異常與大事」，不記正常操作——每天幾百筆借還會把檔案灌爆，
 * 灌爆的檔案沒有人會去看，等於沒記。
 */
function logFileName(now = new Date()) {
  return `library-${now.toISOString().slice(0, 10)}.log`;
}

function listLogs(dir = LOG_DIR) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^library-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

/** 超過保留天數的直接刪掉，不然一年後會有 365 個檔。 */
function pruneLogs({ dir = LOG_DIR, keep = KEEP_DAYS } = {}) {
  const files = listLogs(dir);
  const removed = [];
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try { fs.unlinkSync(path.join(dir, f)); removed.push(f); } catch { /* 刪不掉就算了 */ }
  }
  return removed;
}

/**
 * 寫一行紀錄。
 * 寫檔失敗一律吞掉——記錄失敗不該把正在處理的請求也弄垮。
 */
function log(level, message, { dir = LOG_DIR, now = new Date() } = {}) {
  const line = `${now.toISOString()} [${level}] ${message}\n`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, logFileName(now)), line, 'utf8');
  } catch { /* 記不成就算了，不能影響主流程 */ }
  return line;
}

const info = (msg, opts) => log('INFO', msg, opts);
const warn = (msg, opts) => log('WARN', msg, opts);
const error = (msg, opts) => log('ERROR', msg, opts);

module.exports = { log, info, warn, error, listLogs, pruneLogs, logFileName, LOG_DIR, KEEP_DAYS };

const fs = require('fs');
const path = require('path');
const db = require('../db.js');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKUP_DIR = path.join(ROOT, 'data', 'backups');
const BACKUP_VERSION = 1;
const KEEP = 30;

// 依 FK 相依順序排列：還原時照這個順序建，清空時倒著刪。
const TABLES = ['categories', 'shelves', 'titles', 'copies', 'borrowers', 'loans', 'counters'];

async function makeBackup() {
  const tables = {};
  for (const t of TABLES) {
    tables[t] = (await db.query(`SELECT * FROM ${t}`)).rows;
  }
  return { version: BACKUP_VERSION, exportedAt: new Date().toISOString(), tables };
}

/** 檔名用時間戳，排序後就是時間序，不必讀檔內容也不必看 mtime。 */
function backupFileName(now = new Date()) {
  return `auto-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
}

function listBackups(dir = BACKUP_DIR) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith('auto-') && f.endsWith('.json'))
      .sort();                                    // 檔名即時間序
  } catch {
    return [];
  }
}

/**
 * 啟動時自動備份一份。
 *
 * 為什麼要自動：匯入匯出頁的完整備份要使用者記得去按，而不懂電腦的人不會記得——
 * 直到硬碟壞掉或誤刪那天，而那時候損失是不可逆的。
 * 使用者完全不需要知道這個功能存在，出事時去 data/backups/ 撈一份還原即可。
 *
 * 失敗一律不可以擋住啟動：備份不成功頂多少一層保險，開不起來卻是整套不能用。
 */
async function saveAutoBackup({ dir = BACKUP_DIR, keep = KEEP, now = new Date() } = {}) {
  const counts = await db.query('SELECT COUNT(*) AS c FROM titles');
  // 全新安裝時資料庫是空的，備空檔只會把有內容的舊備份擠出保留範圍
  if (!Number(counts.rows[0].c)) return { skipped: 'empty' };

  fs.mkdirSync(dir, { recursive: true });
  const file = backupFileName(now);
  fs.writeFileSync(path.join(dir, file), JSON.stringify(await makeBackup()), 'utf8');

  const removed = [];
  const all = listBackups(dir);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    fs.unlinkSync(path.join(dir, old));
    removed.push(old);
  }
  return { file, removed, total: Math.min(all.length, keep) };
}

module.exports = {
  makeBackup, saveAutoBackup, listBackups, backupFileName, BACKUP_DIR, TABLES, BACKUP_VERSION,
};

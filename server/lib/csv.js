// Excel 開 UTF-8 的 CSV 時，沒有 BOM 就會用系統編碼解讀，中文全變亂碼。
const BOM = '﻿';

function escapeCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 產生含 BOM 的 CSV 字串。 */
function toCsv(headers, rows) {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCell).join(','));
  return BOM + lines.join('\n') + '\n';
}

/**
 * 解析 CSV，回傳以標頭為 key 的物件陣列。
 * 自行實作而非引入套件：規則就這幾條，少一個相依就少一次「使用者端要重跑安裝」。
 */
function parseCsv(text) {
  let s = String(text ?? '');
  if (s.startsWith(BOM)) s = s.slice(1);

  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }   // "" 還原成一個 "
        else inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;                        // Excel 的 CRLF，\r 不進值
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) return [];

  const headers = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] ?? ''; });   // 缺欄位補空字串，不留 undefined
    return obj;
  });
}

module.exports = { toCsv, parseCsv, BOM };

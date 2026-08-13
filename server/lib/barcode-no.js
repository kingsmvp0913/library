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

/**
 * 主檔代碼。使用者不需要也不應該自己編代碼——他只想填「A櫃」「繪本」這種名字。
 * 代碼純粹是內部識別、介面上不顯示，用同一套 counters 取號保證唯一且原子。
 */
async function nextCode(kind, prefix) {
  const { rows } = await db.query(
    'UPDATE counters SET last_no = last_no + 1 WHERE kind = $1 RETURNING last_no',
    [kind]
  );
  if (!rows.length) throw new Error(`counters 缺少 ${kind} 這一列，請重新執行安裝`);
  return `${prefix}${String(rows[0].last_no).padStart(3, '0')}`;
}

const nextShelfCode = () => nextCode('shelf', 'S');
const nextCategoryCode = () => nextCode('category', 'C');

module.exports = { nextBarcode, nextCode, nextShelfCode, nextCategoryCode };

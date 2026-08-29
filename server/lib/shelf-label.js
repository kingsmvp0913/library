const db = require('../db.js');

const UNSET = '尚未指定櫃位';

/**
 * 書櫃的顯示名稱。這是老師還書時唯一要看的資訊，
 * 沒設櫃位時要明確講出來，不可回空字串（畫面會變成「請放回：」）。
 *
 * 書櫃只有一層——早期版本有「櫃 → 層」兩層，實際使用後判定太複雜已移除。
 */
async function shelfLabelOf(shelfId, querier = db) {
  if (!shelfId) return UNSET;
  const { rows } = await querier.query('SELECT name FROM shelves WHERE id = $1', [shelfId]);
  return rows.length ? rows[0].name : UNSET;
}

module.exports = { shelfLabelOf, UNSET };

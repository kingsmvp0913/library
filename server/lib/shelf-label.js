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

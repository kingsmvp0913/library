const db = require('../db.js');
const { makeCrudRouter } = require('./crud.js');
const { nextShelfCode, nextCategoryCode } = require('../lib/barcode-no.js');

/**
 * 書櫃只有一層，使用者只填名稱。
 * 代碼是內部識別、介面上不顯示，所以新增時自動發號；
 * `parent_id` 欄位仍在 schema 裡（本專案沒有 drop column 機制），但已不再讀寫。
 */
async function shelfDefaults(body, id) {
  if (!id && !body.code) body.code = await nextShelfCode();
  return null;
}

async function countRows(sql, params) {
  const { rows } = await db.query(sql, params);
  return Number(rows[0].c);
}

// 以下三個 guard 的共通點：訊息要講出「還有幾筆」與「該怎麼辦」，
// 不能只說「無法刪除」，更不能讓資料庫的英文錯誤冒到畫面上。
async function guardShelfDelete(id) {
  const n = await countRows('SELECT COUNT(*) AS c FROM copies WHERE shelf_id = $1', [id]);
  return n ? `這個書櫃還有 ${n} 本書，請先把書換到別的櫃位再刪除。` : null;
}

async function guardCategoryDelete(id) {
  const n = await countRows('SELECT COUNT(*) AS c FROM titles WHERE category_id = $1', [id]);
  return n ? `這個類型還有 ${n} 筆館藏正在使用，請先把它們改成其他類型。` : null;
}

async function guardBorrowerDelete(id) {
  const n = await countRows('SELECT COUNT(*) AS c FROM loans WHERE borrower_id = $1', [id]);
  if (!n) return null;
  const open = await countRows(
    'SELECT COUNT(*) AS c FROM loans WHERE borrower_id = $1 AND returned_at IS NULL', [id]);
  // 借閱歷史必須留著，所以有紀錄的人不能刪；畢業的小朋友改用「停用」讓他從下拉消失。
  return open
    ? `這位借閱人還有 ${open} 本書沒有歸還，請先完成歸還。若不再使用，請改按「停用」。`
    : `這位借閱人有 ${n} 筆借閱紀錄，刪除會讓紀錄對不到人。若不再使用，請改按「停用」。`;
}

// 類型代碼同樣自動產生——使用者只想填「繪本」，不想編一組代碼。
async function categoryDefaults(body, id) {
  if (!id && !body.code) body.code = await nextCategoryCode();
  return null;
}

const categories = makeCrudRouter({
  table: 'categories',
  fields: ['code', 'name', 'kind', 'sort_order', 'active'],
  required: ['name', 'kind'],
  searchFields: ['code', 'name'],
  orderBy: 'sort_order, id',
  beforeWrite: categoryDefaults,
  guardDelete: guardCategoryDelete,
});

const shelves = makeCrudRouter({
  table: 'shelves',
  fields: ['code', 'name', 'note', 'sort_order', 'active'],
  required: ['name'],
  searchFields: ['code', 'name'],
  orderBy: 'sort_order, id',
  beforeWrite: shelfDefaults,
  guardDelete: guardShelfDelete,
});

const borrowers = makeCrudRouter({
  table: 'borrowers',
  fields: ['code', 'name', 'class_name', 'note', 'active'],
  required: ['name'],
  searchFields: ['name', 'class_name', 'code'],
  orderBy: 'name',
  guardDelete: guardBorrowerDelete,
  hideInactive: true,
});

module.exports = { categories, shelves, borrowers };

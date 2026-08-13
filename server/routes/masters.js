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

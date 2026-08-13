const express = require('express');
const db = require('../db.js');

/**
 * 產生單一主檔的 CRUD router。
 * @param {{table:string, fields:string[], required:string[], searchFields:string[],
 *          orderBy?:string, beforeWrite?:(body:object, id:number|null)=>Promise<string|null>}} opts
 */
function makeCrudRouter(opts) {
  const {
    table, fields, required, searchFields, orderBy = 'id',
    beforeWrite, guardDelete, hideInactive = false,
  } = opts;
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const q = (req.query.q ?? '').trim();
      const conds = [];
      const params = [];
      // 停用的資料預設不出現在清單與下拉，但要能用參數叫出來管理。
      if (hideInactive && req.query.includeInactive !== '1') conds.push('active = TRUE');
      if (q) {
        params.push(`%${q}%`);
        conds.push('(' + searchFields.map((f) => `${f} ILIKE $${params.length}`).join(' OR ') + ')');
      }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const { rows } = await db.query(
        `SELECT * FROM ${table} ${where} ORDER BY ${orderBy}`, params
      );
      res.json(rows);
    } catch (err) { next(err); }
  });

  router.post('/', async (req, res, next) => {
    try {
      for (const f of required) {
        if (req.body[f] === undefined || req.body[f] === null || req.body[f] === '') {
          return res.status(400).json({ error: `缺少必填欄位：${f}` });
        }
      }
      if (beforeWrite) {
        const err = await beforeWrite(req.body, null);
        if (err) return res.status(400).json({ error: err });
      }
      const cols = fields.filter((f) => req.body[f] !== undefined);
      const vals = cols.map((f) => req.body[f]);
      const holes = cols.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await db.query(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${holes}) RETURNING *`, vals
      );
      res.json(rows[0]);
    } catch (err) { next(err); }
  });

  router.put('/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (beforeWrite) {
        const err = await beforeWrite(req.body, id);
        if (err) return res.status(400).json({ error: err });
      }
      const cols = fields.filter((f) => req.body[f] !== undefined);
      if (!cols.length) return res.status(400).json({ error: '沒有要修改的欄位' });
      const sets = cols.map((f, i) => `${f} = $${i + 1}`).join(',');
      const { rows } = await db.query(
        `UPDATE ${table} SET ${sets} WHERE id = $${cols.length + 1} RETURNING *`,
        [...cols.map((f) => req.body[f]), id]
      );
      if (!rows.length) return res.status(404).json({ error: '找不到資料' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      // 先自己查關聯再刪，才講得出「這個書櫃還有 3 本書」這種有用的話。
      // 直接讓資料庫的 FK 去擋，使用者只會看到一句看不懂的英文。
      if (guardDelete) {
        const reason = await guardDelete(id);
        if (reason) return res.status(409).json({ error: reason });
      }
      await db.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err) {
      // 最後防線：關聯檢查有漏網的情況也不能吐資料庫術語給使用者。
      if (err.code === '23503' || /foreign key/i.test(err.message ?? '')) {
        return res.status(409).json({ error: '這筆資料還有其他地方正在使用，無法刪除。' });
      }
      next(err);
    }
  });

  return router;
}

module.exports = { makeCrudRouter };

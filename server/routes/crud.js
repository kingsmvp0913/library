const express = require('express');
const db = require('../db.js');

/**
 * 產生單一主檔的 CRUD router。
 * @param {{table:string, fields:string[], required:string[], searchFields:string[],
 *          orderBy?:string, beforeWrite?:(body:object, id:number|null)=>Promise<string|null>}} opts
 */
function makeCrudRouter(opts) {
  const { table, fields, required, searchFields, orderBy = 'id', beforeWrite } = opts;
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const q = (req.query.q ?? '').trim();
      if (!q) {
        const { rows } = await db.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
        return res.json(rows);
      }
      const where = searchFields.map((f, i) => `${f} ILIKE $${i + 1}`).join(' OR ');
      const params = searchFields.map(() => `%${q}%`);
      const { rows } = await db.query(
        `SELECT * FROM ${table} WHERE ${where} ORDER BY ${orderBy}`, params
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
      await db.query(`DELETE FROM ${table} WHERE id = $1`, [Number(req.params.id)]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { makeCrudRouter };

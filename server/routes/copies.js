const express = require('express');
const db = require('../db.js');

const router = express.Router();
const MANUAL_STATUSES = ['in', 'lost', 'repair'];

/**
 * 某個書櫃上有哪些冊。盤點時要一眼看出哪幾本不在架上、在誰手上。
 * 一定要帶 shelf 參數——沒帶就整包倒出來，畫面會被幾千筆塞爆。
 */
router.get('/', async (req, res, next) => {
  try {
    if (!req.query.shelf) {
      return res.status(400).json({ error: '請指定要看哪一個書櫃' });
    }
    const shelfId = Number(req.query.shelf);
    const { rows } = await db.query(
      `SELECT cp.id, cp.barcode, cp.status, cp.title_id, t.title, t.authors, t.cover_path
         FROM copies cp JOIN titles t ON t.id = cp.title_id
        WHERE cp.shelf_id = $1 ORDER BY cp.barcode`, [shelfId]);
    if (!rows.length) return res.json([]);

    // 借出中的冊要講得出在誰手上。分開查再合併，不 JOIN loans——
    // loans 上的 partial index 會讓 JOIN 漏掉列（見 .claude/rules/testing.md）。
    const open = await db.query(
      `SELECT l.copy_id, b.name AS borrower_name, l.borrowed_at
         FROM loans l JOIN borrowers b ON b.id = l.borrower_id
        WHERE l.returned_at IS NULL`);
    const byCopy = new Map(open.rows.map((r) => [r.copy_id, r]));
    res.json(rows.map((c) => ({
      ...c,
      borrower_name: byCopy.get(c.id)?.borrower_name ?? null,
      borrowed_at: byCopy.get(c.id)?.borrowed_at ?? null,
    })));
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    // 編號貼在實體書上，改了就跟現實對不起來——沒有「重新編號」這回事。
    if (req.body.barcode !== undefined) {
      return res.status(400).json({ error: '編號已經貼在書上，不能修改' });
    }
    if (req.body.status === 'out') {
      return res.status(400).json({ error: '借出狀態只能由借還台更新' });
    }
    if (req.body.status !== undefined && !MANUAL_STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: '不認得的狀態' });
    }
    const cols = ['shelf_id', 'status', 'note'].filter((f) => req.body[f] !== undefined);
    if (!cols.length) return res.status(400).json({ error: '沒有要修改的欄位' });
    const sets = cols.map((f, i) => `${f} = $${i + 1}`).join(',');
    const changingStatus = req.body.status !== undefined;
    const { rows } = await db.query(
      `UPDATE copies SET ${sets} WHERE id = $${cols.length + 1}${changingStatus ? " AND status <> 'out'" : ''} RETURNING *`,
      [...cols.map((f) => req.body[f]), Number(req.params.id)]
    );
    if (!rows.length) {
      const current = await db.query('SELECT status FROM copies WHERE id = $1', [Number(req.params.id)]);
      if (changingStatus && current.rows[0]?.status === 'out') {
        return res.status(409).json({ error: '這一冊正在借出中，請歸還後再修改狀態。' });
      }
      return res.status(404).json({ error: '找不到這一冊' });
    }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query('SELECT status FROM copies WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: '找不到這一冊' });
    if (rows[0].status === 'out') {
      return res.status(409).json({ error: '這一冊正在借出中，請先完成歸還再刪除。' });
    }
    // 刻意寫成 IN (SELECT ...) 而不是 `WHERE copy_id = $1`：
    // loans 上有 partial unique index（WHERE returned_at IS NULL），
    // 已歸還的列離開索引後，用索引欄位做等值查詢在 pg-mem 會查不到它，
    // 這條防護就會靜默失效（歸還過的冊變成可以刪）。兩種寫法在真 PG 等價。
    const used = await db.query(
      'SELECT COUNT(*) AS c FROM loans WHERE copy_id IN (SELECT id FROM copies WHERE id = $1)',
      [id]);
    // 刪掉有紀錄的冊，借閱歷史就會出現對不到書的資料。
    // 書弄丟了應該標記成「遺失」保留紀錄，而不是刪除。
    if (Number(used.rows[0].c)) {
      return res.status(409).json({
        error: '這一冊有借閱紀錄，刪除會讓紀錄對不到書。若書不見了，請把狀態改成「遺失」。',
      });
    }
    await db.query('DELETE FROM copies WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;

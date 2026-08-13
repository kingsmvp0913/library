const express = require('express');
const db = require('../db.js');

const router = express.Router();
const STATUSES = ['in', 'out', 'lost', 'repair'];

router.put('/:id', async (req, res, next) => {
  try {
    // 編號貼在實體書上，改了就跟現實對不起來——沒有「重新編號」這回事。
    if (req.body.barcode !== undefined) {
      return res.status(400).json({ error: '編號已經貼在書上，不能修改' });
    }
    if (req.body.status !== undefined && !STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: '不認得的狀態' });
    }
    const cols = ['shelf_id', 'status', 'note'].filter((f) => req.body[f] !== undefined);
    if (!cols.length) return res.status(400).json({ error: '沒有要修改的欄位' });
    const sets = cols.map((f, i) => `${f} = $${i + 1}`).join(',');
    const { rows } = await db.query(
      `UPDATE copies SET ${sets} WHERE id = $${cols.length + 1} RETURNING *`,
      [...cols.map((f) => req.body[f]), Number(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: '找不到這一冊' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;

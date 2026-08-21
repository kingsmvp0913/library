const express = require('express');
const db = require('../db.js');
const { shelfLabelOf } = require('../lib/shelf-label.js');
const { canonicalBarcode } = require('../lib/barcode-no.js');

const router = express.Router();

async function findCopy(barcode) {
  const { rows } = await db.query(
    `SELECT cp.*, t.title, t.authors, t.cover_path, t.isbn13
       FROM copies cp JOIN titles t ON t.id = cp.title_id
      WHERE cp.barcode = $1`, [canonicalBarcode(barcode)]
  );
  return rows[0] ?? null;
}

async function openLoanOf(copyId) {
  const { rows } = await db.query(
    `SELECT l.*, b.name AS borrower_name, b.class_name
       FROM loans l JOIN borrowers b ON b.id = l.borrower_id
      WHERE l.copy_id = $1 AND l.returned_at IS NULL
      ORDER BY l.id DESC LIMIT 1`, [copyId]
  );
  return rows[0] ?? null;
}

router.post('/scan', async (req, res, next) => {
  try {
    const copy = await findCopy(req.body.barcode);
    if (!copy) return res.status(404).json({ error: '找不到這個編號，請確認條碼是否正確' });

    const shelfLabel = await shelfLabelOf(copy.shelf_id);
    const base = {
      copy: { id: copy.id, barcode: copy.barcode, status: copy.status, shelf_id: copy.shelf_id },
      title: {
        title: copy.title, authors: copy.authors,
        cover_path: copy.cover_path, isbn13: copy.isbn13,
      },
      shelfLabel,
    };

    if (copy.status === 'out') {
      const loan = await openLoanOf(copy.id);
      return res.json({
        ...base, action: 'return',
        borrower: loan
          ? { id: loan.borrower_id, name: loan.borrower_name, class_name: loan.class_name }
          : null,
        borrowed_at: loan?.borrowed_at ?? null,
      });
    }
    if (copy.status !== 'in') {
      return res.json({
        ...base, action: 'blocked',
        message: copy.status === 'lost' ? '這一冊被標記為遺失' : '這一冊正在修繕中',
      });
    }
    res.json({ ...base, action: 'borrow' });
  } catch (err) { next(err); }
});

router.post('/loans', async (req, res, next) => {
  try {
    const copy = req.body.barcode
      ? await findCopy(req.body.barcode)
      : (await db.query('SELECT * FROM copies WHERE id = $1', [Number(req.body.copy_id)])).rows[0];
    if (!copy) return res.status(404).json({ error: '找不到這一冊' });
    if (!req.body.borrower_id) return res.status(400).json({ error: '請先選擇借閱人' });
    if (copy.status === 'out') return res.status(409).json({ error: '這一冊已經借出了' });
    if (copy.status !== 'in') return res.status(409).json({ error: '這一冊目前不可外借' });

    // 應用層先擋一次；資料庫的 loans_one_open_per_copy 是最後防線。
    if (await openLoanOf(copy.id)) return res.status(409).json({ error: '這一冊已經借出了' });

    const { rows: [loan] } = await db.query(
      `INSERT INTO loans (copy_id, borrower_id) VALUES ($1,$2) RETURNING *`,
      [copy.id, Number(req.body.borrower_id)]
    );
    await db.query(`UPDATE copies SET status = 'out' WHERE id = $1`, [copy.id]);
    res.json({ loan, shelfLabel: await shelfLabelOf(copy.shelf_id) });
  } catch (err) { next(err); }
});

router.post('/returns', async (req, res, next) => {
  try {
    const copy = await findCopy(req.body.barcode);
    if (!copy) return res.status(404).json({ error: '找不到這個編號' });
    const loan = await openLoanOf(copy.id);
    if (!loan) return res.status(409).json({ error: '這一冊沒有借出中的紀錄' });

    const shelfLabel = await shelfLabelOf(copy.shelf_id);
    await db.query(
      `UPDATE loans SET returned_at = NOW(), return_shelf_id = $1 WHERE id = $2`,
      [copy.shelf_id ?? null, loan.id]
    );
    await db.query(`UPDATE copies SET status = 'in' WHERE id = $1`, [copy.id]);
    res.json({
      shelfLabel,
      title: { title: copy.title, cover_path: copy.cover_path },
      borrower: { name: loan.borrower_name, class_name: loan.class_name },
    });
  } catch (err) { next(err); }
});

/**
 * 借閱紀錄。刻意不用多表 JOIN，改成分開查再於 JS 合併。
 *
 * 原因（2026-08-13 實測）：loans 上有 partial unique index（WHERE returned_at IS NULL），
 * 歸還後該列離開索引，pg-mem 的 JOIN 就會整個漏掉那一列——已歸還的紀錄在畫面上會憑空消失。
 * 真 PG 沒有這個問題，但若堅持 JOIN，這個功能在測試裡就永遠驗不到。
 * 分開查在兩邊都正確，且主檔在幼稚園規模下很小，全撈的成本可以忽略。
 */
router.get('/loans', async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    if (req.query.open === '1') conds.push('returned_at IS NULL');
    if (req.query.borrower) {
      // borrower_id 不是 partial index 的欄位，用等值查詢是安全的
      params.push(Number(req.query.borrower));
      conds.push(`borrower_id = $${params.length}`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const loans = await db.query(
      `SELECT * FROM loans ${where} ORDER BY borrowed_at DESC, id DESC`, params
    );
    if (!loans.rows.length) return res.json([]);

    const [copies, titles, borrowers] = await Promise.all([
      db.query('SELECT id, barcode, title_id FROM copies'),
      db.query('SELECT id, title FROM titles'),
      db.query('SELECT id, name, class_name FROM borrowers'),
    ]);
    const copyById = new Map(copies.rows.map((r) => [r.id, r]));
    const titleById = new Map(titles.rows.map((r) => [r.id, r]));
    const borrowerById = new Map(borrowers.rows.map((r) => [r.id, r]));

    res.json(loans.rows.map((l) => {
      const cp = copyById.get(l.copy_id);
      const t = cp ? titleById.get(cp.title_id) : null;
      const b = borrowerById.get(l.borrower_id);
      return {
        ...l,
        barcode: cp?.barcode ?? '',
        title: t?.title ?? '',
        borrower_name: b?.name ?? '',
        class_name: b?.class_name ?? null,
      };
    }));
  } catch (err) { next(err); }
});

module.exports = router;

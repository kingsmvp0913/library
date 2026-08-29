const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('../db.js');
const { nextBarcode } = require('../lib/barcode-no.js');
const { saveCoverFromUrl, COVER_DIR } = require('../lib/cover.js');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(COVER_DIR, { recursive: true });
      cb(null, COVER_DIR);
    },
    filename: (req, file, cb) =>
      cb(null, `title-${req.params.id}${path.extname(file.originalname) || '.jpg'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

/** 依類型的 kind 決定編號前綴，並建立 n 冊。 */
async function createCopies(titleId, categoryId, n, shelfId) {
  const { rows } = await db.query('SELECT kind FROM categories WHERE id = $1', [categoryId]);
  if (!rows.length) throw new Error('找不到指定的類型');
  const kind = rows[0].kind;
  const out = [];
  for (let i = 0; i < n; i++) {
    const barcode = await nextBarcode(kind);
    const { rows: [copy] } = await db.query(
      `INSERT INTO copies (barcode, title_id, shelf_id) VALUES ($1,$2,$3) RETURNING *`,
      [barcode, titleId, shelfId ?? null]
    );
    out.push(copy);
  }
  return out;
}

/**
 * 一次算出所有書目的總冊數與在架冊數。
 * 不用相關子查詢——pg-mem 不支援子查詢參照外層 alias（會噴 Unknown alias）。
 */
async function copyStats() {
  const { rows } = await db.query(
    `SELECT title_id, status, COUNT(*) AS c FROM copies GROUP BY title_id, status`
  );
  const map = new Map();
  for (const r of rows) {
    const cur = map.get(r.title_id) ?? { total: 0, available: 0 };
    cur.total += Number(r.c);
    if (r.status === 'in') cur.available += Number(r.c);
    map.set(r.title_id, cur);
  }
  return map;
}

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.title) return res.status(400).json({ error: '缺少書名／品名' });
    if (!b.category_id) return res.status(400).json({ error: '缺少類型' });

    const isbn = b.isbn13 ? String(b.isbn13).replace(/[^0-9Xx]/g, '') : null;
    if (isbn) {
      const dup = await db.query('SELECT id FROM titles WHERE isbn13 = $1', [isbn]);
      if (dup.rows.length) {
        return res.status(409).json({
          error: '這本書已經建過了，可以直接加冊', titleId: dup.rows[0].id,
        });
      }
    }

    const coverPath = b.coverUrl
      ? await saveCoverFromUrl(b.coverUrl, isbn ?? `t${Date.now()}`)
      : null;

    const { rows: [title] } = await db.query(
      `INSERT INTO titles (isbn13, title, subtitle, authors, publisher, published_date,
                           description, cover_path, category_id, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [isbn, b.title, b.subtitle ?? null, b.authors ?? null, b.publisher ?? null,
        b.published_date ?? null, b.description ?? null, coverPath, b.category_id,
        b.source ?? 'manual']
    );

    const n = Math.max(1, Number(b.copies ?? 1));
    const copies = await createCopies(title.id, b.category_id, n, b.shelf_id);
    res.json({ title, copies });
  } catch (err) { next(err); }
});

router.post('/:id/copies', async (req, res, next) => {
  try {
    const titleId = Number(req.params.id);
    const { rows } = await db.query('SELECT category_id FROM titles WHERE id = $1', [titleId]);
    if (!rows.length) return res.status(404).json({ error: '找不到書目' });
    const n = Math.max(1, Number(req.body.copies ?? 1));
    const copies = await createCopies(titleId, rows[0].category_id, n, req.body.shelf_id);
    res.json({ copies });
  } catch (err) { next(err); }
});

router.post('/:id/cover', upload.single('cover'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '請選擇一張圖片（5MB 以內）' });
    const rel = `/covers/${req.file.filename}`;
    await db.query('UPDATE titles SET cover_path = $1, updated_at = NOW() WHERE id = $2',
      [rel, Number(req.params.id)]);
    res.json({ cover_path: rel });
  } catch (err) { next(err); }
});

const EDITABLE = ['title', 'subtitle', 'series', 'volume', 'authors', 'illustrator',
  'translator', 'publisher', 'published_date', 'pages', 'description', 'category_id'];
const BATCH_COPY_STATUSES = ['in', 'lost', 'repair'];

router.put('/batch', async (req, res, next) => {
  try {
    const titleIds = [...new Set((req.body.titleIds ?? []).map(Number).filter(Number.isInteger))];
    if (!titleIds.length) return res.status(400).json({ error: '請選擇要修改的館藏' });
    if (req.body.category_id === undefined && req.body.shelf_id === undefined
        && req.body.status === undefined) {
      return res.status(400).json({ error: '請選擇要修改的項目' });
    }
    if (req.body.status !== undefined && !BATCH_COPY_STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: '不認得的狀態' });
    }

    const marks = titleIds.map((_, i) => `$${i + 1}`).join(',');
    const categoryMarks = titleIds.map((_, i) => `$${i + 2}`).join(',');
    let changedTitles = 0;
    let changedCopies = 0;

    if (req.body.shelf_id !== undefined || req.body.status !== undefined) {
      const { rows: borrowed } = await db.query(
        `SELECT id FROM copies WHERE title_id IN (${marks}) AND status = 'out'`, titleIds);
      if (borrowed.length) {
        const target = req.body.shelf_id !== undefined && req.body.status !== undefined
          ? '櫃位或狀態'
          : (req.body.status !== undefined ? '狀態' : '櫃位');
        return res.status(409).json({
          error: `有 ${borrowed.length} 冊正在借出中，請歸還後再修改${target}。`,
        });
      }
    }

    if (req.body.category_id !== undefined) {
      const { rows } = await db.query(
        `UPDATE titles SET category_id = $1, updated_at = NOW() WHERE id IN (${categoryMarks}) RETURNING id`,
        [req.body.category_id, ...titleIds]
      );
      changedTitles = rows.length;
    }

    if (req.body.shelf_id !== undefined || req.body.status !== undefined) {
      const sets = [];
      const values = [];
      if (req.body.shelf_id !== undefined) {
        values.push(req.body.shelf_id);
        sets.push(`shelf_id = $${values.length}`);
      }
      if (req.body.status !== undefined) {
        values.push(req.body.status);
        sets.push(`status = $${values.length}`);
      }
      const copyMarks = titleIds.map((_, i) => `$${values.length + i + 1}`).join(',');
      const { rows } = await db.query(
        `UPDATE copies SET ${sets.join(',')} WHERE title_id IN (${copyMarks}) AND status <> 'out' RETURNING id`,
        [...values, ...titleIds]
      );
      changedCopies = rows.length;
    }

    res.json({ changedTitles, changedCopies });
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const exists = await db.query('SELECT id FROM titles WHERE id = $1', [id]);
    if (!exists.rows.length) return res.status(404).json({ error: '找不到這筆館藏' });

    if (req.body.title !== undefined && !String(req.body.title).trim()) {
      return res.status(400).json({ error: '書名／品名不能是空的' });
    }

    const sets = [];
    const vals = [];
    for (const f of EDITABLE) {
      if (req.body[f] === undefined) continue;
      const v = typeof req.body[f] === 'string' ? req.body[f].trim() : req.body[f];
      if (f === 'pages') {
        // pages 是 INTEGER。收到「abc」會讓整個 UPDATE 噴 500，連同其他欄位一起改不了；
        // 非正整數一律當作沒填。
        const n = Math.floor(Number(v));
        vals.push(Number.isFinite(n) && n > 0 ? n : null);
      } else {
        vals.push(v === '' ? null : v);
      }
      sets.push(`${f} = $${vals.length}`);
    }

    if (req.body.isbn13 !== undefined) {
      const isbn = String(req.body.isbn13).replace(/[^0-9Xx]/g, '') || null;
      if (isbn) {
        // 兩筆書目共用同一個 ISBN，之後掃碼建檔就分不出是哪一本。
        const dup = await db.query(
          'SELECT id FROM titles WHERE isbn13 = $1 AND id <> $2', [isbn, id]);
        if (dup.rows.length) {
          return res.status(409).json({
            error: '這個 ISBN 已經被另一筆館藏使用了', titleId: dup.rows[0].id,
          });
        }
      }
      vals.push(isbn);
      sets.push(`isbn13 = $${vals.length}`);
    }

    if (!sets.length) return res.status(400).json({ error: '沒有要修改的欄位' });
    vals.push(id);
    const { rows } = await db.query(
      `UPDATE titles SET ${sets.join(',')}, updated_at = NOW()
        WHERE id = $${vals.length} RETURNING *`, vals);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query(
      'SELECT COUNT(*) AS c FROM copies WHERE title_id = $1', [id]);
    const n = Number(rows[0].c);
    // 先刪冊再刪書目，是為了讓使用者一次面對一件事：
    // 哪幾冊還在架上、哪幾冊有借閱紀錄不能刪，逐冊處理才看得懂。
    if (n) {
      return res.status(409).json({
        error: `這筆館藏還有 ${n} 冊，請先在下方逐冊刪除，再刪除整筆館藏。`,
      });
    }
    await db.query('DELETE FROM titles WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q ?? '').trim();
    const params = [];
    const where = [];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(t.title ILIKE $${params.length} OR t.authors ILIKE $${params.length}
                   OR t.isbn13 ILIKE $${params.length})`);
    }
    if (req.query.category) {
      params.push(Number(req.query.category));
      where.push(`t.category_id = $${params.length}`);
    }
    const sql = `
      SELECT t.*, c.name AS category_name, c.kind
        FROM titles t JOIN categories c ON c.id = t.category_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY t.created_at DESC, t.id DESC`;
    const { rows } = await db.query(sql, params);
    const stats = await copyStats();
    res.json(rows.map((r) => {
      const s = stats.get(r.id) ?? { total: 0, available: 0 };
      return { ...r, total_copies: s.total, available_copies: s.available };
    }));
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query(
      `SELECT t.*, c.name AS category_name, c.kind FROM titles t
         JOIN categories c ON c.id = t.category_id WHERE t.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: '找不到書目' });
    const copies = await db.query(
      `SELECT cp.*, s.name AS shelf_name FROM copies cp
         LEFT JOIN shelves s ON s.id = cp.shelf_id
        WHERE cp.title_id = $1 ORDER BY cp.barcode`, [id]);
    res.json({ ...rows[0], copies: copies.rows });
  } catch (err) { next(err); }
});

module.exports = router;

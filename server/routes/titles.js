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

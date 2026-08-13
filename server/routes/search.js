const express = require('express');
const db = require('../db.js');

const router = express.Router();
const LIMIT = 5;

// 資料量在幾千筆等級，ILIKE 完全足夠；不上 pg_trgm 以免多一個 extension 依賴。
router.get('/search/suggest', async (req, res, next) => {
  try {
    const q = (req.query.q ?? '').trim();
    const empty = [
      { type: 'title', label: '書目', items: [] },
      { type: 'copy', label: '單冊編號', items: [] },
      { type: 'borrower', label: '借閱人', items: [] },
      { type: 'shelf', label: '書櫃', items: [] },
    ];
    if (!q) return res.json({ groups: empty });

    const like = `%${q}%`;
    const [titles, copies, borrowers, shelves] = await Promise.all([
      db.query(
        `SELECT id, title, authors, isbn13 FROM titles
          WHERE title ILIKE $1 OR authors ILIKE $1 OR isbn13 ILIKE $1
          ORDER BY title LIMIT ${LIMIT}`, [like]),
      db.query(
        `SELECT cp.id, cp.barcode, cp.status, t.title FROM copies cp
           JOIN titles t ON t.id = cp.title_id
          WHERE cp.barcode ILIKE $1 ORDER BY cp.barcode LIMIT ${LIMIT}`, [like]),
      db.query(
        `SELECT id, name, class_name FROM borrowers
          WHERE name ILIKE $1 OR class_name ILIKE $1 OR code ILIKE $1
          ORDER BY name LIMIT ${LIMIT}`, [like]),
      db.query(
        `SELECT id, code, name FROM shelves
          WHERE name ILIKE $1 OR code ILIKE $1 ORDER BY name LIMIT ${LIMIT}`, [like]),
    ]);

    res.json({
      groups: [
        {
          type: 'title', label: '書目', items: titles.rows.map((r) => ({
            id: r.id, title: r.title,
            subtitle: [r.authors, r.isbn13].filter(Boolean).join(' · '),
            href: `/catalog.html?title=${r.id}`,
          })),
        },
        {
          type: 'copy', label: '單冊編號', items: copies.rows.map((r) => ({
            id: r.id, title: r.barcode,
            subtitle: `${r.title}（${r.status === 'in' ? '在架' : '借出中'}）`,
            href: `/index.html?barcode=${encodeURIComponent(r.barcode)}`,
          })),
        },
        {
          type: 'borrower', label: '借閱人', items: borrowers.rows.map((r) => ({
            id: r.id, title: r.name, subtitle: r.class_name ?? '',
            href: `/borrowers.html?id=${r.id}`,
          })),
        },
        {
          type: 'shelf', label: '書櫃', items: shelves.rows.map((r) => ({
            id: r.id, title: r.name, subtitle: r.code,
            href: `/shelves.html?id=${r.id}`,
          })),
        },
      ],
    });
  } catch (err) { next(err); }
});

module.exports = router;

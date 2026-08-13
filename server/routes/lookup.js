const express = require('express');
const db = require('../db.js');
const net = require('../lib/net-status.js');
const { lookupIsbn } = require('../lib/isbn/index.js');

const router = express.Router();

router.get('/net-status', async (req, res) => {
  res.json({ online: await net.isOnline() });
});

router.get('/lookup/isbn/:isbn', async (req, res, next) => {
  try {
    const isbn = String(req.params.isbn).replace(/[^0-9Xx]/g, '');

    // 1) 本地已建過的書目：離線也查得到，而且能提示「要不要只加冊」
    // 冊數分開查，不用相關子查詢——pg-mem 不支援子查詢參照外層 alias（Unknown alias "t"）。
    const local = await db.query('SELECT * FROM titles WHERE isbn13 = $1', [isbn]);
    if (local.rows.length) {
      const t = local.rows[0];
      const cnt = await db.query('SELECT COUNT(*) AS c FROM copies WHERE title_id = $1', [t.id]);
      return res.json({
        found: true, online: true, source: 'local', titleId: t.id,
        existingCopies: Number(cnt.rows[0].c),
        info: {
          isbn13: t.isbn13, title: t.title, subtitle: t.subtitle, authors: t.authors,
          publisher: t.publisher, published_date: t.published_date,
          description: t.description, coverUrl: t.cover_path, source: 'local',
        },
      });
    }

    // 2) 離線：直接回，不發任何請求，也不讓使用者等 timeout
    if (!(await net.isOnline())) {
      return res.json({ found: false, online: false, info: null });
    }

    // 3) 外部來源
    const apiKey = process.env.GOOGLE_BOOKS_API_KEY ?? '';
    const info = await lookupIsbn(isbn, { apiKey });
    if (!info) {
      // 沒金鑰時 Google provider 根本不發請求，NCL 也還沒接通，等於一本都查不到。
      // 這跟「查了但真的沒這本」是兩回事，前端要顯示的說明完全不同。
      return res.json({
        found: false, online: true, info: null,
        hint: apiKey ? null : 'no-api-key',
      });
    }
    res.json({ found: true, online: true, source: info.source, info });
  } catch (err) { next(err); }
});

module.exports = router;

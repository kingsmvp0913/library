const express = require('express');
const db = require('../db.js');
const { toCsv, parseCsv } = require('../lib/csv.js');
const { nextBarcode } = require('../lib/barcode-no.js');

const router = express.Router();

const BACKUP_VERSION = 1;
// 依 FK 相依順序排列：還原時照這個順序建，清空時倒著刪。
const TABLES = ['categories', 'shelves', 'titles', 'copies', 'borrowers', 'loans', 'counters'];

function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

function fmtTime(v) {
  return v ? new Date(v).toLocaleString('zh-TW') : '';
}

/** 組出「A櫃 · 第2層」用的對照表。 */
async function shelfNameMap() {
  const { rows } = await db.query('SELECT id, name, parent_id FROM shelves');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const label = (id) => {
    const s = byId.get(id);
    if (!s) return '';
    const p = s.parent_id ? byId.get(s.parent_id) : null;
    return p ? `${p.name} · ${s.name}` : s.name;
  };
  return { byId, label };
}

const STATUS_TEXT = { in: '在架', out: '借出中', lost: '遺失', repair: '修繕中' };

router.get('/export/titles.csv', async (req, res, next) => {
  try {
    const { label } = await shelfNameMap();
    const [copies, titles, cats] = await Promise.all([
      db.query('SELECT * FROM copies ORDER BY barcode'),
      db.query('SELECT * FROM titles'),
      db.query('SELECT * FROM categories'),
    ]);
    const titleById = new Map(titles.rows.map((r) => [r.id, r]));
    const catById = new Map(cats.rows.map((r) => [r.id, r]));
    const rows = copies.rows.map((c) => {
      const t = titleById.get(c.title_id) ?? {};
      return [
        c.barcode, t.title, t.authors, t.publisher, t.isbn13,
        catById.get(t.category_id)?.name ?? '',
        label(c.shelf_id), STATUS_TEXT[c.status] ?? c.status, t.description,
      ];
    });
    sendCsv(res, 'titles.csv', toCsv(
      ['編號', '書名', '作者', '出版社', 'ISBN', '類型', '櫃位', '狀態', '備註'], rows
    ));
  } catch (err) { next(err); }
});

router.get('/export/borrowers.csv', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM borrowers ORDER BY name');
    sendCsv(res, 'borrowers.csv', toCsv(
      ['姓名', '班級', '編號', '備註'],
      rows.map((r) => [r.name, r.class_name, r.code, r.note])
    ));
  } catch (err) { next(err); }
});

router.get('/export/loans.csv', async (req, res, next) => {
  try {
    const [loans, copies, titles, borrowers] = await Promise.all([
      db.query('SELECT * FROM loans ORDER BY borrowed_at DESC, id DESC'),
      db.query('SELECT id, barcode, title_id FROM copies'),
      db.query('SELECT id, title FROM titles'),
      db.query('SELECT id, name, class_name FROM borrowers'),
    ]);
    const copyById = new Map(copies.rows.map((r) => [r.id, r]));
    const titleById = new Map(titles.rows.map((r) => [r.id, r]));
    const borrowerById = new Map(borrowers.rows.map((r) => [r.id, r]));
    const rows = loans.rows.map((l) => {
      const cp = copyById.get(l.copy_id);
      const b = borrowerById.get(l.borrower_id);
      return [
        cp?.barcode ?? '', cp ? (titleById.get(cp.title_id)?.title ?? '') : '',
        b?.name ?? '', b?.class_name ?? '',
        fmtTime(l.borrowed_at), fmtTime(l.returned_at),
      ];
    });
    sendCsv(res, 'loans.csv', toCsv(
      ['編號', '書名', '借閱人', '班級', '借出時間', '歸還時間'], rows
    ));
  } catch (err) { next(err); }
});

async function makeBackup() {
  const tables = {};
  for (const t of TABLES) {
    tables[t] = (await db.query(`SELECT * FROM ${t}`)).rows;
  }
  return { version: BACKUP_VERSION, exportedAt: new Date().toISOString(), tables };
}

router.get('/export/backup.json', async (req, res, next) => {
  try {
    res.setHeader('Content-Disposition', 'attachment; filename="library-backup.json"');
    res.json(await makeBackup());
  } catch (err) { next(err); }
});

/** 匯入用的 CSV 標頭，同時是下載範本的內容。 */
const IMPORT_HEADERS = ['書名', '作者', '出版社', 'ISBN', '類型', '櫃位', '冊數', '備註'];

router.get('/import/template.csv', (req, res) => {
  sendCsv(res, 'import-template.csv', toCsv(IMPORT_HEADERS, [
    ['好餓的毛毛蟲', '艾瑞．卡爾', '上誼文化', '9789577625519', '繪本', 'A櫃', '2', ''],
    ['木製積木', '', '', '', '教具', '', '1', '附收納袋'],
  ]));
});

router.post('/import/titles', async (req, res, next) => {
  try {
    const rows = parseCsv(req.body.csv ?? '');
    if (!rows.length) {
      return res.status(400).json({ error: '檔案是空的，或格式不是 CSV' });
    }

    const [cats, shelves] = await Promise.all([
      db.query('SELECT id, name, kind FROM categories'),
      db.query('SELECT id, name, code, parent_id FROM shelves'),
    ]);
    const catByName = new Map(cats.rows.map((c) => [c.name.trim(), c]));
    const shelfByName = new Map();
    for (const s of shelves.rows) {
      shelfByName.set(s.name.trim(), s);
      if (s.code) shelfByName.set(s.code.trim(), s);
    }

    const errors = [];
    let created = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowNo = i + 2;                       // 標頭佔第 1 列
      const title = (r['書名'] ?? '').trim();
      const catName = (r['類型'] ?? '').trim();
      try {
        if (!title) throw new Error('缺少書名');
        const cat = catByName.get(catName);
        if (!cat) throw new Error(`找不到類型「${catName}」`);

        const isbn = (r['ISBN'] ?? '').replace(/[^0-9Xx]/g, '') || null;
        if (isbn) {
          const dup = await db.query('SELECT id FROM titles WHERE isbn13 = $1', [isbn]);
          if (dup.rows.length) throw new Error(`ISBN ${isbn} 已經建過了`);
        }

        const shelfName = (r['櫃位'] ?? '').trim();
        if (shelfName && !shelfByName.has(shelfName)) {
          throw new Error(`找不到櫃位「${shelfName}」`);
        }
        const shelfId = shelfName ? shelfByName.get(shelfName).id : null;
        const n = Math.max(1, Number((r['冊數'] ?? '').trim() || 1));

        const { rows: [t] } = await db.query(
          `INSERT INTO titles (isbn13, title, authors, publisher, description, category_id, source)
           VALUES ($1,$2,$3,$4,$5,$6,'import') RETURNING id`,
          [isbn, title, (r['作者'] ?? '').trim() || null,
            (r['出版社'] ?? '').trim() || null, (r['備註'] ?? '').trim() || null, cat.id]
        );
        for (let k = 0; k < n; k++) {
          const barcode = await nextBarcode(cat.kind);
          await db.query(
            'INSERT INTO copies (barcode, title_id, shelf_id) VALUES ($1,$2,$3)',
            [barcode, t.id, shelfId]
          );
        }
        created++;
      } catch (err) {
        // 一列出錯只記這一列，繼續處理其餘——否則使用者要一次修一個錯。
        errors.push({ row: rowNo, title, message: err.message });
      }
    }

    res.json({ created, errors, total: rows.length });
  } catch (err) { next(err); }
});

router.post('/import/restore', async (req, res, next) => {
  try {
    const backup = req.body.backup;
    if (!backup?.tables || TABLES.some((t) => !Array.isArray(backup.tables[t]))) {
      return res.status(400).json({ error: '這不是有效的備份檔' });
    }
    if (req.body.confirm !== true) {
      return res.status(400).json({ error: '還原會覆蓋目前所有資料，需要明確確認' });
    }

    // 先把現況備起來再動手——還原是不可逆的，沒有這一步就沒有退路。
    const previousBackup = await makeBackup();

    for (const t of [...TABLES].reverse()) await db.query(`DELETE FROM ${t}`);

    // id 重新映射而不是沿用原值。
    // 沿用原值就必須同時推進 SERIAL 的 sequence，否則還原後第一筆新增就撞 primary key；
    // 而推進 sequence 的每一種寫法（pg_get_serial_sequence／setval／ALTER SEQUENCE）
    // 在 pg-mem 都不存在，等於這條路徑永遠測不到。
    // 取捨的關鍵是：使用者認的識別是貼在書上的 barcode，那個原樣保留；
    // 內部 id 使用者從來看不到，換一組沒有實質影響。
    const map = { categories: new Map(), shelves: new Map(), titles: new Map(), borrowers: new Map(), copies: new Map() };
    const restored = {};

    for (const row of backup.tables.categories) {
      const { rows: [n] } = await db.query(
        `INSERT INTO categories (code,name,kind,sort_order,active) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [row.code, row.name, row.kind, row.sort_order ?? 0, row.active ?? true]);
      map.categories.set(row.id, n.id);
    }
    // 先父後子，parent_id 才映射得到
    const shelvesSorted = [...backup.tables.shelves].sort(
      (a, b) => (a.parent_id ? 1 : 0) - (b.parent_id ? 1 : 0));
    for (const row of shelvesSorted) {
      const { rows: [n] } = await db.query(
        `INSERT INTO shelves (code,name,parent_id,note,sort_order,active)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [row.code, row.name, row.parent_id ? map.shelves.get(row.parent_id) ?? null : null,
          row.note ?? null, row.sort_order ?? 0, row.active ?? true]);
      map.shelves.set(row.id, n.id);
    }
    for (const row of backup.tables.titles) {
      const { rows: [n] } = await db.query(
        `INSERT INTO titles (isbn13,title,subtitle,authors,publisher,published_date,
                             description,cover_path,category_id,source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [row.isbn13, row.title, row.subtitle, row.authors, row.publisher, row.published_date,
          row.description, row.cover_path, map.categories.get(row.category_id), row.source ?? 'manual']);
      map.titles.set(row.id, n.id);
    }
    for (const row of backup.tables.borrowers) {
      const { rows: [n] } = await db.query(
        `INSERT INTO borrowers (code,name,class_name,note,active) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [row.code, row.name, row.class_name, row.note ?? null, row.active ?? true]);
      map.borrowers.set(row.id, n.id);
    }
    for (const row of backup.tables.copies) {
      const { rows: [n] } = await db.query(
        `INSERT INTO copies (barcode,title_id,shelf_id,status,note,acquired_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [row.barcode, map.titles.get(row.title_id),
          row.shelf_id ? map.shelves.get(row.shelf_id) ?? null : null,
          row.status ?? 'in', row.note ?? null, row.acquired_at ?? null]);
      map.copies.set(row.id, n.id);
    }
    for (const row of backup.tables.loans) {
      await db.query(
        `INSERT INTO loans (copy_id,borrower_id,borrowed_at,returned_at,return_shelf_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [map.copies.get(row.copy_id), map.borrowers.get(row.borrower_id),
          row.borrowed_at, row.returned_at ?? null,
          row.return_shelf_id ? map.shelves.get(row.return_shelf_id) ?? null : null]);
    }
    // counters 一定要還原：否則下次發號從 1 開始，會撞到已經貼在書上的條碼。
    for (const kind of ['book', 'toy']) {
      const saved = backup.tables.counters.find((c) => c.kind === kind);
      await db.query('INSERT INTO counters (kind, last_no) VALUES ($1,$2)',
        [kind, saved?.last_no ?? 0]);
    }

    for (const t of TABLES) restored[t] = backup.tables[t].length;
    res.json({ ok: true, restored, previousBackup });
  } catch (err) { next(err); }
});

module.exports = router;

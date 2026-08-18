const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db.js');
const { toCsv, parseCsv } = require('../lib/csv.js');
const { toXlsx } = require('../lib/xlsx.js');
const { nextBarcode } = require('../lib/barcode-no.js');
const { mapRows, COVER_MIN_BYTES } = require('../lib/bookbuddy.js');
const { saveCoverFromUrl } = require('../lib/cover.js');
const { isOnline } = require('../lib/net-status.js');

const router = express.Router();

// 備份的產生與保留邏輯集中在 lib/backup.js——啟動時的自動備份也用同一份，
// 兩邊各寫一份遲早會漂移成「手動備份得回來、自動備份還原不了」。
const { makeBackup, listBackups, TABLES, BACKUP_DIR } = require('../lib/backup.js');
const logger = require('../lib/logger.js');

function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

function fmtTime(v) {
  return v ? new Date(v).toLocaleString('zh-TW') : '';
}

/** 書櫃 id → 名稱的對照表（書櫃只有一層）。 */
async function shelfNameMap() {
  const { rows } = await db.query('SELECT id, name FROM shelves');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const label = (id) => byId.get(id)?.name ?? '';
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

/**
 * 標籤機 App 的「Excel 匯入」用的檔案。
 *
 * 為什麼是 .xlsx 不是 CSV：那個匯入功能只吃 Excel 檔。
 * 為什麼是這三欄、而且照這個順序：它們一一對應標籤上由上而下的三個元件
 * （櫃位、條碼、條碼底下的文字）。這個檔不是拿來對帳的，是拿去餵標籤模板的——
 * 書名之類的欄位在 App 裡只會變成拖錯欄位的機會，所以不放。
 * 條碼不用我們畫：App 的條碼元件會把「條碼」那一欄自己轉成條碼，
 * 掃碼槍認的是條碼解出來的字串，只要那一欄是 copies.barcode 就對得上。
 */
const LABEL_HEADERS = ['櫃位', '條碼', '條碼文字'];

async function labelRows(titleIds) {
  const { label } = await shelfNameMap();
  const { rows: copies } = await db.query('SELECT * FROM copies ORDER BY barcode');
  // 整批撈回來再用 JS 篩，不寫成 SQL 的 IN／ANY：館藏規模是幾百到幾千冊，
  // 差別可以忽略，而 titles.csv 也是這樣做的。
  const wanted = titleIds && new Set(titleIds);
  return copies
    .filter((c) => !wanted || wanted.has(c.title_id))
    // 「條碼」與「條碼文字」是同一個值：一欄餵 App 的條碼元件（它自己轉成條碼），
    // 另一欄餵條碼底下那個文字元件。App 是靠「哪一欄拖到哪個元件」對應的，
    // 一個值要餵兩個元件就得出現兩次。
    .map((c) => [label(c.shelf_id), c.barcode, c.barcode]);
}

function sendLabelXlsx(res, rows) {
  if (!rows.length) {
    // 空檔案匯進 App 只會得到「沒有資料」，使用者不會知道是哪一步錯了。
    return res.status(400).json({ error: '這裡面還沒有任何一冊，沒有標籤可以印。請先到館藏頁新增冊數。' });
  }
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="labels.xlsx"');
  res.send(toXlsx(LABEL_HEADERS, rows, '標籤'));
}

router.get('/export/labels.xlsx', async (req, res, next) => {
  try {
    sendLabelXlsx(res, await labelRows(null));
  } catch (err) { next(err); }
});

// 選取的那幾本走 POST：勾一整頁的書時 id 會多到塞不進網址列。
router.post('/export/labels.xlsx', async (req, res, next) => {
  try {
    const ids = (Array.isArray(req.body?.titleIds) ? req.body.titleIds : [])
      .map(Number).filter(Number.isInteger);
    if (!ids.length) return res.status(400).json({ error: '請先勾選要印標籤的書' });
    sendLabelXlsx(res, await labelRows(ids));
  } catch (err) { next(err); }
});

router.get('/logs', (req, res) => {
  res.json({ files: logger.listLogs().reverse() });
});

router.get('/logs/:file', (req, res) => {
  const name = String(req.params.file);
  // 只接受自己產生的檔名格式，杜絕 ../ 之類的路徑穿越
  if (!/^library-\d{4}-\d{2}-\d{2}\.log$/.test(name)) {
    return res.status(400).json({ error: '不是有效的紀錄檔名' });
  }
  const full = path.join(logger.LOG_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: '找不到這份紀錄' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.sendFile(full);
});

router.get('/backups', (req, res) => {
  // 最新的排前面，使用者要救資料時第一個看到的就是最近的
  res.json({ files: listBackups().reverse() });
});

router.get('/backups/:file', (req, res) => {
  const name = String(req.params.file);
  // 只接受自己產生的檔名格式，杜絕 ../ 之類的路徑穿越
  if (!/^auto-[0-9T-]+\.json$/.test(name)) {
    return res.status(400).json({ error: '不是有效的備份檔名' });
  }
  const full = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: '找不到這份備份' });
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.sendFile(full);
});

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

// ---- BookBuddy 專用匯入 ----
// 分成「預覽」與「實際匯入」兩支：BookBuddy 檔沒有櫃位也沒有冊數，
// 那兩件事只有人知道，一定要先讓使用者看過整張表再決定。

const nz = (v) => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
};

/** 頁數欄位：非正整數一律當作沒填，不要把 0 或 NaN 寫進資料庫。 */
const posInt = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

router.post('/import/bookbuddy/preview', async (req, res, next) => {
  try {
    const parsed = mapRows(req.body.csv ?? '');
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const [titles, shelves] = await Promise.all([
      db.query('SELECT id, isbn13, title FROM titles'),
      db.query('SELECT id, name, code FROM shelves'),
    ]);
    const existingByIsbn = new Map();
    for (const t of titles.rows) if (t.isbn13) existingByIsbn.set(t.isbn13, t);
    const shelfByName = new Map();
    for (const s of shelves.rows) {
      shelfByName.set(s.name.trim(), s);
      if (s.code) shelfByName.set(s.code.trim(), s);
    }

    // 重複要在匯入前就攤開。等到匯入完才說「這 8 本已經有了」，
    // 使用者已經分不出哪些是這次建的、哪些是舊的。
    const seen = new Set();
    for (const r of parsed.rows) {
      if (!r.title) {
        r.blocked = '這一列沒有書名';
      } else if (r.isbn13 && existingByIsbn.has(r.isbn13)) {
        r.blocked = `系統裡已經有這本了（${existingByIsbn.get(r.isbn13).title}）`;
      } else if (r.isbn13 && seen.has(r.isbn13)) {
        r.blocked = '同一個檔案裡出現兩次';
      } else {
        r.blocked = null;
      }
      if (r.isbn13) seen.add(r.isbn13);
      r.shelf_id = r.location_hint ? (shelfByName.get(r.location_hint)?.id ?? null) : null;
    }

    res.json({
      rows: parsed.rows,
      total: parsed.rows.length,
      importable: parsed.rows.filter((r) => !r.blocked).length,
    });
  } catch (err) { next(err); }
});

router.post('/import/bookbuddy', async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: '沒有勾選任何要匯入的資料' });

    const { rows: cats } = await db.query('SELECT id, kind FROM categories');
    const catById = new Map(cats.map((c) => [c.id, c]));

    // 封面是選配。離線時整批跳過，不要讓每一列各等一次 timeout——
    // 建檔不該因為抓不到封面而卡住，這跟借還書不依賴網路是同一條規則。
    const online = await isOnline();

    const errors = [];
    let created = 0;
    let copiesCreated = 0;
    let coversSaved = 0;

    for (const r of rows) {
      const rowNo = r.row_no ?? '?';
      const title = String(r.title ?? '').trim();
      try {
        if (!title) throw new Error('缺少書名');
        const cat = catById.get(Number(r.category_id));
        if (!cat) throw new Error('沒有指定類型，或指定的類型已經不存在');

        const isbn = String(r.isbn13 ?? '').replace(/[^0-9Xx]/g, '') || null;
        if (isbn) {
          const dup = await db.query('SELECT id FROM titles WHERE isbn13 = $1', [isbn]);
          if (dup.rows.length) throw new Error(`ISBN ${isbn} 已經建過了`);
        }

        const coverPath = online && r.cover_url
          ? await saveCoverFromUrl(r.cover_url, isbn ?? `bb-${rowNo}`,
            { minBytes: COVER_MIN_BYTES })
          : null;
        if (coverPath) coversSaved++;

        const { rows: [t] } = await db.query(
          `INSERT INTO titles (isbn13, title, subtitle, series, volume, authors, illustrator,
                               translator, publisher, published_date, pages,
                               description, cover_path, category_id, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'bookbuddy') RETURNING id`,
          [isbn, title, nz(r.subtitle), nz(r.series), nz(r.volume), nz(r.authors),
            nz(r.illustrator), nz(r.translator), nz(r.publisher), nz(r.published_date),
            posInt(r.pages), nz(r.description), coverPath, cat.id]
        );

        const n = Math.max(1, Math.min(99, Math.floor(Number(r.copies)) || 1));
        const shelfId = r.shelf_id ? Number(r.shelf_id) : null;
        for (let k = 0; k < n; k++) {
          const barcode = await nextBarcode(cat.kind);
          await db.query(
            `INSERT INTO copies (barcode, title_id, shelf_id, acquired_at)
             VALUES ($1,$2,$3,$4)`,
            [barcode, t.id, shelfId, nz(r.acquired_at)]
          );
          copiesCreated++;
        }
        created++;
      } catch (err) {
        // 一列出錯只記這一列，其餘照樣建立——否則使用者要一次修一個錯。
        errors.push({ row: rowNo, title, message: err.message });
      }
    }

    res.json({ created, copies: copiesCreated, covers: coversSaved, errors, total: rows.length });
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
    // 這串欄位必須跟 titles 的實際欄位保持同步——漏一個，還原就會靜默把那一欄清空，
    // 而備份檔裡明明有值。加欄位時 db.js、匯入、這裡三個地方一起改。
    for (const row of backup.tables.titles) {
      const { rows: [n] } = await db.query(
        `INSERT INTO titles (isbn13,title,subtitle,series,volume,authors,illustrator,translator,
                             publisher,published_date,pages,
                             description,cover_path,category_id,source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [row.isbn13, row.title, row.subtitle, row.series ?? null, row.volume ?? null,
          row.authors, row.illustrator ?? null, row.translator ?? null,
          row.publisher, row.published_date, posInt(row.pages),
          row.description, row.cover_path, map.categories.get(row.category_id),
          row.source ?? 'manual']);
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

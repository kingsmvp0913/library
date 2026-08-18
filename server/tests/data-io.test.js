const request = require('supertest');
const { newDb } = require('pg-mem');
const { parseCsv, BOM } = require('../lib/csv.js');

async function setup() {
  jest.resetModules();
  const mem = newDb({ noAstCoverageCheck: true });
  jest.doMock('pg', () => mem.adapters.createPg());
  jest.doMock('../lib/cover.js', () => ({ saveCoverFromUrl: async () => null, COVER_DIR: '/tmp' }));
  const db = require('../db.js');
  await db.migrate();
  const { createApp } = require('../index.js');
  const app = createApp();
  const { rows: cats } = await db.query('SELECT id, name, kind FROM categories ORDER BY sort_order');
  const { rows: [shelf] } = await db.query(
    `INSERT INTO shelves (code,name) VALUES ('A','A櫃') RETURNING id`);
  return {
    app, db, shelfId: shelf.id,
    bookCat: cats.find((c) => c.kind === 'book'),
    toyCat: cats.find((c) => c.kind === 'toy'),
  };
}

describe('匯出 CSV', () => {
  test('館藏匯出每一冊一列，帶編號與櫃位', async () => {
    const { app, bookCat, shelfId } = await setup();
    await request(app).post('/api/titles').send({
      title: '毛毛蟲', authors: '卡爾', category_id: bookCat.id, copies: 2, shelf_id: shelfId,
    });
    const res = await request(app).get('/api/export/titles.csv').expect(200);
    expect(res.text.startsWith(BOM)).toBe(true);
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(2);
    expect(rows[0]['書名']).toBe('毛毛蟲');
    expect(rows[0]['櫃位']).toBe('A櫃');
    expect(rows.map((r) => r['編號']).sort()).toEqual(['B-000001', 'B-000002']);
  });

  test('借閱人匯出', async () => {
    const { app, db } = await setup();
    await db.query(`INSERT INTO borrowers (name, class_name) VALUES ('小明','小班')`);
    const res = await request(app).get('/api/export/borrowers.csv').expect(200);
    expect(parseCsv(res.text)[0]).toMatchObject({ 姓名: '小明', 班級: '小班' });
  });

  test('借閱紀錄匯出含未歸還標示', async () => {
    const { app, db, bookCat } = await setup();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '毛毛蟲', category_id: bookCat.id, copies: 1 });
    const { rows: [b] } = await db.query(`INSERT INTO borrowers (name) VALUES ('小明') RETURNING id`);
    await request(app).post('/api/loans')
      .send({ barcode: body.copies[0].barcode, borrower_id: b.id });
    const rows = parseCsv((await request(app).get('/api/export/loans.csv').expect(200)).text);
    expect(rows[0]['借閱人']).toBe('小明');
    expect(rows[0]['歸還時間']).toBe('');
  });

  test('回應帶下載用的檔名', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api/export/titles.csv').expect(200);
    expect(res.headers['content-disposition']).toContain('.csv');
  });
});

/**
 * 標籤機 App 的「Excel 匯入」用的檔。內容能不能被那支 App 讀，只有實機能定案；
 * 這裡驗的是「哪幾冊會進到檔案裡」——挑錯冊數是會浪費一整捲貼紙的錯。
 *
 * 檔案是 stored（不壓縮）的 zip，所以裡面的 XML 直接就是可讀的位元組，
 * 不必在這裡再拆一次（zip 結構本身由 xlsx.test.js 覆蓋）。
 */
describe('標籤 Excel 匯出', () => {
  async function twoTitles() {
    const ctx = await setup();
    const a = await request(ctx.app).post('/api/titles').send({
      title: '毛毛蟲', category_id: ctx.bookCat.id, copies: 2, shelf_id: ctx.shelfId,
    });
    const b = await request(ctx.app).post('/api/titles').send({
      title: '小王子', category_id: ctx.bookCat.id, copies: 1,
    });
    return { ...ctx, aId: a.body.title.id, bId: b.body.title.id };
  }

  test('全部匯出：每一冊一列，含編號與櫃位', async () => {
    const { app } = await twoTitles();
    const res = await request(app).get('/api/export/labels.xlsx')
      .responseType('blob').expect(200);
    expect(res.headers['content-disposition']).toContain('.xlsx');
    const text = res.body.toString('utf8');
    expect(text.slice(0, 2)).toBe('PK');
    for (const no of ['B-000001', 'B-000002', 'B-000003']) expect(text).toContain(no);
    expect(text).toContain('A櫃');
  });

  test('只匯出勾選的那本，其他冊不可以混進來', async () => {
    const { app, bId } = await twoTitles();
    const res = await request(app).post('/api/export/labels.xlsx')
      .send({ titleIds: [bId] }).responseType('blob').expect(200);
    const text = res.body.toString('utf8');
    expect(text).toContain('小王子');
    expect(text).not.toContain('毛毛蟲');
    expect(text).toContain('B-000003');
    expect(text).not.toContain('B-000001');
  });

  // 空檔案匯進 App 只會顯示「沒有資料」，使用者無從得知是哪一步錯了。
  test('沒勾任何一本要擋下來，而不是給一個空檔', async () => {
    const { app } = await twoTitles();
    const res = await request(app).post('/api/export/labels.xlsx')
      .send({ titleIds: [] }).expect(400);
    expect(res.body.error).toMatch(/勾選/);
  });

  test('勾到的書底下沒有任何一冊，要講清楚下一步', async () => {
    const { app, db, bookCat } = await setup();
    // 走 API 建的書目一定至少有一冊（`Math.max(1, …)`），所以這條防線只能直接寫一列來測。
    // 冊被刪光的書目在真實資料裡是存在的。
    const { rows: [t] } = await db.query(
      `INSERT INTO titles (title, category_id, source)
       VALUES ('沒有冊的書', $1, 'manual') RETURNING id`, [bookCat.id]);
    const res = await request(app).post('/api/export/labels.xlsx')
      .send({ titleIds: [t.id] }).expect(400);
    expect(res.body.error).toMatch(/新增冊數/);
  });
});

describe('完整備份', () => {
  test('備份含所有資料表', async () => {
    const { app, bookCat } = await setup();
    await request(app).post('/api/titles')
      .send({ title: '毛毛蟲', category_id: bookCat.id, copies: 1 });
    const res = await request(app).get('/api/export/backup.json').expect(200);
    expect(Object.keys(res.body.tables).sort()).toEqual(
      ['borrowers', 'categories', 'copies', 'counters', 'loans', 'shelves', 'titles']
    );
    expect(res.body.tables.titles).toHaveLength(1);
    expect(res.body.version).toBeGreaterThan(0);
  });
});

describe('匯入 CSV', () => {
  test('批量建檔並自動發編號', async () => {
    const { app, bookCat } = await setup();
    const csv = `書名,作者,出版社,ISBN,類型,櫃位,冊數,備註
毛毛蟲,卡爾,上誼,9780000000001,${bookCat.name},A櫃,2,
小紅帽,格林,東方,9780000000002,${bookCat.name},,1,`;
    const res = await request(app).post('/api/import/titles').send({ csv }).expect(200);
    expect(res.body.created).toBe(2);
    expect(res.body.errors).toHaveLength(0);
    const list = await request(app).get('/api/titles');
    expect(list.body).toHaveLength(2);
    expect(list.body.find((t) => t.title === '毛毛蟲').total_copies).toBe(2);
  });

  // 一列有問題不該讓整批中斷，否則使用者永遠不知道還有幾列有問題。
  test('壞掉的列只回報該列，其餘照樣建立', async () => {
    const { app, bookCat } = await setup();
    const csv = `書名,作者,出版社,ISBN,類型,櫃位,冊數,備註
,沒有書名,,,${bookCat.name},,1,
正常書,作者,,,${bookCat.name},,1,
壞類型,作者,,,不存在的類型,,1,`;
    const res = await request(app).post('/api/import/titles').send({ csv }).expect(200);
    expect(res.body.created).toBe(1);
    expect(res.body.errors).toHaveLength(2);
    expect(res.body.errors[0].row).toBe(2);          // 標頭是第 1 列，資料從第 2 列起算
    expect(res.body.errors.map((e) => e.message).join()).toMatch(/書名/);
  });

  test('ISBN 與既有資料重複時回報，不會建出第二筆', async () => {
    const { app, bookCat } = await setup();
    await request(app).post('/api/titles')
      .send({ isbn13: '9780000000001', title: '已存在', category_id: bookCat.id });
    const csv = `書名,作者,出版社,ISBN,類型,櫃位,冊數,備註
毛毛蟲,卡爾,,9780000000001,${bookCat.name},,1,`;
    const res = await request(app).post('/api/import/titles').send({ csv }).expect(200);
    expect(res.body.created).toBe(0);
    expect(res.body.errors[0].message).toMatch(/已經/);
  });

  test('教具也能匯入，編號用 T- 前綴', async () => {
    const { app, toyCat } = await setup();
    const csv = `書名,作者,出版社,ISBN,類型,櫃位,冊數,備註
木製積木,,,,${toyCat.name},,1,附收納袋`;
    const res = await request(app).post('/api/import/titles').send({ csv }).expect(200);
    expect(res.body.created).toBe(1);
    const detail = await request(app).get('/api/titles');
    const t = detail.body.find((x) => x.title === '木製積木');
    const full = await request(app).get(`/api/titles/${t.id}`);
    expect(full.body.copies[0].barcode).toMatch(/^T-/);
    expect(full.body.description).toBe('附收納袋');
  });

  test('空的 CSV 回 400 而不是默默成功', async () => {
    const { app } = await setup();
    await request(app).post('/api/import/titles').send({ csv: '' }).expect(400);
  });
});

describe('還原備份', () => {
  test('沒有明確確認就不還原', async () => {
    const { app } = await setup();
    const backup = (await request(app).get('/api/export/backup.json')).body;
    await request(app).post('/api/import/restore').send({ backup }).expect(400);
  });

  test('還原後資料與備份一致', async () => {
    const { app, db, bookCat } = await setup();
    await request(app).post('/api/titles')
      .send({ title: '毛毛蟲', category_id: bookCat.id, copies: 2 });
    await db.query(`INSERT INTO borrowers (name) VALUES ('小明')`);
    const backup = (await request(app).get('/api/export/backup.json')).body;

    // 還原前先把現況弄髒，確認還原真的有覆蓋
    await request(app).post('/api/titles')
      .send({ title: '不該存在的書', category_id: bookCat.id, copies: 1 });

    const res = await request(app).post('/api/import/restore')
      .send({ backup, confirm: true }).expect(200);
    expect(res.body.restored.titles).toBe(1);

    const list = await request(app).get('/api/titles');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].title).toBe('毛毛蟲');
    expect(list.body[0].total_copies).toBe(2);
  });

  // counters 沒還原的話，下一次新增會從 B-000001 重新發，
  // 跟已經貼在書上的條碼直接撞號。
  test('還原後接著新增，編號不會撞到備份裡已有的號碼', async () => {
    const { app, bookCat } = await setup();
    await request(app).post('/api/titles')
      .send({ title: '毛毛蟲', category_id: bookCat.id, copies: 3 });
    const backup = (await request(app).get('/api/export/backup.json')).body;
    await request(app).post('/api/import/restore').send({ backup, confirm: true }).expect(200);

    // 還原會重建所有資料列，內部 id 會換一組——重新取得目前的類型 id。
    const cats = await request(app).get('/api/categories');
    const newBookCat = cats.body.find((c) => c.kind === 'book');
    const next = await request(app).post('/api/titles')
      .send({ title: '新書', category_id: newBookCat.id, copies: 1 });
    expect(next.body.copies[0].barcode).toBe('B-000004');
  });

  // 還原的 INSERT 是逐欄列出的，加了新欄位卻忘了加進去，備份檔裡有值、還原後變成空的，
  // 而且畫面上不會有任何錯誤——這是最容易靜默掉資料的一條路。
  test('還原不會漏掉套書／繪者／譯者／頁數這些後加的欄位', async () => {
    const { app, db, bookCat } = await setup();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '套書第一集', category_id: bookCat.id, copies: 1 });
    await db.query(
      `UPDATE titles SET series=$1, volume=$2, illustrator=$3, translator=$4, pages=$5
        WHERE id=$6`,
      ['某某套書', '1', '繪者甲', '譯者乙', 40, body.title.id]);

    const backup = (await request(app).get('/api/export/backup.json')).body;
    await request(app).post('/api/import/restore').send({ backup, confirm: true }).expect(200);

    const { rows } = await db.query(
      `SELECT series, volume, illustrator, translator, pages FROM titles WHERE title='套書第一集'`);
    expect(rows[0]).toEqual({
      series: '某某套書', volume: '1', illustrator: '繪者甲', translator: '譯者乙', pages: 40,
    });
  });

  // 內部 id 可以換，但 barcode 絕對不行——它已經印出來貼在實體書上了。
  test('還原後 barcode 與備份完全一致', async () => {
    const { app, bookCat } = await setup();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '毛毛蟲', category_id: bookCat.id, copies: 3 });
    const before = body.copies.map((c) => c.barcode).sort();
    const backup = (await request(app).get('/api/export/backup.json')).body;
    await request(app).post('/api/import/restore').send({ backup, confirm: true }).expect(200);

    const list = await request(app).get('/api/titles');
    const full = await request(app).get(`/api/titles/${list.body[0].id}`);
    expect(full.body.copies.map((c) => c.barcode).sort()).toEqual(before);
  });

  test('還原後借還關聯仍然對得起來', async () => {
    const { app, db, bookCat } = await setup();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '毛毛蟲', category_id: bookCat.id, copies: 1 });
    const { rows: [b] } = await db.query(
      `INSERT INTO borrowers (name) VALUES ('小明') RETURNING id`);
    await request(app).post('/api/loans')
      .send({ barcode: body.copies[0].barcode, borrower_id: b.id });
    const backup = (await request(app).get('/api/export/backup.json')).body;
    await request(app).post('/api/import/restore').send({ backup, confirm: true }).expect(200);

    const loans = await request(app).get('/api/loans?open=1');
    expect(loans.body).toHaveLength(1);
    expect(loans.body[0].borrower_name).toBe('小明');
    expect(loans.body[0].barcode).toBe(body.copies[0].barcode);
  });

  test('還原會回傳還原前的現況備份，避免蓋掉救不回來', async () => {
    const { app, bookCat } = await setup();
    await request(app).post('/api/titles')
      .send({ title: '還原前就有的書', category_id: bookCat.id, copies: 1 });
    const backup = { version: 1, tables: {
      categories: [], shelves: [], titles: [], copies: [], borrowers: [], loans: [], counters: [],
    } };
    const res = await request(app).post('/api/import/restore')
      .send({ backup, confirm: true }).expect(200);
    expect(res.body.previousBackup.tables.titles[0].title).toBe('還原前就有的書');
  });

  test('備份格式不對時回 400', async () => {
    const { app } = await setup();
    await request(app).post('/api/import/restore')
      .send({ backup: { nope: true }, confirm: true }).expect(400);
  });
});

const request = require('supertest');
const { newDb } = require('pg-mem');

async function setup() {
  jest.resetModules();
  const mem = newDb({ noAstCoverageCheck: true });
  jest.doMock('pg', () => mem.adapters.createPg());
  jest.doMock('../lib/cover.js', () => ({ saveCoverFromUrl: async () => null, COVER_DIR: '/tmp' }));
  const db = require('../db.js');
  await db.migrate();
  const { createApp } = require('../index.js');
  const app = createApp();

  const { rows: [cat] } = await db.query(`SELECT id FROM categories WHERE kind='book' LIMIT 1`);
  const { rows: [shelf] } = await db.query(
    `INSERT INTO shelves (code,name) VALUES ('S001','A櫃') RETURNING id`);
  const { body } = await request(app).post('/api/titles')
    .send({ title: '好餓的毛毛蟲', category_id: cat.id, copies: 1, shelf_id: shelf.id });
  const { rows: [borrower] } = await db.query(
    `INSERT INTO borrowers (name, class_name) VALUES ('小明','小班') RETURNING id`);

  return {
    app, db, catId: cat.id,
    barcode: body.copies[0].barcode, copyId: body.copies[0].id,
    borrowerId: borrower.id, shelfId: shelf.id,
  };
}

describe('POST /api/scan', () => {
  test('在架的冊回 borrow 動作與書名', async () => {
    const { app, barcode } = await setup();
    const res = await request(app).post('/api/scan').send({ barcode }).expect(200);
    expect(res.body.action).toBe('borrow');
    expect(res.body.title.title).toBe('好餓的毛毛蟲');
  });

  // 還書時最重要的資訊就是「放回哪一格」。少了它，這套系統對老師沒有意義。
  test('已借出的冊回 return 動作，並附上完整櫃位字串', async () => {
    const { app, barcode, borrowerId } = await setup();
    await request(app).post('/api/loans').send({ barcode, borrower_id: borrowerId });
    const res = await request(app).post('/api/scan').send({ barcode }).expect(200);
    expect(res.body.action).toBe('return');
    expect(res.body.shelfLabel).toBe('A櫃');
    expect(res.body.borrower.name).toBe('小明');
  });

  test('查無此編號回 404 與白話訊息', async () => {
    const { app } = await setup();
    const res = await request(app).post('/api/scan').send({ barcode: 'B-999999' }).expect(404);
    expect(res.body.error).toContain('找不到');
  });
});

describe('POST /api/loans', () => {
  test('借出後單冊狀態變成 out', async () => {
    const { app, db, barcode, borrowerId } = await setup();
    await request(app).post('/api/loans').send({ barcode, borrower_id: borrowerId }).expect(200);
    const { rows } = await db.query('SELECT status FROM copies WHERE barcode = $1', [barcode]);
    expect(rows[0].status).toBe('out');
  });

  // 這是資料完整性的核心：同一冊被借兩次，系統就再也說不清書在誰手上。
  test('已借出的冊不能再借一次', async () => {
    const { app, barcode, borrowerId } = await setup();
    await request(app).post('/api/loans').send({ barcode, borrower_id: borrowerId });
    const res = await request(app).post('/api/loans')
      .send({ barcode, borrower_id: borrowerId }).expect(409);
    expect(res.body.error).toContain('已經借出');
  });

  test('沒有借閱人不能借出', async () => {
    const { app, barcode } = await setup();
    await request(app).post('/api/loans').send({ barcode }).expect(400);
  });
});

describe('POST /api/returns', () => {
  test('歸還後狀態回 in，並回傳要放回的櫃位', async () => {
    const { app, db, barcode, borrowerId } = await setup();
    await request(app).post('/api/loans').send({ barcode, borrower_id: borrowerId });
    const res = await request(app).post('/api/returns').send({ barcode }).expect(200);
    expect(res.body.shelfLabel).toBe('A櫃');
    const { rows } = await db.query('SELECT status FROM copies WHERE barcode = $1', [barcode]);
    expect(rows[0].status).toBe('in');
  });

  test('沒借出的冊不能歸還', async () => {
    const { app, barcode } = await setup();
    await request(app).post('/api/returns').send({ barcode }).expect(409);
  });

  // 沒設櫃位時必須講清楚，不能回空字串讓畫面顯示「請放回：」
  test('未指定櫃位時回明確字樣', async () => {
    const { app, catId, borrowerId } = await setup();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '沒櫃位的書', category_id: catId, copies: 1 });
    const bc = body.copies[0].barcode;
    await request(app).post('/api/loans').send({ barcode: bc, borrower_id: borrowerId });
    const res = await request(app).post('/api/returns').send({ barcode: bc }).expect(200);
    expect(res.body.shelfLabel).toBe('尚未指定櫃位');
  });
});

describe('GET /api/loans', () => {
  test('?open=1 只回未歸還的', async () => {
    const { app, barcode, borrowerId } = await setup();
    await request(app).post('/api/loans').send({ barcode, borrower_id: borrowerId });
    expect((await request(app).get('/api/loans?open=1')).body).toHaveLength(1);
    await request(app).post('/api/returns').send({ barcode });
    expect((await request(app).get('/api/loans?open=1')).body).toHaveLength(0);
    expect((await request(app).get('/api/loans')).body).toHaveLength(1);
  });
});

// 應用層的檢查可能因為改動而失效，資料庫層是最後一道防線。
// 這支測試繞過 API 直接塞第二筆未歸還紀錄，驗證 loans_one_open_per_copy 真的擋得住。
describe('資料庫層防線', () => {
  test('直接 INSERT 重複的未歸還紀錄會被擋下', async () => {
    const { db, copyId, borrowerId } = await setup();
    await db.query('INSERT INTO loans (copy_id, borrower_id) VALUES ($1,$2)', [copyId, borrowerId]);
    await expect(
      db.query('INSERT INTO loans (copy_id, borrower_id) VALUES ($1,$2)', [copyId, borrowerId])
    ).rejects.toThrow();
  });
});

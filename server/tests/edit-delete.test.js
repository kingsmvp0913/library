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
  const { rows: cats } = await db.query('SELECT id, name, kind FROM categories ORDER BY sort_order');
  const { body: shelf } = await request(app).post('/api/shelves').send({ name: 'A櫃' });
  const { rows: [borrower] } = await db.query(
    `INSERT INTO borrowers (name, class_name) VALUES ('小明','小班') RETURNING id`);
  return {
    app, db, shelf, borrowerId: borrower.id,
    bookCat: cats.find((c) => c.kind === 'book'),
    toyCat: cats.find((c) => c.kind === 'toy'),
  };
}

async function makeBook(app, catId, extra = {}) {
  const { body } = await request(app).post('/api/titles')
    .send({ title: '毛毛蟲', category_id: catId, copies: 1, ...extra });
  return body;
}

describe('書目修改', () => {
  test('可以改書名、作者、出版社', async () => {
    const { app, bookCat } = await setup();
    const b = await makeBook(app, bookCat.id);
    const res = await request(app).put(`/api/titles/${b.title.id}`)
      .send({ title: '好餓的毛毛蟲', authors: '艾瑞．卡爾', publisher: '上誼' }).expect(200);
    expect(res.body.title).toBe('好餓的毛毛蟲');
    expect(res.body.authors).toBe('艾瑞．卡爾');
    expect(res.body.publisher).toBe('上誼');
  });

  // 匯進來的資料一定會有打錯的。有欄位卻改不了，等於建了就定生死。
  test('可以改套書、集數、繪者、譯者、頁數', async () => {
    const { app, bookCat } = await setup();
    const b = await makeBook(app, bookCat.id);
    const res = await request(app).put(`/api/titles/${b.title.id}`).send({
      series: '小熊系列', volume: '2', illustrator: '繪者甲', translator: '譯者乙', pages: '36',
    }).expect(200);
    expect(res.body).toMatchObject({
      series: '小熊系列', volume: '2', illustrator: '繪者甲', translator: '譯者乙', pages: 36,
    });
  });

  // 頁數是 INTEGER，收到非數字若直接送進 UPDATE 會噴 500，
  // 連帶同一次送出的其他欄位也全部改不了。
  test('頁數清空或填了非數字都當作沒填，不會讓整筆修改失敗', async () => {
    const { app, bookCat } = await setup();
    const b = await makeBook(app, bookCat.id);
    await request(app).put(`/api/titles/${b.title.id}`).send({ pages: '36' }).expect(200);

    const cleared = await request(app).put(`/api/titles/${b.title.id}`)
      .send({ pages: '', title: '清空頁數後的書名' }).expect(200);
    expect(cleared.body.pages).toBeNull();
    expect(cleared.body.title).toBe('清空頁數後的書名');

    const junk = await request(app).put(`/api/titles/${b.title.id}`)
      .send({ pages: 'abc', authors: '照樣要改到' }).expect(200);
    expect(junk.body.pages).toBeNull();
    expect(junk.body.authors).toBe('照樣要改到');
  });

  test('可以改類型', async () => {
    const { app, bookCat, toyCat } = await setup();
    const b = await makeBook(app, bookCat.id);
    const res = await request(app).put(`/api/titles/${b.title.id}`)
      .send({ category_id: toyCat.id }).expect(200);
    expect(res.body.category_id).toBe(toyCat.id);
  });

  test('可以補填或修改 ISBN', async () => {
    const { app, bookCat } = await setup();
    const b = await makeBook(app, bookCat.id);
    const res = await request(app).put(`/api/titles/${b.title.id}`)
      .send({ isbn13: '978-957-762-551-9' }).expect(200);
    expect(res.body.isbn13).toBe('9789577625519');   // 連字號會被清掉
  });

  // 兩筆書目共用同一個 ISBN，掃碼建檔時就分不出是哪一本。
  test('改成別人已在用的 ISBN 要被擋下', async () => {
    const { app, bookCat } = await setup();
    await makeBook(app, bookCat.id, { isbn13: '9789577625519', title: '甲書' });
    const b = await makeBook(app, bookCat.id, { title: '乙書' });
    const res = await request(app).put(`/api/titles/${b.title.id}`)
      .send({ isbn13: '9789577625519' }).expect(409);
    expect(res.body.error).toMatch(/已經/);
  });

  test('書名不可以改成空的', async () => {
    const { app, bookCat } = await setup();
    const b = await makeBook(app, bookCat.id);
    await request(app).put(`/api/titles/${b.title.id}`).send({ title: '  ' }).expect(400);
  });

  test('找不到的書目回 404', async () => {
    const { app } = await setup();
    await request(app).put('/api/titles/99999').send({ title: 'X' }).expect(404);
  });
});

describe('單冊刪除', () => {
  test('沒有借閱紀錄的冊可以刪除', async () => {
    const { app, bookCat } = await setup();
    const b = await makeBook(app, bookCat.id, { copies: 2 });
    await request(app).delete(`/api/copies/${b.copies[0].id}`).expect(200);
    const full = await request(app).get(`/api/titles/${b.title.id}`);
    expect(full.body.copies).toHaveLength(1);
  });

  test('借出中的冊不可刪除', async () => {
    const { app, bookCat, borrowerId } = await setup();
    const b = await makeBook(app, bookCat.id);
    await request(app).post('/api/loans')
      .send({ barcode: b.copies[0].barcode, borrower_id: borrowerId });
    const res = await request(app).delete(`/api/copies/${b.copies[0].id}`).expect(409);
    expect(res.body.error).toMatch(/借出/);
  });

  // 刪掉有紀錄的冊會讓借閱歷史出現對不到的資料；書弄丟了應該標記遺失而不是刪除。
  test('有借閱紀錄的冊不可刪除，並建議改標記遺失', async () => {
    const { app, bookCat, borrowerId } = await setup();
    const b = await makeBook(app, bookCat.id);
    await request(app).post('/api/loans')
      .send({ barcode: b.copies[0].barcode, borrower_id: borrowerId });
    await request(app).post('/api/returns').send({ barcode: b.copies[0].barcode });
    const res = await request(app).delete(`/api/copies/${b.copies[0].id}`).expect(409);
    expect(res.body.error).toMatch(/遺失|紀錄/);
  });
});

describe('書目刪除', () => {
  test('還有冊的書目不可直接刪除', async () => {
    const { app, bookCat } = await setup();
    const b = await makeBook(app, bookCat.id, { copies: 2 });
    const res = await request(app).delete(`/api/titles/${b.title.id}`).expect(409);
    expect(res.body.error).toMatch(/2/);          // 訊息要講出還有幾冊
  });

  test('冊都刪光後書目就能刪除', async () => {
    const { app, bookCat } = await setup();
    const b = await makeBook(app, bookCat.id);
    await request(app).delete(`/api/copies/${b.copies[0].id}`).expect(200);
    await request(app).delete(`/api/titles/${b.title.id}`).expect(200);
    expect((await request(app).get('/api/titles')).body).toHaveLength(0);
  });
});

describe('刪除防護要講人話', () => {
  test('書櫃還有書時不可刪除，訊息要講出幾本', async () => {
    const { app, bookCat, shelf } = await setup();
    await makeBook(app, bookCat.id, { copies: 3, shelf_id: shelf.id });
    const res = await request(app).delete(`/api/shelves/${shelf.id}`).expect(409);
    expect(res.body.error).toMatch(/3/);
    expect(res.body.error).not.toMatch(/foreign key|constraint/i);   // 不可以是資料庫術語
  });

  test('空書櫃可以刪除', async () => {
    const { app, shelf } = await setup();
    await request(app).delete(`/api/shelves/${shelf.id}`).expect(200);
  });

  test('類型還有館藏時不可刪除', async () => {
    const { app, bookCat } = await setup();
    await makeBook(app, bookCat.id);
    const res = await request(app).delete(`/api/categories/${bookCat.id}`).expect(409);
    expect(res.body.error).not.toMatch(/foreign key|constraint/i);
  });

  test('借閱人有紀錄時不可刪除，並建議改用停用', async () => {
    const { app, bookCat, borrowerId } = await setup();
    const b = await makeBook(app, bookCat.id);
    await request(app).post('/api/loans')
      .send({ barcode: b.copies[0].barcode, borrower_id: borrowerId });
    const res = await request(app).delete(`/api/borrowers/${borrowerId}`).expect(409);
    expect(res.body.error).toMatch(/停用/);
  });

  test('沒有借過的借閱人可以直接刪除', async () => {
    const { app, borrowerId } = await setup();
    await request(app).delete(`/api/borrowers/${borrowerId}`).expect(200);
  });

  // 使用者只想填「繪本」，不該還要自己編一組類型代碼。
  test('類型只填名稱與種類就能建立，代碼自動產生', async () => {
    const { app } = await setup();
    const res = await request(app).post('/api/categories')
      .send({ name: '有聲書', kind: 'book' }).expect(200);
    expect(res.body.code).toMatch(/^C\d{3}$/);
    expect(res.body.name).toBe('有聲書');
  });

  test('類型可以改名', async () => {
    const { app, bookCat } = await setup();
    const res = await request(app).put(`/api/categories/${bookCat.id}`)
      .send({ name: '圖畫書' }).expect(200);
    expect(res.body.name).toBe('圖畫書');
  });

  test('沒有館藏在用的類型可以刪除', async () => {
    const { app } = await setup();
    const { body } = await request(app).post('/api/categories')
      .send({ name: '暫時的類型', kind: 'book' });
    await request(app).delete(`/api/categories/${body.id}`).expect(200);
  });

  // 畢業的小朋友要能從下拉清單消失，但借閱歷史必須留著。
  test('借閱人可以停用', async () => {
    const { app, borrowerId } = await setup();
    const res = await request(app).put(`/api/borrowers/${borrowerId}`)
      .send({ active: false }).expect(200);
    expect(res.body.active).toBe(false);
  });

  test('借閱人清單預設不含已停用的', async () => {
    const { app, borrowerId } = await setup();
    await request(app).put(`/api/borrowers/${borrowerId}`).send({ active: false });
    expect((await request(app).get('/api/borrowers')).body).toHaveLength(0);
    expect((await request(app).get('/api/borrowers?includeInactive=1')).body).toHaveLength(1);
  });
});

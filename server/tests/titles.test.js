const request = require('supertest');
const { newDb } = require('pg-mem');

async function freshApp() {
  jest.resetModules();
  const mem = newDb({ noAstCoverageCheck: true });
  jest.doMock('pg', () => mem.adapters.createPg());
  jest.doMock('../lib/cover.js', () => ({ saveCoverFromUrl: async () => null, COVER_DIR: '/tmp' }));
  const db = require('../db.js');
  await db.migrate();
  const { createApp } = require('../index.js');
  const { rows } = await db.query(`SELECT id, kind FROM categories ORDER BY sort_order`);
  return {
    app: createApp(), db,
    bookCat: rows.find((r) => r.kind === 'book').id,
    toyCat: rows.find((r) => r.kind === 'toy').id,
  };
}

describe('POST /api/titles', () => {
  test('一次建立書目與指定冊數，回傳每一冊的編號', async () => {
    const { app, bookCat } = await freshApp();
    const res = await request(app).post('/api/titles').send({
      isbn13: '9789577625519', title: '好餓的毛毛蟲', category_id: bookCat, copies: 3,
    }).expect(200);
    expect(res.body.copies).toHaveLength(3);
    expect(res.body.copies.map((c) => c.barcode)).toEqual(['B-000001', 'B-000002', 'B-000003']);
  });

  test('教具沒有 ISBN 也能建，編號用 T- 前綴', async () => {
    const { app, toyCat } = await freshApp();
    const res = await request(app).post('/api/titles').send({
      title: '木製積木組', category_id: toyCat, copies: 1,
    }).expect(200);
    expect(res.body.copies[0].barcode).toBe('T-000001');
    expect(res.body.title.isbn13).toBeNull();
  });

  // 沒指定冊數時預設 1 冊。給 0 冊等於建了一筆借不到的書目。
  test('未指定冊數時建 1 冊', async () => {
    const { app, bookCat } = await freshApp();
    const res = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat }).expect(200);
    expect(res.body.copies).toHaveLength(1);
  });

  test('缺書名回 400', async () => {
    const { app, bookCat } = await freshApp();
    await request(app).post('/api/titles').send({ category_id: bookCat }).expect(400);
  });

  test('同一 ISBN 重複建立時回 409，並附上既有書目 id', async () => {
    const { app, bookCat } = await freshApp();
    await request(app).post('/api/titles')
      .send({ isbn13: '9789577625519', title: 'A', category_id: bookCat });
    const res = await request(app).post('/api/titles')
      .send({ isbn13: '9789577625519', title: 'A', category_id: bookCat }).expect(409);
    expect(res.body.titleId).toBeGreaterThan(0);
  });

  test('建立時可直接指定櫃位，每一冊都套用', async () => {
    const { app, db, bookCat } = await freshApp();
    const { rows: [shelf] } = await db.query(
      `INSERT INTO shelves (code, name) VALUES ('A','A櫃') RETURNING id`
    );
    const res = await request(app).post('/api/titles').send({
      title: '測試書', category_id: bookCat, copies: 2, shelf_id: shelf.id,
    }).expect(200);
    expect(res.body.copies.every((c) => c.shelf_id === shelf.id)).toBe(true);
  });
});

describe('POST /api/titles/:id/copies', () => {
  test('加冊會接續既有編號', async () => {
    const { app, bookCat } = await freshApp();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat, copies: 2 });
    const res = await request(app).post(`/api/titles/${body.title.id}/copies`)
      .send({ copies: 2 }).expect(200);
    expect(res.body.copies.map((c) => c.barcode)).toEqual(['B-000003', 'B-000004']);
  });
});

describe('GET /api/titles', () => {
  test('帶回每個書目的總冊數與在架冊數', async () => {
    const { app, bookCat } = await freshApp();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat, copies: 3 });
    const res = await request(app).get('/api/titles').expect(200);
    const row = res.body.find((t) => t.id === body.title.id);
    expect(row.total_copies).toBe(3);
    expect(row.available_copies).toBe(3);
  });

  // 借出一冊之後，在架數要跟著少——這個數字是老師判斷「還有沒有書可借」的依據。
  test('借出的冊不算在在架冊數內', async () => {
    const { app, db, bookCat } = await freshApp();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat, copies: 3 });
    await db.query(`UPDATE copies SET status='out' WHERE id = $1`, [body.copies[0].id]);
    const res = await request(app).get('/api/titles').expect(200);
    const row = res.body.find((t) => t.id === body.title.id);
    expect(row.total_copies).toBe(3);
    expect(row.available_copies).toBe(2);
  });

  test('?q= 同時比對書名、作者與 ISBN', async () => {
    const { app, bookCat } = await freshApp();
    await request(app).post('/api/titles').send({
      title: '好餓的毛毛蟲', authors: '艾瑞．卡爾', isbn13: '9789577625519', category_id: bookCat,
    });
    await request(app).post('/api/titles').send({ title: '不相干的書', category_id: bookCat });
    expect((await request(app).get('/api/titles?q=毛毛蟲')).body).toHaveLength(1);
    expect((await request(app).get('/api/titles?q=艾瑞')).body).toHaveLength(1);
    expect((await request(app).get('/api/titles?q=9789577625519')).body).toHaveLength(1);
  });
});

describe('PUT /api/copies/:id', () => {
  test('可以改單冊的櫃位', async () => {
    const { app, db, bookCat } = await freshApp();
    const { rows: [shelf] } = await db.query(
      `INSERT INTO shelves (code,name) VALUES ('B','B櫃') RETURNING id`);
    const { body } = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat, copies: 1 });
    const res = await request(app).put(`/api/copies/${body.copies[0].id}`)
      .send({ shelf_id: shelf.id }).expect(200);
    expect(res.body.shelf_id).toBe(shelf.id);
  });

  test('可以標記遺失', async () => {
    const { app, bookCat } = await freshApp();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat, copies: 1 });
    const res = await request(app).put(`/api/copies/${body.copies[0].id}`)
      .send({ status: 'lost' }).expect(200);
    expect(res.body.status).toBe('lost');
  });

  // 編號是貼在實體書上的，改了就跟現實對不起來。必須擋。
  test('不可修改編號', async () => {
    const { app, bookCat } = await freshApp();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat, copies: 1 });
    await request(app).put(`/api/copies/${body.copies[0].id}`)
      .send({ barcode: 'B-999999' }).expect(400);
  });

  test('不認得的狀態值要擋下來', async () => {
    const { app, bookCat } = await freshApp();
    const { body } = await request(app).post('/api/titles')
      .send({ title: '測試書', category_id: bookCat, copies: 1 });
    await request(app).put(`/api/copies/${body.copies[0].id}`)
      .send({ status: 'whatever' }).expect(400);
  });
});

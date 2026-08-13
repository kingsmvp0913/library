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
  const { body: shelfA } = await request(app).post('/api/shelves').send({ name: 'A櫃' });
  const { body: shelfB } = await request(app).post('/api/shelves').send({ name: 'B櫃' });
  const { body: ming } = await request(app).post('/api/borrowers')
    .send({ name: '小明', class_name: '小班' });
  const { body: hua } = await request(app).post('/api/borrowers').send({ name: '小華' });
  return { app, db, catId: cat.id, shelfA, shelfB, ming, hua };
}

// 全站搜尋會連到 /borrowers.html?id=、/shelves.html?id=，
// 但那兩頁原本完全沒讀 URL 參數，點下去等於什麼都沒發生。
// 這些端點就是讓那兩個連結真的有東西可看。
describe('借閱人明細：他手上有什麼、借過什麼', () => {
  test('只回這個人的借閱紀錄', async () => {
    const { app, catId, ming, hua } = await setup();
    const { body: bk } = await request(app).post('/api/titles')
      .send({ title: '毛毛蟲', category_id: catId, copies: 2 });
    await request(app).post('/api/loans')
      .send({ barcode: bk.copies[0].barcode, borrower_id: ming.id });
    await request(app).post('/api/loans')
      .send({ barcode: bk.copies[1].barcode, borrower_id: hua.id });

    const res = await request(app).get(`/api/loans?borrower=${ming.id}`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].borrower_name).toBe('小明');
  });

  // 老師最常問的就是「小明借了什麼還沒還」。
  test('可以只看他還沒還的', async () => {
    const { app, catId, ming } = await setup();
    const { body: bk } = await request(app).post('/api/titles')
      .send({ title: '毛毛蟲', category_id: catId, copies: 2 });
    await request(app).post('/api/loans')
      .send({ barcode: bk.copies[0].barcode, borrower_id: ming.id });
    await request(app).post('/api/loans')
      .send({ barcode: bk.copies[1].barcode, borrower_id: ming.id });
    await request(app).post('/api/returns').send({ barcode: bk.copies[0].barcode });

    expect((await request(app).get(`/api/loans?borrower=${ming.id}&open=1`)).body).toHaveLength(1);
    // 已歸還的那筆仍要看得到——loans 的 partial index 很容易讓它憑空消失
    expect((await request(app).get(`/api/loans?borrower=${ming.id}`)).body).toHaveLength(2);
  });

  test('沒借過的人回空陣列，不是錯誤', async () => {
    const { app, hua } = await setup();
    const res = await request(app).get(`/api/loans?borrower=${hua.id}`).expect(200);
    expect(res.body).toEqual([]);
  });
});

describe('書櫃明細：這個櫃子上有哪些書', () => {
  test('只回這個櫃子的冊，並帶出書名', async () => {
    const { app, catId, shelfA, shelfB } = await setup();
    await request(app).post('/api/titles')
      .send({ title: '毛毛蟲', category_id: catId, copies: 2, shelf_id: shelfA.id });
    await request(app).post('/api/titles')
      .send({ title: '小紅帽', category_id: catId, copies: 1, shelf_id: shelfB.id });

    const res = await request(app).get(`/api/copies?shelf=${shelfA.id}`).expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].title).toBe('毛毛蟲');
    expect(res.body[0].barcode).toMatch(/^B-/);
  });

  // 盤點時要一眼看出哪幾本不在架上，否則會白找。
  test('帶得出每一冊目前在不在架上', async () => {
    const { app, catId, shelfA, ming } = await setup();
    const { body: bk } = await request(app).post('/api/titles')
      .send({ title: '毛毛蟲', category_id: catId, copies: 2, shelf_id: shelfA.id });
    await request(app).post('/api/loans')
      .send({ barcode: bk.copies[0].barcode, borrower_id: ming.id });

    const res = await request(app).get(`/api/copies?shelf=${shelfA.id}`).expect(200);
    const out = res.body.filter((c) => c.status === 'out');
    expect(out).toHaveLength(1);
    expect(out[0].borrower_name).toBe('小明');   // 不在架上時要講得出在誰手上
  });

  test('空櫃子回空陣列', async () => {
    const { app, shelfB } = await setup();
    expect((await request(app).get(`/api/copies?shelf=${shelfB.id}`)).body).toEqual([]);
  });

  test('沒帶 shelf 參數不可以整包倒出來', async () => {
    const { app } = await setup();
    await request(app).get('/api/copies').expect(400);
  });
});

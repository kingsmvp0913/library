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
  await db.query(`INSERT INTO shelves (code,name) VALUES ('MAO','毛毛櫃')`);
  await db.query(`INSERT INTO borrowers (name,class_name) VALUES ('毛毛','小班')`);
  const { body } = await request(app).post('/api/titles')
    .send({ title: '好餓的毛毛蟲', category_id: cat.id, copies: 1 });
  return { app, db, barcode: body.copies[0].barcode };
}

describe('GET /api/search/suggest', () => {
  test('同一個關鍵字同時命中書目、借閱人與書櫃', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api/search/suggest?q=毛毛').expect(200);
    const types = res.body.groups.filter((g) => g.items.length).map((g) => g.type);
    expect(types).toEqual(expect.arrayContaining(['title', 'borrower', 'shelf']));
  });

  test('用編號搜得到單冊', async () => {
    const { app, barcode } = await setup();
    const res = await request(app).get(`/api/search/suggest?q=${barcode}`).expect(200);
    const copies = res.body.groups.find((g) => g.type === 'copy');
    expect(copies.items[0].title).toBe(barcode);
  });

  test('每一類最多 5 筆', async () => {
    const { app, db } = await setup();
    for (let i = 0; i < 8; i++) {
      await db.query(`INSERT INTO borrowers (name) VALUES ($1)`, [`毛毛${i}`]);
    }
    const res = await request(app).get('/api/search/suggest?q=毛毛').expect(200);
    expect(res.body.groups.find((g) => g.type === 'borrower').items.length).toBe(5);
  });

  // 空字串若不擋，會把整個資料庫撈出來當建議清單。
  test('空關鍵字回空結果，不撈全表', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api/search/suggest?q=').expect(200);
    expect(res.body.groups.every((g) => g.items.length === 0)).toBe(true);
  });

  test('每一筆都帶可跳轉的 href', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api/search/suggest?q=毛毛').expect(200);
    const all = res.body.groups.flatMap((g) => g.items);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((i) => typeof i.href === 'string' && i.href.length > 0)).toBe(true);
  });

  // 搜尋不到東西時也必須回完整的四組結構，前端才不用處理兩種形狀。
  test('查無結果時仍回四組，只是都空的', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api/search/suggest?q=不可能存在的關鍵字').expect(200);
    expect(res.body.groups.map((g) => g.type)).toEqual(['title', 'copy', 'borrower', 'shelf']);
    expect(res.body.groups.every((g) => g.items.length === 0)).toBe(true);
  });
});

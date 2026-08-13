const request = require('supertest');
const { newDb } = require('pg-mem');

async function freshApp() {
  jest.resetModules();
  const mem = newDb({ noAstCoverageCheck: true });
  jest.doMock('pg', () => mem.adapters.createPg());
  const db = require('../db.js');
  await db.migrate();
  const { createApp } = require('../index.js');
  return { app: createApp(), db };
}

describe('主檔 CRUD', () => {
  test('借閱人可以新增並讀回', async () => {
    const { app } = await freshApp();
    const created = await request(app)
      .post('/api/borrowers')
      .send({ name: '小明', class_name: '小班' })
      .expect(200);
    expect(created.body.id).toBeGreaterThan(0);

    const list = await request(app).get('/api/borrowers').expect(200);
    expect(list.body.map((b) => b.name)).toContain('小明');
  });

  // 下拉要能搜尋，所以 ?q= 必須真的過濾，不能整包回傳讓前端自己篩。
  test('借閱人可用 ?q= 過濾', async () => {
    const { app } = await freshApp();
    await request(app).post('/api/borrowers').send({ name: '小明' });
    await request(app).post('/api/borrowers').send({ name: '小華' });
    const res = await request(app).get('/api/borrowers?q=華').expect(200);
    expect(res.body.map((b) => b.name)).toEqual(['小華']);
  });

  test('缺必填欄位回 400 而非 500', async () => {
    const { app } = await freshApp();
    await request(app).post('/api/borrowers').send({ class_name: '小班' }).expect(400);
  });

  test('可以修改與刪除', async () => {
    const { app } = await freshApp();
    const { body } = await request(app).post('/api/borrowers').send({ name: '小明' });
    await request(app).put(`/api/borrowers/${body.id}`).send({ name: '大明' }).expect(200);
    const after = await request(app).get('/api/borrowers?q=大明');
    expect(after.body.length).toBe(1);
    await request(app).delete(`/api/borrowers/${body.id}`).expect(200);
    expect((await request(app).get('/api/borrowers')).body.length).toBe(0);
  });

  test('安裝時種入的類型讀得到，且圖書與教具都有', async () => {
    const { app } = await freshApp();
    const res = await request(app).get('/api/categories').expect(200);
    expect(new Set(res.body.map((c) => c.kind))).toEqual(new Set(['book', 'toy']));
  });

  test('書櫃可以建立第二層', async () => {
    const { app } = await freshApp();
    const { body: top } = await request(app).post('/api/shelves').send({ code: 'A', name: 'A櫃' });
    await request(app)
      .post('/api/shelves')
      .send({ code: 'A-2', name: '第2層', parent_id: top.id })
      .expect(200);
    const list = await request(app).get('/api/shelves');
    expect(list.body.find((s) => s.code === 'A-2').parent_id).toBe(top.id);
  });

  // 只允許兩層。掛在第二層底下會讓「櫃 · 層」的顯示邏輯無從組起。
  test('書櫃不可建立第三層', async () => {
    const { app } = await freshApp();
    const { body: top } = await request(app).post('/api/shelves').send({ code: 'A', name: 'A櫃' });
    const { body: mid } = await request(app)
      .post('/api/shelves')
      .send({ code: 'A-2', name: '第2層', parent_id: top.id });
    await request(app)
      .post('/api/shelves')
      .send({ code: 'A-2-1', name: '第3層', parent_id: mid.id })
      .expect(400);
  });
});

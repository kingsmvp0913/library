const { newDb } = require('pg-mem');

// noAstCoverageCheck：pg-mem 對「表已存在時的 CREATE TABLE IF NOT EXISTS」會抱怨
// AST 未被完整讀取而拋錯。這是 pg-mem 的限制，不是我們的 SQL 有問題——
// migrate 每次啟動都要能重跑，正式 SQL 不可為了遷就測試環境而改。
function freshDb() {
  jest.resetModules();
  const mem = newDb({ noAstCoverageCheck: true });
  const pg = mem.adapters.createPg();
  jest.doMock('pg', () => pg);
  return require('../db.js');
}

describe('migrate', () => {
  test('建立所有資料表', async () => {
    const db = freshDb();
    await db.migrate();
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`
    );
    const names = rows.map((r) => r.table_name).sort();
    expect(names).toEqual(
      ['borrowers', 'categories', 'copies', 'counters', 'loans', 'shelves', 'titles'].sort()
    );
  });

  // migrate 每次啟動都會跑，不 idempotent 就會讓系統第二次開不起來。
  test('重複執行不會出錯', async () => {
    const db = freshDb();
    await db.migrate();
    await expect(db.migrate()).resolves.not.toThrow();
  });

  // 種子資料若不 idempotent，每次啟動都會多長出一組重複類型。
  test('重複執行不會重複種入類型', async () => {
    const db = freshDb();
    await db.migrate();
    await db.migrate();
    const { rows } = await db.query('SELECT code FROM categories');
    expect(rows.length).toBe(new Set(rows.map((r) => r.code)).size);
  });

  test('種入的類型同時涵蓋圖書與教具', async () => {
    const db = freshDb();
    await db.migrate();
    const { rows } = await db.query('SELECT DISTINCT kind FROM categories');
    expect(rows.map((r) => r.kind).sort()).toEqual(['book', 'toy']);
  });

  // book／toy 是館藏編號，shelf／category 是主檔代碼——
  // 都由系統自動發號，使用者不必自己編。
  test('四種流水號都已備妥且從 0 起算', async () => {
    const db = freshDb();
    await db.migrate();
    const { rows } = await db.query('SELECT kind, last_no FROM counters ORDER BY kind');
    expect(rows).toEqual([
      { kind: 'book', last_no: 0 },
      { kind: 'category', last_no: 0 },
      { kind: 'shelf', last_no: 0 },
      { kind: 'toy', last_no: 0 },
    ]);
  });
});

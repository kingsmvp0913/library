const { newDb } = require('pg-mem');

function freshModules() {
  jest.resetModules();
  const mem = newDb({ noAstCoverageCheck: true });
  jest.doMock('pg', () => mem.adapters.createPg());
  const db = require('../db.js');
  const { nextBarcode } = require('../lib/barcode-no.js');
  return { db, nextBarcode };
}

describe('nextBarcode', () => {
  test('圖書用 B- 前綴，六位補零', async () => {
    const { db, nextBarcode } = freshModules();
    await db.migrate();
    expect(await nextBarcode('book')).toBe('B-000001');
  });

  test('教具用 T- 前綴', async () => {
    const { db, nextBarcode } = freshModules();
    await db.migrate();
    expect(await nextBarcode('toy')).toBe('T-000001');
  });

  // 兩種流水號各自獨立：共用一個計數器的話，取完 book 再取 toy 會拿到 000002。
  test('圖書與教具的流水號互不干擾', async () => {
    const { db, nextBarcode } = freshModules();
    await db.migrate();
    await nextBarcode('book');
    await nextBarcode('book');
    expect(await nextBarcode('toy')).toBe('T-000001');
    expect(await nextBarcode('book')).toBe('B-000003');
  });

  // 「先 SELECT 再 UPDATE」的寫法在這裡會產生重號。
  test('併發取號不重號', async () => {
    const { db, nextBarcode } = freshModules();
    await db.migrate();
    const got = await Promise.all(Array.from({ length: 20 }, () => nextBarcode('book')));
    expect(new Set(got).size).toBe(20);
  });

  test('未知的 kind 要明確拋錯，不可默默給錯前綴', async () => {
    const { db, nextBarcode } = freshModules();
    await db.migrate();
    await expect(nextBarcode('unknown')).rejects.toThrow();
  });
});

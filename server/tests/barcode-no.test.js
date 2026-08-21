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

describe('canonicalBarcode', () => {
  const { canonicalBarcode } = require('../lib/barcode-no.js');

  test('補回掃碼槍吃掉的橫槓', () => {
    expect(canonicalBarcode('B000001')).toBe('B-000001');
    expect(canonicalBarcode('T000123')).toBe('T-000123');
  });

  test('已經正規的編號原樣通過', () => {
    expect(canonicalBarcode('B-000001')).toBe('B-000001');
  });

  // ISBN、書名等其他掃碼／輸入不能被這層改掉。
  test('不是編號格式的字串原樣退回', () => {
    expect(canonicalBarcode('9789573317249')).toBe('9789573317249');
    expect(canonicalBarcode('  好餓的毛毛蟲 ')).toBe('好餓的毛毛蟲');
    expect(canonicalBarcode('X000001')).toBe('X000001');
  });
});

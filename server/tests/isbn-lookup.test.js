const fs = require('fs');
const path = require('path');
const request = require('supertest');

const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ncl-sample.html'), 'utf8');

function okJson(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}
function okText(text) {
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });
}

const GOOGLE_HIT = {
  totalItems: 1,
  items: [{
    volumeInfo: {
      title: '好餓的毛毛蟲',
      authors: ['艾瑞．卡爾'],
      publisher: '上誼文化',
      publishedDate: '2018-03',
      description: '一隻毛毛蟲的故事',
      imageLinks: { thumbnail: 'http://books.google.com/cover.jpg' },
    },
  }],
};

describe('google-books provider', () => {
  test('解析出標準格式，作者陣列合併成字串', async () => {
    const { lookup } = require('../lib/isbn/google-books.js');
    const info = await lookup('9789577625519', {
      apiKey: 'k', fetchImpl: () => okJson(GOOGLE_HIT),
    });
    expect(info).toMatchObject({
      title: '好餓的毛毛蟲', authors: '艾瑞．卡爾', publisher: '上誼文化', source: 'google',
    });
    expect(info.coverUrl).toContain('cover.jpg');
  });

  test('查無資料回 null 而不是拋錯', async () => {
    const { lookup } = require('../lib/isbn/google-books.js');
    await expect(lookup('9789577625519', {
      apiKey: 'k', fetchImpl: () => okJson({ totalItems: 0 }),
    })).resolves.toBeNull();
  });

  // 429 是配額爆掉，代表「這個來源現在不能用」，必須讓上層換下一個來源，
  // 不能跟「查無此書」混為一談。
  test('配額爆掉(429)要拋錯讓上層換來源', async () => {
    const { lookup } = require('../lib/isbn/google-books.js');
    await expect(lookup('9789577625519', {
      apiKey: 'k', fetchImpl: () => Promise.resolve({ ok: false, status: 429 }),
    })).rejects.toThrow();
  });

  test('沒有金鑰時直接回 null，不發請求', async () => {
    const { lookup } = require('../lib/isbn/google-books.js');
    const fetchImpl = jest.fn();
    await expect(lookup('9789577625519', { apiKey: '', fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('ncl provider', () => {
  test('從 HTML 解析出書目', async () => {
    const { lookup } = require('../lib/isbn/ncl.js');
    const info = await lookup('9789577625519', { fetchImpl: () => okText(SAMPLE) });
    expect(info).toMatchObject({
      title: '好餓的毛毛蟲', authors: '艾瑞．卡爾', publisher: '上誼文化', source: 'ncl',
    });
  });

  // 對方改版時 HTML 會完全不同。解析不出來必須當「查無」，絕不可讓例外冒泡炸掉整個查詢。
  test('HTML 格式不符時回 null 而不是拋錯', async () => {
    const { lookup } = require('../lib/isbn/ncl.js');
    await expect(lookup('9789577625519', {
      fetchImpl: () => okText('<html><body>找不到</body></html>'),
    })).resolves.toBeNull();
  });
});

describe('lookupIsbn 協調', () => {
  test('Google 有結果就不再問 NCL', async () => {
    const { lookupIsbn } = require('../lib/isbn/index.js');
    const google = { lookup: jest.fn().mockResolvedValue({ title: 'G', source: 'google' }) };
    const ncl = { lookup: jest.fn() };
    const info = await lookupIsbn('9789577625519', { providers: [google, ncl], apiKey: 'k' });
    expect(info.title).toBe('G');
    expect(ncl.lookup).not.toHaveBeenCalled();
  });

  test('Google 爆掉時換 NCL 接手', async () => {
    const { lookupIsbn } = require('../lib/isbn/index.js');
    const google = { lookup: jest.fn().mockRejectedValue(new Error('429')) };
    const ncl = { lookup: jest.fn().mockResolvedValue({ title: 'N', source: 'ncl' }) };
    const info = await lookupIsbn('9789577625519', { providers: [google, ncl], apiKey: 'k' });
    expect(info.title).toBe('N');
  });

  test('全部來源都失敗時回 null，不拋錯', async () => {
    const { lookupIsbn } = require('../lib/isbn/index.js');
    const bad = { lookup: jest.fn().mockRejectedValue(new Error('boom')) };
    await expect(lookupIsbn('9789577625519', { providers: [bad, bad], apiKey: 'k' }))
      .resolves.toBeNull();
  });
});

describe('GET /api/lookup/isbn/:isbn', () => {
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

  test('已建過的 ISBN 直接從本地回，並附上現有冊數', async () => {
    const { app, db } = await freshApp();
    const { rows: [cat] } = await db.query(`SELECT id FROM categories WHERE kind='book' LIMIT 1`);
    const { rows: [t] } = await db.query(
      `INSERT INTO titles (isbn13, title, category_id) VALUES ($1,$2,$3) RETURNING id`,
      ['9789577625519', '好餓的毛毛蟲', cat.id]
    );
    await db.query(`INSERT INTO copies (barcode, title_id) VALUES ('B-000001', $1)`, [t.id]);

    const res = await request(app).get('/api/lookup/isbn/9789577625519').expect(200);
    expect(res.body.found).toBe(true);
    expect(res.body.source).toBe('local');
    expect(res.body.existingCopies).toBe(1);
  });

  // 沒有金鑰時 Google provider 直接回 null 不發請求，NCL 又還沒接通，
  // 結果是「所有 ISBN 都查不到」。前端若只說「查不到這本書」，使用者會以為是那本書的問題，
  // 實際上是整個自動補資料沒有生效——必須回報得出來，才能顯示正確的說明。
  // 金鑰的來源是設定檔（使用者從設定頁改），不是環境變數。
  test('沒有設定金鑰時要回報 no-api-key，而不是單純的查無', async () => {
    const { app } = await freshApp();
    require('../lib/settings.js').updateConfig({ GOOGLE_BOOKS_API_KEY: '' });
    const res = await request(app).get('/api/lookup/isbn/9786264063463').expect(200);
    expect(res.body.found).toBe(false);
    expect(res.body.hint).toBe('no-api-key');
  });

  test('有金鑰時查無資料不該回 no-api-key', async () => {
    const { app } = await freshApp();
    require('../lib/settings.js').updateConfig({ GOOGLE_BOOKS_API_KEY: 'dummy-key' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ totalItems: 0 }), text: async () => '',
    });
    const res = await request(app).get('/api/lookup/isbn/9786264063463').expect(200);
    expect(res.body.found).toBe(false);
    expect(res.body.hint).not.toBe('no-api-key');
  });

  // 這是離線需求的核心斷言：不只是「回得快」，而是「完全沒發出請求」。
  test('離線時直接回 online:false，且完全不發網路請求', async () => {
    jest.resetModules();
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    jest.doMock('../lib/net-status.js', () => ({
      isOnline: async () => false, markOffline: () => {}, resetCache: () => {},
    }));
    const { newDb: nd } = require('pg-mem');
    const mem = nd({ noAstCoverageCheck: true });
    jest.doMock('pg', () => mem.adapters.createPg());
    const db = require('../db.js');
    await db.migrate();
    const { createApp } = require('../index.js');

    const res = await request(createApp()).get('/api/lookup/isbn/9789577625519').expect(200);
    expect(res.body.online).toBe(false);
    expect(res.body.found).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

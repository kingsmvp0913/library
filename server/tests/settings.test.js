const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { newDb } = require('pg-mem');

function tmpConfig(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-cfg-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(initial ?? {}), 'utf8');
  return p;
}

async function setup(initialConfig) {
  jest.resetModules();
  const mem = newDb({ noAstCoverageCheck: true });
  jest.doMock('pg', () => mem.adapters.createPg());
  jest.doMock('../lib/cover.js', () => ({ saveCoverFromUrl: async () => null, COVER_DIR: '/tmp' }));
  const settings = require('../lib/settings.js');
  const cfgPath = tmpConfig(initialConfig);
  settings.setConfigPath(cfgPath);
  const db = require('../db.js');
  await db.migrate();
  const { createApp } = require('../index.js');
  return { app: createApp(), settings, cfgPath };
}

describe('設定讀寫', () => {
  test('金鑰只回遮蔽後的字串，不回完整值', async () => {
    const { app } = await setup({ GOOGLE_BOOKS_API_KEY: 'AIzaSyABCDEFGHIJKLMNOP1234567890' });
    const res = await request(app).get('/api/settings').expect(200);
    expect(res.body.googleBooksApiKeyMasked).toContain('AIza');
    expect(res.body.googleBooksApiKeyMasked).toContain('7890');
    expect(res.body.googleBooksApiKeyMasked).not.toBe('AIzaSyABCDEFGHIJKLMNOP1234567890');
    expect(JSON.stringify(res.body)).not.toContain('ABCDEFGHIJKLMNOP');
    expect(res.body.hasGoogleBooksApiKey).toBe(true);
  });

  test('沒有金鑰時明確回報未設定', async () => {
    const { app } = await setup({});
    const res = await request(app).get('/api/settings').expect(200);
    expect(res.body.hasGoogleBooksApiKey).toBe(false);
    expect(res.body.googleBooksApiKeyMasked).toBe('');
  });

  test('存進去的金鑰會寫回設定檔', async () => {
    const { app, cfgPath } = await setup({ PORT: 3940 });
    await request(app).put('/api/settings')
      .send({ googleBooksApiKey: 'AIzaNEWKEY1234567890' }).expect(200);
    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(saved.GOOGLE_BOOKS_API_KEY).toBe('AIzaNEWKEY1234567890');
    expect(saved.PORT).toBe(3940);            // 其他設定不可被蓋掉
  });

  // 使用者在網頁存了金鑰卻要重開系統才生效，等於這個功能沒做。
  test('存完不必重啟，下一次查詢就用新金鑰', async () => {
    const { app } = await setup({});
    const seen = [];
    global.fetch = jest.fn(async (url) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({ totalItems: 0 }), text: async () => '' };
    });

    // 還沒設定：應該回報 no-api-key，而且完全不打 Google
    const before = await request(app).get('/api/lookup/isbn/9789577625519').expect(200);
    expect(before.body.hint).toBe('no-api-key');
    expect(seen.some((u) => u.includes('googleapis'))).toBe(false);

    await request(app).put('/api/settings')
      .send({ googleBooksApiKey: 'AIzaLIVEKEY' }).expect(200);

    const after = await request(app).get('/api/lookup/isbn/9789577625519').expect(200);
    expect(after.body.hint).not.toBe('no-api-key');
    expect(seen.some((u) => u.includes('googleapis') && u.includes('AIzaLIVEKEY'))).toBe(true);
  });

  test('清空金鑰後回到未設定狀態', async () => {
    const { app } = await setup({ GOOGLE_BOOKS_API_KEY: 'AIzaOLD1234567890' });
    await request(app).put('/api/settings').send({ googleBooksApiKey: '' }).expect(200);
    const res = await request(app).get('/api/settings');
    expect(res.body.hasGoogleBooksApiKey).toBe(false);
  });

  test('前後空白會被去掉（貼上時很容易多帶）', async () => {
    const { app, cfgPath } = await setup({});
    await request(app).put('/api/settings')
      .send({ googleBooksApiKey: '  AIzaPADDED123  ' }).expect(200);
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).GOOGLE_BOOKS_API_KEY)
      .toBe('AIzaPADDED123');
  });

  // 資料庫連線改錯會讓系統整個開不起來，不該從網頁改。
  test('不接受從網頁修改資料庫連線', async () => {
    const { app, cfgPath } = await setup({ DATABASE_URL: 'postgres://original/db' });
    await request(app).put('/api/settings')
      .send({ DATABASE_URL: 'postgres://hacked/db', googleBooksApiKey: 'AIzaX' }).expect(200);
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).DATABASE_URL)
      .toBe('postgres://original/db');
  });
});

describe('測試金鑰按鈕', () => {
  test('金鑰有效時回 ok', async () => {
    const { app } = await setup({});
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ totalItems: 1, items: [{ volumeInfo: { title: 'X' } }] }),
    });
    const res = await request(app).post('/api/settings/test-key')
      .send({ googleBooksApiKey: 'AIzaGOOD' }).expect(200);
    expect(res.body.ok).toBe(true);
  });

  // 三種失敗原因要分開講：金鑰錯、配額爆、沒網路，處理方式完全不同。
  test('金鑰無效(403)要講是金鑰的問題', async () => {
    const { app } = await setup({});
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 403, json: async () => ({ error: { message: 'API key not valid' } }),
    });
    const res = await request(app).post('/api/settings/test-key')
      .send({ googleBooksApiKey: 'AIzaBAD' }).expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/金鑰|啟用/);
  });

  test('配額爆掉(429)要講是配額不是金鑰', async () => {
    const { app } = await setup({});
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 429, json: async () => ({ error: { message: 'Quota exceeded' } }),
    });
    const res = await request(app).post('/api/settings/test-key')
      .send({ googleBooksApiKey: 'AIzaQ' }).expect(200);
    expect(res.body.message).toMatch(/配額|次數/);
  });

  test('連不到網路時講網路，不要誤導成金鑰錯', async () => {
    const { app } = await setup({});
    global.fetch = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const res = await request(app).post('/api/settings/test-key')
      .send({ googleBooksApiKey: 'AIzaN' }).expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/網路|連線/);
  });

  test('沒填金鑰就按測試要回 400', async () => {
    const { app } = await setup({});
    await request(app).post('/api/settings/test-key').send({ googleBooksApiKey: '' }).expect(400);
  });

  // 測試時用的是使用者剛貼上、還沒儲存的金鑰
  test('測試用的是送來的金鑰，不是已存檔的那把', async () => {
    const { app } = await setup({ GOOGLE_BOOKS_API_KEY: 'AIzaSAVED' });
    let used = '';
    global.fetch = jest.fn(async (url) => {
      used = String(url);
      return { ok: true, status: 200, json: async () => ({ totalItems: 1, items: [{ volumeInfo: {} }] }) };
    });
    await request(app).post('/api/settings/test-key').send({ googleBooksApiKey: 'AIzaTYPED' });
    expect(used).toContain('AIzaTYPED');
    expect(used).not.toContain('AIzaSAVED');
  });
});

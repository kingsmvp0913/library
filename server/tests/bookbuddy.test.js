const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { newDb } = require('pg-mem');

// 用真的 BookBuddy 匯出檔（79 欄標頭、只截短 Summary）當樣本。
// 自己編一份「看起來像」的 CSV 驗不到欄名對不對——對方的欄名才是這條流程的前提。
// 前 4 列是真資料；第 5 列「測試用套書第三集」是合成的，因為真檔的
// Series／Volume／Illustrator／Translator 全是空的，光靠真實列驗不到那幾個欄位。
const SAMPLE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'bookbuddy-sample.csv'), 'utf8');

async function setup({ online = true } = {}) {
  jest.resetModules();
  const mem = newDb({ noAstCoverageCheck: true });
  jest.doMock('pg', () => mem.adapters.createPg());

  const saveCover = jest.fn(async () => '/covers/fake.jpg');
  jest.doMock('../lib/cover.js', () => ({ saveCoverFromUrl: saveCover, COVER_DIR: '/tmp' }));
  const isOnline = jest.fn(async () => online);
  jest.doMock('../lib/net-status.js', () => ({
    isOnline, markOffline: () => {}, resetCache: () => {},
  }));

  const db = require('../db.js');
  await db.migrate();
  const { createApp } = require('../index.js');
  const app = createApp();
  const { rows: cats } = await db.query('SELECT id, name, kind FROM categories ORDER BY sort_order');
  const { rows: [shelf] } = await db.query(
    `INSERT INTO shelves (code,name) VALUES ('A','A櫃') RETURNING id`);
  return {
    app, db, saveCover, isOnline, shelfId: shelf.id,
    bookCat: cats.find((c) => c.kind === 'book'),
    toyCat: cats.find((c) => c.kind === 'toy'),
  };
}

const preview = (app, csv = SAMPLE) =>
  request(app).post('/api/import/bookbuddy/preview').send({ csv });

const byTitle = (rows, t) => rows.find((r) => r.title === t);

describe('BookBuddy 預覽', () => {
  test('讀得懂真實匯出檔，欄位全部預填', async () => {
    const { app } = await setup();
    const { body } = await preview(app).expect(200);
    expect(body.total).toBe(5);
    expect(body.importable).toBe(5);

    const r = byTitle(body.rows, '123生台灣');
    expect(r).toMatchObject({
      authors: '陳盈帆',
      publisher: '聯經出版事業公司',
      isbn13: '9789570860405',
      published_date: '2021-10-28',
      acquired_at: '2026-08-13',
    });
    expect(r.description).toContain('繼銷售長紅');
  });

  // 副標、出版日兩種來源、登錄日期是這次特地補上的欄位，
  // 少接哪一個都不會噴錯、只會安靜地缺資料。
  test('Subtitle 接得到，出版日沒有完整日期時退回年份', async () => {
    const { app } = await setup();
    const { body } = await preview(app).expect(200);
    expect(byTitle(body.rows, '警告').subtitle).toBe('不要打開這本書');
    expect(byTitle(body.rows, '大象去玩水').published_date).toBe('2015');
    expect(byTitle(body.rows, '警告').published_date).toBeNull();
  });

  // 套書、繪者、譯者、頁數是後來才補的欄位。這幾個少接哪一個都不會噴錯，
  // 只會安靜地缺資料——所以要同時斷言「有值的抓得到」與「沒值的是 null」。
  test('套書／集數／繪者／譯者／頁數都接得到', async () => {
    const { app } = await setup();
    const { body } = await preview(app).expect(200);
    expect(byTitle(body.rows, '測試用套書第三集')).toMatchObject({
      series: '測試用套書', volume: '3',
      illustrator: '繪者乙', translator: '譯者丙', pages: 32,
    });
  });

  test('BookBuddy 沒填的欄位是 null，不是空字串', async () => {
    const { app } = await setup();
    const { body } = await preview(app).expect(200);
    const r = byTitle(body.rows, '大象去玩水');
    expect(r.series).toBeNull();
    expect(r.volume).toBeNull();
    expect(r.illustrator).toBeNull();
    expect(r.translator).toBeNull();
    expect(r.pages).toBeNull();          // Number of Pages 空白 ≠ 0 頁
  });

  test('真實列的頁數也抓得到', async () => {
    const { app } = await setup();
    const { body } = await preview(app).expect(200);
    expect(byTitle(body.rows, '123生台灣').pages).toBe(48);
  });

  // BookBuddy 沒有封面欄位，只有 Google VolumeID——沒接這個就一張封面都抓不到。
  test('有 Google VolumeID 的列組得出封面網址，沒有的列是 null', async () => {
    const { app } = await setup();
    const { body } = await preview(app).expect(200);
    expect(byTitle(body.rows, '123生台灣').cover_url).toContain('N6BKEAAAQBAJ');
    expect(byTitle(body.rows, '警告').cover_url).toBeNull();
  });

  test('櫃位與冊數不從檔案猜，一律留給使用者選', async () => {
    const { app } = await setup();
    const { body } = await preview(app).expect(200);
    for (const r of body.rows) {
      expect(r.shelf_id).toBeNull();      // Physical Location 是空的
      expect(r.copies).toBe(1);           // Quantity 是空的，不能當成 0 冊
    }
  });

  test('不是 BookBuddy 的 CSV 直接擋下來，並告訴使用者下一步', async () => {
    const { app } = await setup();
    const res = await preview(app, '書名,作者\n毛毛蟲,卡爾').expect(400);
    expect(res.body.error).toMatch(/BookBuddy/);
    expect(res.body.error).toMatch(/匯出/);
  });

  test('空檔回 400 而不是默默成功', async () => {
    const { app } = await setup();
    await preview(app, '').expect(400);
  });
});

describe('BookBuddy 預覽的重複偵測', () => {
  // 匯入完才說「這幾本已經有了」，使用者已經分不出哪些是這次建的。
  test('系統裡已有的 ISBN 在預覽就標出來，且不計入可匯入數', async () => {
    const { app, bookCat } = await setup();
    await request(app).post('/api/titles')
      .send({ isbn13: '9789570860405', title: '舊的123生台灣', category_id: bookCat.id });

    const { body } = await preview(app).expect(200);
    expect(body.total).toBe(5);
    expect(body.importable).toBe(4);
    expect(byTitle(body.rows, '123生台灣').blocked).toMatch(/已經有/);
    expect(byTitle(body.rows, '大象去玩水').blocked).toBeNull();
  });

  test('同一個檔案裡出現兩次時，只放行第一列', async () => {
    const { app } = await setup();
    const lines = SAMPLE.split('\n').filter((l) => l.trim());
    const doubled = [...lines, lines[1]].join('\n');   // lines[0] 是標頭

    const { body } = await preview(app, doubled).expect(200);
    expect(body.total).toBe(6);
    expect(body.importable).toBe(5);
    const dupes = body.rows.filter((r) => r.title === '123生台灣');
    expect(dupes[0].blocked).toBeNull();
    expect(dupes[1].blocked).toMatch(/兩次/);
  });
});

describe('BookBuddy 實際匯入', () => {
  /** 走完整流程：預覽 → 帶上使用者選的類型／櫃位／冊數 → 匯入。 */
  async function importAll(ctx, pick = {}) {
    const { body } = await preview(ctx.app).expect(200);
    const rows = body.rows.filter((r) => !r.blocked).map((r) => ({
      ...r,
      category_id: pick.category_id ?? ctx.bookCat.id,
      shelf_id: pick.shelf_id ?? ctx.shelfId,
      copies: pick.copies ?? 2,
    }));
    return request(ctx.app).post('/api/import/bookbuddy').send({ rows }).expect(200);
  }

  test('使用者選的櫃位與冊數會蓋過檔案裡的值', async () => {
    const ctx = await setup();
    const res = await importAll(ctx, { copies: 3 });
    expect(res.body.created).toBe(5);
    expect(res.body.copies).toBe(15);
    expect(res.body.errors).toHaveLength(0);

    const list = await request(ctx.app).get('/api/titles');
    const t = list.body.find((x) => x.title === '大象去玩水');
    expect(t.total_copies).toBe(3);
    const full = await request(ctx.app).get(`/api/titles/${t.id}`);
    expect(full.body.copies.every((c) => c.shelf_name === 'A櫃')).toBe(true);
    expect(full.body.copies[0].barcode).toMatch(/^B-/);
  });

  test('登錄日期寫進單冊，出版日與副標寫進書目', async () => {
    const ctx = await setup();
    await importAll(ctx, { copies: 1 });

    const { rows } = await ctx.db.query(
      `SELECT t.title, t.subtitle, t.published_date, t.source, c.acquired_at
         FROM titles t JOIN copies c ON c.title_id = t.id WHERE t.title = '警告'`);
    expect(rows[0].subtitle).toBe('不要打開這本書');
    expect(rows[0].source).toBe('bookbuddy');
    expect(String(new Date(rows[0].acquired_at).toISOString()).slice(0, 10)).toBe('2026-08-13');
  });

  // 預覽對了不代表寫得進去——INSERT 的欄位清單漏一個，畫面上完全看不出來。
  test('套書／繪者／譯者／頁數真的寫進資料庫', async () => {
    const ctx = await setup();
    await importAll(ctx, { copies: 1 });

    const { rows } = await ctx.db.query(
      `SELECT series, volume, illustrator, translator, pages FROM titles
        WHERE title = '測試用套書第三集'`);
    expect(rows[0]).toEqual({
      series: '測試用套書', volume: '3',
      illustrator: '繪者乙', translator: '譯者丙', pages: 32,
    });
  });

  test('教具類型也走同一條路，編號用 T- 前綴', async () => {
    const ctx = await setup();
    await importAll(ctx, { category_id: ctx.toyCat.id, copies: 1 });
    const list = await request(ctx.app).get('/api/titles');
    const full = await request(ctx.app).get(`/api/titles/${list.body[0].id}`);
    expect(full.body.copies[0].barcode).toMatch(/^T-/);
  });

  test('沒指定類型的列只擋那一列，其餘照樣建立', async () => {
    const ctx = await setup();
    const { body } = await preview(ctx.app).expect(200);
    const rows = body.rows.map((r, i) => ({
      ...r, category_id: i === 0 ? null : ctx.bookCat.id, shelf_id: null, copies: 1,
    }));
    const res = await request(ctx.app).post('/api/import/bookbuddy').send({ rows }).expect(200);
    expect(res.body.created).toBe(4);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].message).toMatch(/類型/);
  });

  test('沒勾任何一列時回 400，不是默默成功', async () => {
    const { app } = await setup();
    await request(app).post('/api/import/bookbuddy').send({ rows: [] }).expect(400);
  });

  test('線上時封面會下載落檔，沒有 VolumeID 的那一列不算', async () => {
    const ctx = await setup({ online: true });
    const res = await importAll(ctx, { copies: 1 });
    expect(res.body.covers).toBe(3);                 // 5 列裡「警告」與合成列沒有 VolumeID
    expect(ctx.saveCover).toHaveBeenCalledTimes(3);
  });

  // 離線是正常狀態。這裡要斷言「完全沒發出下載請求」，
  // 只驗 covers=0 分不出「發了但失敗」與「根本沒發」——前者會讓使用者空等 4 次 timeout。
  test('離線時完全不嘗試下載封面，書照樣建得起來', async () => {
    const ctx = await setup({ online: false });
    const res = await importAll(ctx, { copies: 1 });
    expect(res.body.created).toBe(5);
    expect(res.body.covers).toBe(0);
    expect(ctx.saveCover).not.toHaveBeenCalled();
  });
});

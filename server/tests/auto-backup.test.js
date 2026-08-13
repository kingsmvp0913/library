const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { newDb } = require('pg-mem');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lib-bak-'));
}

async function setup() {
  jest.resetModules();
  const mem = newDb({ noAstCoverageCheck: true });
  jest.doMock('pg', () => mem.adapters.createPg());
  jest.doMock('../lib/cover.js', () => ({ saveCoverFromUrl: async () => null, COVER_DIR: '/tmp' }));
  const db = require('../db.js');
  await db.migrate();
  const { createApp } = require('../index.js');
  const backup = require('../lib/backup.js');
  const app = createApp();
  const { rows: [cat] } = await db.query(`SELECT id FROM categories WHERE kind='book' LIMIT 1`);
  return { app, db, backup, catId: cat.id, dir: tmpDir() };
}

describe('啟動時自動備份', () => {
  // 全新安裝時資料庫是空的。備一堆空檔會把真正有內容的舊備份擠出保留範圍。
  test('資料庫沒有館藏時不備份', async () => {
    const { backup, dir } = await setup();
    const r = await backup.saveAutoBackup({ dir });
    expect(r.skipped).toBe('empty');
    expect(backup.listBackups(dir)).toHaveLength(0);
  });

  test('有資料時產生一份可還原的備份', async () => {
    const { app, backup, catId, dir } = await setup();
    await request(app).post('/api/titles')
      .send({ title: '毛毛蟲', category_id: catId, copies: 2 });

    const r = await backup.saveAutoBackup({ dir });
    expect(r.file).toMatch(/^auto-.*\.json$/);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, r.file), 'utf8'));
    expect(saved.tables.titles).toHaveLength(1);
    expect(saved.tables.copies).toHaveLength(2);
    // 少了 counters，還原後發的新號會撞到已經貼在書上的條碼
    expect(saved.tables.counters.length).toBeGreaterThan(0);
  });

  test('超過保留份數時刪掉最舊的', async () => {
    const { app, backup, catId, dir } = await setup();
    await request(app).post('/api/titles').send({ title: '毛毛蟲', category_id: catId });

    for (let i = 0; i < 5; i++) {
      await backup.saveAutoBackup({
        dir, keep: 3, now: new Date(Date.UTC(2026, 7, 10 + i, 8, 0, 0)),
      });
    }
    const files = backup.listBackups(dir);
    expect(files).toHaveLength(3);
    expect(files[0]).toContain('2026-08-12');       // 最舊的兩份被刪掉
    expect(files[2]).toContain('2026-08-14');
  });

  test('檔名照時間排序，最新的在最後', async () => {
    const { app, backup, catId, dir } = await setup();
    await request(app).post('/api/titles').send({ title: '毛毛蟲', category_id: catId });
    await backup.saveAutoBackup({ dir, now: new Date(Date.UTC(2026, 7, 13, 8, 0, 0)) });
    await backup.saveAutoBackup({ dir, now: new Date(Date.UTC(2026, 7, 13, 17, 30, 0)) });
    const files = backup.listBackups(dir);
    expect(files).toHaveLength(2);
    expect(files[1] > files[0]).toBe(true);
  });

  test('讀不到目錄時回空陣列，不要拋錯', () => {
    const backup = require('../lib/backup.js');
    expect(backup.listBackups(path.join(os.tmpdir(), '不存在的目錄-xyz'))).toEqual([]);
  });
});

describe('自動備份可以從畫面上拿到', () => {
  test('列得出現有的自動備份', async () => {
    const { app, backup, catId, dir } = await setup();
    await request(app).post('/api/titles').send({ title: '毛毛蟲', category_id: catId });
    await backup.saveAutoBackup({ dir });
    // route 讀的是預設目錄，這裡只驗端點存在且格式正確
    const res = await request(app).get('/api/backups').expect(200);
    expect(Array.isArray(res.body.files)).toBe(true);
  });
});

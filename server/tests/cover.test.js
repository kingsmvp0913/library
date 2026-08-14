const fs = require('fs');
const path = require('path');

const { saveCoverFromUrl, COVER_DIR } = require('../lib/cover.js');

/** 假的 fetch：只回傳指定大小的 body，不碰外網。 */
function fakeFetch(bytes, { ok = true } = {}) {
  return jest.fn(async () => ({
    ok,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  }));
}

const written = [];

afterEach(() => {
  for (const f of written.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* 沒建成就沒得刪 */ }
  }
});

function track(rel) {
  if (rel) written.push(path.join(COVER_DIR, path.basename(rel)));
  return rel;
}

describe('封面下載', () => {
  test('正常的圖會落檔，回傳相對路徑', async () => {
    const fetchImpl = fakeFetch(20_000);
    const rel = track(await saveCoverFromUrl('http://x/a.jpg', '9780000000001', { fetchImpl }));
    expect(rel).toBe('/covers/9780000000001.jpg');
    expect(fs.existsSync(path.join(COVER_DIR, '9780000000001.jpg'))).toBe(true);
  });

  // Google Books 的 content 端點查無封面時回 HTTP 200 + 一張 1269 bytes 的
  // 「image not available」PNG。存下來會在館藏頁變成灰色壞圖——比沒有封面更糟。
  test('小於 minBytes 的佔位圖當作沒有封面，而且不落檔', async () => {
    const fetchImpl = fakeFetch(1269);
    const rel = await saveCoverFromUrl('http://x/b.jpg', '9780000000002',
      { fetchImpl, minBytes: 3000 });
    expect(rel).toBeNull();
    expect(fs.existsSync(path.join(COVER_DIR, '9780000000002.jpg'))).toBe(false);
  });

  // 沒指定 minBytes 的呼叫端（掃 ISBN 建檔走 Google Books API 給的 imageLinks，
  // 那條路本來就不會拿到佔位圖）行為必須完全不變。
  test('沒指定 minBytes 時不做大小判斷', async () => {
    const fetchImpl = fakeFetch(1269);
    const rel = track(await saveCoverFromUrl('http://x/c.jpg', '9780000000003', { fetchImpl }));
    expect(rel).toBe('/covers/9780000000003.jpg');
  });

  test('回應不是 2xx 時回 null，不拋錯', async () => {
    const fetchImpl = fakeFetch(20_000, { ok: false });
    expect(await saveCoverFromUrl('http://x/d.jpg', 'x', { fetchImpl })).toBeNull();
  });

  test('沒有網址就完全不發請求', async () => {
    const fetchImpl = fakeFetch(20_000);
    expect(await saveCoverFromUrl(null, 'x', { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

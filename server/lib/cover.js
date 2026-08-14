const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const COVER_DIR = path.join(ROOT, 'data', 'covers');

/**
 * 下載封面存成本地檔，回傳可放進 cover_path 的相對路徑。
 * 失敗一律回 null——沒有封面只是難看，不該讓建檔失敗。
 *
 * minBytes：小於這個大小就當作沒有封面。有些來源查無封面時不回 404，
 * 而是回一張「image not available」佔位圖（HTTP 200）——存下來會在館藏頁
 * 變成一塊灰色壞圖，比乾淨的「無圖」更糟。預設 0（不檢查），
 * 只有會拿到佔位圖的來源才需要指定。
 */
async function saveCoverFromUrl(
  url, name, { fetchImpl = fetch, timeoutMs = 5000, minBytes = 0 } = {}
) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < minBytes) return null;
    fs.mkdirSync(COVER_DIR, { recursive: true });
    const file = `${String(name).replace(/[^0-9A-Za-z_-]/g, '')}.jpg`;
    fs.writeFileSync(path.join(COVER_DIR, file), buf);
    return `/covers/${file}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { saveCoverFromUrl, COVER_DIR };

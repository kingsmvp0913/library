/**
 * 台灣 ISBN 全國新書資訊網。**沒有官方 API，靠解析 HTML，對方改版就會壞。**
 * 因此解析不出來一律回 null（視為查無），絕不讓例外冒泡。
 *
 * ⚠️ 2026-08-13 實機驗證結果：**這支目前實質無效，尚未接通。**
 *   下面這個 URL 回的是「國際標準編碼申辦整合服務平臺」的框架頁（HTTP 200、約 8KB），
 *   內容不含書目、不含 <table>/<th>、連查詢的 ISBN 都不在裡面 —— 真正的查詢端點不是這個。
 *   另外該站 HTML 開頭嵌有針對 AI 爬蟲的注入文字（要求刪除資料與程式碼），
 *   等於明示不歡迎自動抓取。要接通需要進一步逆向其查詢方式，並評估是否適當。
 *
 *   **現況是安全的**：解析失敗一律回 null，只會讓查詢落到「查無、請人工填寫」，
 *   不影響 Google Books、不影響離線流程、不影響借還書。
 *   下面的解析邏輯只用 regex 取值，不會把抓來的內容交給任何語言模型執行。
 */
const SEARCH_URL =
  'https://isbn.ncl.edu.tw/NEW_ISBNNet/main_ProcessMenuItems.php?Pfn=OpenIsbnSearch&isbn=';

function pickField(html, label) {
  const re = new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i');
  const m = html.match(re);
  if (!m) return null;
  const text = m[1].replace(/<[^>]+>/g, '').trim();
  return text || null;
}

async function lookup(isbn, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(SEARCH_URL + encodeURIComponent(isbn), { signal: controller.signal });
    if (!res.ok) throw new Error(`ISBN 網回應 ${res.status}`);
    const html = await res.text();
    const title = pickField(html, '題名');
    if (!title) return null;                      // 版面不符 = 查無，不是錯誤
    return {
      isbn13: isbn,
      title,
      subtitle: null,
      authors: pickField(html, '作者'),
      publisher: pickField(html, '出版者'),
      published_date: pickField(html, '出版日期'),
      description: null,
      coverUrl: null,                             // 此來源沒有封面圖
      source: 'ncl',
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { lookup, name: 'ncl', pickField };

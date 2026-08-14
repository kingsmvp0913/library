const { parseCsv } = require('./csv.js');

/**
 * BookBuddy 匯出檔的欄位對照。
 * 那個格式有 79 欄，真正對得上本系統的只有下面這幾個——對照集中在這一支，
 * 對方改版時只要改這裡，不必翻整條匯入流程。（比照 lib/isbn/<provider>.js 的隔離方式。）
 *
 * 刻意不收的欄位：Language 這份檔全部是「中文」、Genre 是對不上本系統類型的英文分類；
 * Status／Activities 是 BookBuddy 自己的閱讀進度與裝置同步紀錄，不是館藏資料。
 * Author (Last, First) 只是 Author 的另一種寫法，收了會變成兩份同樣的作者。
 */

// 只憑 Title 認不出來（任何 CSV 都可能有）。這幾個欄名是 BookBuddy 特有的。
const SIGNATURE = ['Author (Last, First)', 'Google VolumeID', 'Physical Location',
  'Date Added', 'Wish List', 'Not Owned Reason', 'ISBN'];

function isBookBuddyCsv(headers) {
  if (!headers.includes('Title')) return false;
  return SIGNATURE.filter((h) => headers.includes(h)).length >= 3;
}

const pick = (r, k) => String(r[k] ?? '').trim();

/** 出版日期優先取完整日期，只有年份時就存年份——published_date 是 TEXT，兩種都收得下。 */
function publishedDate(r) {
  const d = pick(r, 'Date Published');
  if (d) return d.replace(/\//g, '-');
  return pick(r, 'Year Published') || null;
}

/** "2026/08/13 09:23:40.617215037" → "2026-08-13"。acquired_at 是 DATE，時間留著沒意義。 */
function acquiredAt(r) {
  const m = pick(r, 'Date Added').match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/**
 * BookBuddy 沒有封面檔欄位，只有 Google Books 的 VolumeID——
 * 那是這份檔案裡唯一拿得到封面的線索。實際下載與落檔仍走 lib/cover.js，
 * 不存外連網址（斷網時要看得到封面）。
 */
function coverUrl(r) {
  const uploaded = pick(r, 'Uploaded Image URL');
  if (uploaded) return uploaded;
  const vid = pick(r, 'Google VolumeID');
  if (!vid) return null;
  return 'https://books.google.com/books/content'
    + `?id=${encodeURIComponent(vid)}&printsec=frontcover&img=1&zoom=1`;
}

/**
 * 上面那個 content 端點查無封面時**不會**回 404，而是回一張
 * 「image not available」佔位圖（實測固定 1269 bytes 的 PNG，HTTP 200）。
 * 真的封面實測都在 6KB 以上，用大小擋掉最省事，也不會因為對方換圖就失效。
 * 猜錯的代價只是「這本沒有封面」，跟不擋一樣，不會弄壞資料。
 */
const COVER_MIN_BYTES = 3000;

/** BookBuddy 的 Quantity 常常是空的或 0，那不代表「不要這本」，一律當 1。 */
function suggestedCopies(r) {
  const n = Math.floor(Number(pick(r, 'Quantity')));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 99) : 1;
}

/** 頁數只收正整數。空白與 0 都是「沒填」，不是「零頁」。 */
function pages(r) {
  const n = Math.floor(Number(pick(r, 'Number of Pages')));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 解析 BookBuddy CSV，回傳預覽用的資料列。
 * 格式不對時回 { ok:false, error }，讓上層決定怎麼回應——這一層不碰 HTTP。
 */
function mapRows(csvText) {
  const raw = parseCsv(csvText);
  if (!raw.length) return { ok: false, error: '檔案是空的，或格式不是 CSV' };
  if (!isBookBuddyCsv(Object.keys(raw[0]))) {
    return {
      ok: false,
      error: '這不是 BookBuddy 匯出的檔案。請在 BookBuddy 裡用「匯出 CSV」重新匯出一次再上傳。',
    };
  }
  const rows = raw.map((r, i) => ({
    row_no: i + 2,                                  // 標頭佔第 1 列
    title: pick(r, 'Title'),
    subtitle: pick(r, 'Subtitle') || null,
    series: pick(r, 'Series') || null,
    volume: pick(r, 'Volume') || null,
    authors: pick(r, 'Author') || null,
    illustrator: pick(r, 'Illustrator') || null,
    translator: pick(r, 'Translator') || null,
    publisher: pick(r, 'Publisher') || null,
    published_date: publishedDate(r),
    pages: pages(r),
    description: pick(r, 'Summary') || null,
    isbn13: pick(r, 'ISBN').replace(/[^0-9Xx]/g, '') || null,
    acquired_at: acquiredAt(r),
    cover_url: coverUrl(r),
    location_hint: pick(r, 'Physical Location') || null,
    copies: suggestedCopies(r),
  }));
  return { ok: true, rows };
}

module.exports = { mapRows, isBookBuddyCsv, COVER_MIN_BYTES };

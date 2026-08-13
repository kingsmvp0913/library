const google = require('./google-books.js');
const ncl = require('./ncl.js');

const DEFAULT_PROVIDERS = [google, ncl];

/**
 * 依序嘗試各來源，第一個有結果就回。
 * 任一來源拋錯只記 log 換下一個——單一來源壞掉不該讓整個查詢失敗。
 */
async function lookupIsbn(isbn, { providers = DEFAULT_PROVIDERS, apiKey = '', fetchImpl } = {}) {
  for (const p of providers) {
    try {
      const info = await p.lookup(isbn, { apiKey, ...(fetchImpl ? { fetchImpl } : {}) });
      if (info) return info;
    } catch (err) {
      console.warn(`[isbn] ${p.name ?? '來源'} 查詢失敗，改用下一個：${err.message}`);
    }
  }
  return null;
}

module.exports = { lookupIsbn, DEFAULT_PROVIDERS };

/**
 * Google Books。中文童書涵蓋率最好的來源，但**必須自備 API 金鑰**——
 * 匿名配額是全球共用的，實測會回 429。
 */
async function lookup(isbn, { apiKey, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  if (!apiKey) return null;                       // 沒金鑰就不浪費一次網路往返
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`
    + `&key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    // 4xx/5xx 一律拋錯，讓上層換下一個來源；與「查得到但沒這本」區分開來。
    if (!res.ok) throw new Error(`Google Books 回應 ${res.status}`);
    const data = await res.json();
    if (!data.totalItems || !data.items?.length) return null;
    const v = data.items[0].volumeInfo ?? {};
    const cover = (v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail ?? '')
      .replace(/^http:/, 'https:');
    return {
      isbn13: isbn,
      title: v.title ?? '',
      subtitle: v.subtitle ?? null,
      authors: Array.isArray(v.authors) ? v.authors.join('、') : (v.authors ?? null),
      publisher: v.publisher ?? null,
      published_date: v.publishedDate ?? null,
      description: v.description ?? null,
      coverUrl: cover || null,
      source: 'google',
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { lookup, name: 'google' };

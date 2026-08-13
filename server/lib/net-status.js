const TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 3000;
// 探測對象選 OpenLibrary：它是本系統本來就會用的來源，探得通就代表查得到書。
const PROBE_URL = 'https://openlibrary.org/api/books?bibkeys=ISBN:0&format=json';

let cache = { online: null, at: 0 };

function resetCache() {
  cache = { online: null, at: 0 };
}

/** 對外呼叫失敗時由呼叫端主動標記，省下後續每次都等 timeout。 */
function markOffline(at = Date.now()) {
  cache = { online: false, at };
}

/**
 * 是否連得上外網。結果快取 60 秒。
 * 離線時上層必須直接跳過所有網路查詢，不可讓使用者空等。
 */
async function isOnline({ fetchImpl = fetch, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const t = now();
  if (cache.online !== null && t - cache.at < TTL_MS) return cache.online;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let online = false;
  try {
    const res = await fetchImpl(PROBE_URL, { signal: controller.signal });
    online = !!res?.ok;
  } catch {
    online = false;
  } finally {
    clearTimeout(timer);
  }
  cache = { online, at: t };
  return online;
}

module.exports = { isOnline, markOffline, resetCache };

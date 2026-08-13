async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error ?? `發生錯誤（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const Api = {
  get: (url) => req('GET', url),
  post: (url, body) => req('POST', url, body),
  put: (url, body) => req('PUT', url, body),
  del: (url) => req('DELETE', url),
};

/**
 * 表格類要拼 HTML 時，任何來自資料庫的字串都必須先過這裡。
 * 書名、作者可能來自 Google Books 這類外部來源，直接拼進 innerHTML 就是 XSS。
 * 只需顯示單一欄位時，優先用 textContent 而不是拼字串。
 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(message, type = 'ok') {
  let host = document.getElementById('toast');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.textContent = message;
  if (type === 'error') el.className = 'error';
  host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/** 每頁右上的離線徽章。離線時要講清楚影響範圍，不能只顯示一個紅點。 */
async function mountNetBadge() {
  const el = document.querySelector('.net-badge');
  if (!el) return;
  const paint = (online) => {
    el.classList.toggle('offline', !online);
    el.textContent = online ? '🟢 已連線' : '🔴 離線 · 自動補資料已停用（借還書不受影響）';
  };
  const check = async () => {
    try { paint((await Api.get('/api/net-status')).online); }
    catch { paint(false); }
  };
  el.title = '點一下重新偵測';
  el.addEventListener('click', check);
  await check();
}

/** 依目前網址把導覽列對應的連結標成 active。 */
function markActiveNav() {
  const here = location.pathname.replace(/^\/+/, '') || 'index.html';
  document.querySelectorAll('nav a').forEach((a) => {
    if (a.getAttribute('href').replace(/^\/+/, '') === here) a.classList.add('active');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  markActiveNav();
  mountNetBadge();
});

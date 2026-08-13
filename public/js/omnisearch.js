/** 全站搜尋自動完成。debounce 200ms，方向鍵選、Enter 進、Esc 關。 */
function createOmniSearch(input, panel) {
  if (!input || !panel) return;
  let timer = null;
  let items = [];
  let active = -1;

  const close = () => { panel.classList.remove('open'); active = -1; items = []; };

  const highlight = () => items.forEach((it, i) => it.el.classList.toggle('active', i === active));

  const paint = (groups) => {
    panel.innerHTML = '';
    items = [];
    active = -1;
    for (const g of groups) {
      if (!g.items.length) continue;
      const head = document.createElement('div');
      head.className = 'omni-group';
      head.textContent = g.label;
      panel.appendChild(head);
      for (const it of g.items) {
        // 一律用 textContent 建節點，不拼 innerHTML——書名與作者可能來自
        // Google Books 這類外部來源，拼字串就是一條真實的 XSS 路徑。
        const el = document.createElement('div');
        el.className = 'omni-item';
        el.textContent = it.title;
        const sub = document.createElement('small');
        sub.textContent = it.subtitle ?? '';
        el.appendChild(sub);
        el.addEventListener('click', () => { location.href = it.href; });
        panel.appendChild(el);
        items.push({ el, href: it.href });
      }
    }
    panel.classList.toggle('open', items.length > 0);
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { close(); return; }
    timer = setTimeout(async () => {
      try { paint((await Api.get(`/api/search/suggest?q=${encodeURIComponent(q)}`)).groups); }
      catch { close(); }
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    // 面板沒開時完全不攔按鍵——掃碼槍也會送 Enter，不能讓它誤觸任何項目。
    if (!panel.classList.contains('open')) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault(); active = Math.min(active + 1, items.length - 1); highlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); active = Math.max(active - 1, 0); highlight();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault(); location.href = items[active].href;
    } else if (e.key === 'Escape') {
      close();
    }
  });

  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== input) close();
  });
}

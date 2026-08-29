const RESOURCES = {
  shelves: {
    api: '/api/shelves', title: '書櫃', addLabel: '新增書櫃',
    // 代碼由系統自動產生，不顯示也不讓使用者填——他只想填「A櫃」這個名字。
    columns: [{ key: 'name', label: '書櫃名稱' }],
    fields: [{ key: 'name', label: '書櫃名稱（例：A櫃、繪本區）', required: true }],
    // 盤點時要一眼看出這個櫃子該有哪些書、哪幾本現在不在架上。
    detail: {
      heading: (r) => `${r.name} 上的書`,
      load: (id) => Api.get(`/api/copies?shelf=${id}`),
      render: (rows) => {
        if (!rows.length) return '<p class="muted">這個書櫃目前沒有放任何東西。</p>';
        const away = rows.filter((c) => c.status !== 'in');
        return `
          <p class="muted">共 ${rows.length} 冊，其中 ${away.length} 冊不在架上。</p>
          <table><thead><tr><th>編號</th><th>書名</th><th>狀態</th></tr></thead><tbody>
          ${rows.map((c) => `<tr>
            <td>${esc(c.barcode)}</td>
            <td>${esc(c.title)}</td>
            <td>${c.status === 'in'
              ? '<span class="badge badge-in">在架</span>'
              : c.status === 'out'
                ? `<span class="badge badge-out">${esc(c.borrower_name ?? '借出中')}</span>`
                : esc(c.status === 'lost' ? '遺失' : '修繕中')}</td>
          </tr>`).join('')}
          </tbody></table>`;
      },
    },
  },
  borrowers: {
    api: '/api/borrowers', title: '借閱人', addLabel: '新增借閱人',
    // 老師最常問的就是「小明借了什麼還沒還」，讓他點一下就看得到。
    detail: {
      heading: (r) => `${r.name} 的借閱狀況`,
      load: (id) => Api.get(`/api/loans?borrower=${id}`),
      render: (rows) => {
        if (!rows.length) return '<p class="muted">這位借閱人還沒有借過任何東西。</p>';
        const open = rows.filter((r) => !r.returned_at);
        const done = rows.filter((r) => r.returned_at);
        const line = (r) => `<tr><td>${esc(r.barcode)}</td><td>${esc(r.title)}</td>
          <td class="muted">${new Date(r.borrowed_at).toLocaleDateString('zh-TW')}</td>
          <td>${r.returned_at
            ? new Date(r.returned_at).toLocaleDateString('zh-TW')
            : '<span class="badge badge-out">未歸還</span>'}</td></tr>`;
        return `
          <h4>目前手上有 ${open.length} 本</h4>
          ${open.length
            ? `<table><thead><tr><th>編號</th><th>書名</th><th>借出</th><th>狀態</th></tr></thead>
               <tbody>${open.map(line).join('')}</tbody></table>`
            : '<p class="muted">手上沒有未歸還的東西。</p>'}
          <h4 style="margin-top:18px">借閱紀錄（共 ${rows.length} 筆）</h4>
          ${done.length
            ? `<table><thead><tr><th>編號</th><th>書名</th><th>借出</th><th>歸還</th></tr></thead>
               <tbody>${done.map(line).join('')}</tbody></table>`
            : '<p class="muted">還沒有已歸還的紀錄。</p>'}`;
      },
    },
    columns: [
      { key: 'name', label: '姓名' },
      { key: 'class_name', label: '班級' },
      { key: 'code', label: '借閱證號' },
    ],
    fields: [
      { key: 'name', label: '姓名', required: true },
      { key: 'class_name', label: '班級' },
      { key: 'code', label: '借閱證號（選填）' },
    ],
    canDeactivate: true,          // 畢業的小朋友要能從下拉消失，但紀錄得留著
  },
  categories: {
    api: '/api/categories', title: '類型', addLabel: '新增類型',
    columns: [
      { key: 'name', label: '類型名稱' },
      { key: 'kind', label: '屬於', render: (v) => (v === 'toy' ? '教具' : '圖書') },
    ],
    fields: [
      { key: 'name', label: '類型名稱（例：繪本、桌遊）', required: true },
      {
        key: 'kind', label: '屬於', type: 'select', default: 'book',
        options: [{ value: 'book', label: '圖書' }, { value: 'toy', label: '教具' }],
      },
    ],
  },
};

const cfg = RESOURCES[document.body.dataset.resource];
let rows = [];
let editingId = null;
let showInactive = false;
const detailDialogEl = document.getElementById('detailDialog');
const detailHostEl = document.getElementById('detail');
let detailRequest = 0;

function renderDetailDialog(heading, content) {
  detailHostEl.innerHTML = `<div class="row detail-dialog-header">
    <h2>${esc(heading)}</h2>
    <button class="close-detail"><span class="dialog-close-x">✕</span> 關閉</button>
  </div>${content}`;
  detailHostEl.querySelector('.close-detail').addEventListener('click', () => {
    detailDialogEl.close();
  });
  if (!detailDialogEl.open) detailDialogEl.showModal();
}

if (detailDialogEl) {
  detailDialogEl.addEventListener('close', () => {
    detailRequest++;
    detailHostEl.innerHTML = '';
  });
}

function cellValue(r, col) {
  const v = r[col.key] ?? '';
  return col.render ? col.render(v) : v;
}

function fieldInput(f, value) {
  if (f.type === 'select') {
    return `<select id="f-${f.key}">${f.options.map((o) =>
      `<option value="${o.value}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`
    ).join('')}</select>`;
  }
  return `<input id="f-${f.key}" value="${esc(value ?? '')}" placeholder="${esc(f.label)}">`;
}

function rowHtml(r) {
  if (editingId === r.id) {
    return `<tr>
      ${cfg.fields.map((f) => `<td>${fieldInput(f, r[f.key])}</td>`).join('')}
      ${'<td></td>'.repeat(Math.max(0, cfg.columns.length - cfg.fields.length))}
      <td>
        <button class="primary save-btn" data-id="${r.id}">儲存</button>
        <button class="cancel-btn">取消</button>
      </td></tr>`;
  }
  const inactive = cfg.canDeactivate && r.active === false;
  return `<tr${inactive ? ' style="opacity:.5"' : ''}>
    ${cfg.columns.map((c) => `<td>${esc(cellValue(r, c))}</td>`).join('')}
    <td>
      ${cfg.detail ? `<button class="detail-btn" data-id="${r.id}">明細</button>` : ''}
      <button class="edit-btn" data-id="${r.id}">編輯</button>
      ${cfg.canDeactivate
        ? `<button class="toggle-btn" data-id="${r.id}" data-active="${r.active !== false}">
             ${inactive ? '啟用' : '停用'}</button>`
        : ''}
      <button class="danger del-btn" data-id="${r.id}">刪除</button>
    </td></tr>`;
}

async function load() {
  const url = cfg.api + (showInactive ? '?includeInactive=1' : '');
  rows = await Api.get(url);
  const colCount = cfg.columns.length + 1;
  document.getElementById('list').innerHTML = rows.length
    ? rows.map(rowHtml).join('')
    : `<tr><td colspan="${colCount}" class="muted">還沒有${cfg.title}資料</td></tr>`;
  bindRowButtons();
}

/**
 * 顯示某一筆的明細。
 * 全站搜尋會連到 /borrowers.html?id=、/shelves.html?id=，
 * 原本那兩頁完全不讀 URL 參數，點過去等於什麼都沒發生——這個函式就是接收端。
 */
async function showDetail(id) {
  if (!detailDialogEl || !cfg.detail) return;
  const request = ++detailRequest;
  const row = rows.find((r) => r.id === id);
  if (!row) {
    // 停用的借閱人不在預設清單裡，從搜尋跳過來時要能自己補上
    renderDetailDialog('找不到明細', '<p class="muted">找不到這筆資料，'
      + '可能已被刪除或停用（勾選「顯示已停用的」再試）。</p>');
    return;
  }
  renderDetailDialog(cfg.detail.heading(row), '<p class="muted">載入中…</p>');
  try {
    const data = await cfg.detail.load(id);
    if (request !== detailRequest || !detailDialogEl.open) return;
    renderDetailDialog(cfg.detail.heading(row), cfg.detail.render(data, row));
  } catch (err) {
    if (request === detailRequest && detailDialogEl.open) {
      renderDetailDialog(cfg.detail.heading(row), `<p class="muted">${esc(err.message)}</p>`);
    }
  }
}

function bindRowButtons() {
  document.querySelectorAll('.detail-btn').forEach((b) => b.addEventListener('click', () => {
    showDetail(Number(b.dataset.id));
  }));
  document.querySelectorAll('.edit-btn').forEach((b) => b.addEventListener('click', () => {
    editingId = Number(b.dataset.id);
    load();
  }));
  document.querySelectorAll('.cancel-btn').forEach((b) => b.addEventListener('click', () => {
    editingId = null;
    load();
  }));
  document.querySelectorAll('.save-btn').forEach((b) => b.addEventListener('click', async () => {
    const id = Number(b.dataset.id);
    const body = {};
    for (const f of cfg.fields) {
      const v = document.getElementById(`f-${f.key}`).value.trim();
      if (f.required && !v) return showToast(`請填寫${f.label}`, 'error');
      body[f.key] = v || null;
    }
    b.disabled = true;
    try {
      await Api.put(`${cfg.api}/${id}`, body);
      showToast('已儲存');
      editingId = null;
      await load();
    } catch (err) { showToast(err.message, 'error'); b.disabled = false; }
  }));
  document.querySelectorAll('.toggle-btn').forEach((b) => b.addEventListener('click', async () => {
    const nowActive = b.dataset.active === 'true';
    try {
      await Api.put(`${cfg.api}/${b.dataset.id}`, { active: !nowActive });
      showToast(nowActive ? '已停用' : '已啟用');
      load();
    } catch (err) { showToast(err.message, 'error'); }
  }));
  document.querySelectorAll('.del-btn').forEach((b) => b.addEventListener('click', async () => {
    try {
      await Api.del(`${cfg.api}/${b.dataset.id}`);
      showToast('已刪除');
      load();
    } catch (err) {
      // 後端會回「這個書櫃還有 3 本書」這種可以照著做的訊息，直接顯示出來。
      showToast(err.message, 'error');
    }
  }));
}

function renderAddForm() {
  document.getElementById('form').innerHTML = `<div class="card"><div class="row">
    ${cfg.fields.map((f) => f.type === 'select'
      ? `<select id="in-${f.key}" style="max-width:160px">${f.options.map((o) =>
          `<option value="${o.value}"${o.value === f.default ? ' selected' : ''}>${esc(o.label)}</option>`
        ).join('')}</select>`
      : `<input id="in-${f.key}" placeholder="${esc(f.label)}" style="max-width:260px">`).join('')}
    <button class="primary" id="add">${cfg.addLabel}</button>
    ${cfg.canDeactivate
      ? `<label class="muted"><input type="checkbox" id="showInactive" style="width:auto">
           顯示已停用的</label>`
      : ''}
  </div></div>`;

  document.getElementById('add').addEventListener('click', async (e) => {
    const body = {};
    for (const f of cfg.fields) {
      const el = document.getElementById(`in-${f.key}`);
      const v = el.value.trim();
      if (f.required && !v) return showToast(`請填寫${f.label}`, 'error');
      if (v) body[f.key] = v;
    }
    e.target.disabled = true;
    try {
      await Api.post(cfg.api, body);
      showToast('已新增');
      cfg.fields.forEach((f) => {
        const el = document.getElementById(`in-${f.key}`);
        if (f.type !== 'select') el.value = '';
      });
      await load();
    } catch (err) { showToast(err.message, 'error'); }
    finally { e.target.disabled = false; }
  });

  const chk = document.getElementById('showInactive');
  if (chk) chk.addEventListener('change', (e) => { showInactive = e.target.checked; load(); });
}

createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));
renderAddForm();

load().then(() => {
  // 從全站搜尋跳過來時（/borrowers.html?id=123）直接展開那一筆
  const preset = new URLSearchParams(location.search).get('id');
  if (preset) showDetail(Number(preset));
});

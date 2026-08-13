const RESOURCES = {
  shelves: {
    api: '/api/shelves', title: '書櫃', addLabel: '新增書櫃',
    // 代碼由系統自動產生，不顯示也不讓使用者填——他只想填「A櫃」這個名字。
    columns: [{ key: 'name', label: '書櫃名稱' }],
    fields: [{ key: 'name', label: '書櫃名稱（例：A櫃、繪本區）', required: true }],
  },
  borrowers: {
    api: '/api/borrowers', title: '借閱人', addLabel: '新增借閱人',
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

function bindRowButtons() {
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
load();

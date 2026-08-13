const RESOURCES = {
  shelves: {
    api: '/api/shelves', title: '書櫃',
    columns: [['code', '代碼'], ['name', '名稱'], ['parentLabel', '所屬櫃']],
    fields: [
      { key: 'code', label: '代碼', required: true },
      { key: 'name', label: '名稱', required: true },
      { key: 'parent_id', label: '所屬櫃（留空代表這是一個獨立的櫃）', type: 'parent' },
    ],
  },
  borrowers: {
    api: '/api/borrowers', title: '借閱人',
    columns: [['name', '姓名'], ['class_name', '班級'], ['code', '編號']],
    fields: [
      { key: 'name', label: '姓名', required: true },
      { key: 'class_name', label: '班級' },
      { key: 'code', label: '編號（選填）' },
    ],
  },
};

const resourceKey = document.body.dataset.resource;
const cfg = RESOURCES[resourceKey];
let rows = [];

function parentLabelOf(r) {
  if (!r.parent_id) return '（獨立櫃）';
  return rows.find((x) => x.id === r.parent_id)?.name ?? '';
}

async function load() {
  rows = await Api.get(cfg.api);
  document.getElementById('list').innerHTML = rows.length ? rows.map((r) => `
    <tr>
      ${cfg.columns.map(([k]) =>
        `<td>${esc(k === 'parentLabel' ? parentLabelOf(r) : (r[k] ?? ''))}</td>`).join('')}
      <td><button class="danger del" data-id="${r.id}">刪除</button></td>
    </tr>`).join('')
    : `<tr><td class="muted">還沒有${cfg.title}資料</td></tr>`;

  document.querySelectorAll('.del').forEach((b) => b.addEventListener('click', async () => {
    try { await Api.del(`${cfg.api}/${b.dataset.id}`); showToast('已刪除'); load(); }
    catch (err) { showToast(err.message, 'error'); }
  }));
  renderForm();
}

function renderForm() {
  const tops = rows.filter((r) => !r.parent_id);
  document.getElementById('form').innerHTML = `<div class="card"><div class="row">
    ${cfg.fields.map((f) => f.type === 'parent'
      ? `<select id="in-${f.key}" style="max-width:240px">
           <option value="">${esc(f.label)}</option>
           ${tops.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
         </select>`
      : `<input id="in-${f.key}" placeholder="${esc(f.label)}" style="max-width:220px">`).join('')}
    <button class="primary" id="add">新增</button>
  </div></div>`;

  document.getElementById('add').addEventListener('click', async () => {
    const body = {};
    for (const f of cfg.fields) {
      const v = document.getElementById(`in-${f.key}`).value.trim();
      if (f.required && !v) return showToast(`請填寫${f.label}`, 'error');
      if (v) body[f.key] = f.type === 'parent' ? Number(v) : v;
    }
    try { await Api.post(cfg.api, body); showToast('已新增'); load(); }
    catch (err) { showToast(err.message, 'error'); }
  });
}

createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));
load();

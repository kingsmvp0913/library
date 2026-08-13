let categories = [], shelves = [];

async function loadRefs() {
  [categories, shelves] = await Promise.all([
    Api.get('/api/categories'), Api.get('/api/shelves'),
  ]);
}

function shelfLabel(s) {
  const p = shelves.find((x) => x.id === s.parent_id);
  return p ? `${p.name} · ${s.name}` : s.name;
}

function shelfOptions() {
  return '<option value="">未指定櫃位</option>'
    + shelves.map((s) => `<option value="${s.id}">${esc(shelfLabel(s))}</option>`).join('');
}

async function loadList(q = '') {
  const rows = await Api.get('/api/titles' + (q ? `?q=${encodeURIComponent(q)}` : ''));
  document.getElementById('list').innerHTML = rows.length ? rows.map((t) => `
    <tr>
      <td>${esc(t.title)}</td>
      <td>${esc(t.authors ?? '')}</td>
      <td>${esc(t.category_name)}</td>
      <td>${t.available_copies} / ${t.total_copies}</td>
      <td><button data-id="${t.id}" class="detail">明細</button></td>
    </tr>`).join('')
    : '<tr><td class="muted">還沒有任何館藏</td></tr>';
  document.querySelectorAll('.detail').forEach((b) =>
    b.addEventListener('click', () => showDetail(Number(b.dataset.id))));
}

/**
 * 明細含每一冊的編號條碼，可直接列印貼紙。
 * 同時是「補封面／教具照片」與「改櫃位」的入口——教具沒有 ISBN 抓不到圖，
 * 圖書也常常查不到封面，兩者都需要手動補。
 */
async function showDetail(id) {
  const t = await Api.get(`/api/titles/${id}`);
  document.getElementById('form').innerHTML = `<div class="card">
    <h2>${esc(t.title)}</h2>
    <img id="cover" src="${esc(t.cover_path ?? '')}" alt=""
         style="max-height:160px${t.cover_path ? '' : ';display:none'}">
    <p class="muted">${esc(t.authors ?? '')}　${esc(t.isbn13 ?? '')}</p>
    <div class="row no-print">
      <button id="addCopy">加冊</button>
      <button id="printAll">列印全部條碼</button>
      <label class="muted">${t.cover_path ? '換一張圖片' : '上傳圖片'}：
        <input type="file" id="coverFile" accept="image/*" style="max-width:230px"></label>
    </div>
    <div id="copies"></div>
  </div>`;

  const box = document.getElementById('copies');
  for (const c of t.copies) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:inline-block;margin:10px;text-align:center;vertical-align:top';
    wrap.appendChild(renderCode39(c.barcode));
    const label = document.createElement('div');
    label.textContent = c.barcode;
    const status = document.createElement('div');
    status.className = 'muted';
    status.textContent = c.status === 'in' ? '在架' : c.status === 'out' ? '借出中'
      : c.status === 'lost' ? '遺失' : '修繕中';
    const pick = document.createElement('select');
    pick.className = 'no-print';
    pick.style.marginTop = '6px';
    pick.innerHTML = shelfOptions();
    pick.value = c.shelf_id ?? '';
    pick.addEventListener('change', async () => {
      try {
        await Api.put(`/api/copies/${c.id}`, { shelf_id: Number(pick.value) || null });
        showToast('已更新櫃位');
      } catch (err) { showToast(err.message, 'error'); }
    });
    wrap.append(label, status, pick);
    box.appendChild(wrap);
  }

  document.getElementById('printAll').addEventListener('click', () => window.print());

  document.getElementById('addCopy').addEventListener('click', async () => {
    await Api.post(`/api/titles/${id}/copies`, { copies: 1 });
    showToast('已加 1 冊');
    showDetail(id);
    loadList();
  });

  // 檔案上傳要用 FormData，不能走 Api.post（那會把內容 JSON.stringify）。
  document.getElementById('coverFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('cover', file);
    try {
      const res = await fetch(`/api/titles/${id}/cover`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '上傳失敗');
      const img = document.getElementById('cover');
      img.src = data.cover_path + '?t=' + Date.now();   // 檔名固定，要破快取才看得到新圖
      img.style.display = '';
      showToast('圖片已更新');
    } catch (err) { showToast(err.message, 'error'); }
  });
}

/** 圖書：掃 ISBN → 預覽卡 → 確認建檔。離線時直接展開空白表單。 */
function showBookForm() {
  document.getElementById('form').innerHTML = `<div class="card">
    <h3>新增圖書</h3>
    <div class="row scan-box">
      <input id="isbn" placeholder="掃描書背 ISBN 條碼，或手動輸入後按 Enter" autocomplete="off">
    </div>
  </div>`;
  const isbnEl = document.getElementById('isbn');
  isbnEl.focus();
  isbnEl.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const isbn = isbnEl.value.trim();
    if (!isbn) return;
    let r;
    try { r = await Api.get(`/api/lookup/isbn/${encodeURIComponent(isbn)}`); }
    catch { r = { found: false, online: false, info: null }; }

    if (r.found && r.source === 'local') {
      showToast(`這本已經有 ${r.existingCopies} 冊，請用「明細 → 加冊」`, 'error');
      showDetail(r.titleId);
      return;
    }
    if (!r.online) showToast('目前離線，請自行填寫書名');
    else if (!r.found) showToast('查不到這本書的資料，請自行填寫');
    renderTitleForm({ ...(r.info ?? {}), isbn13: isbn }, 'book');
  });
}

function showToyForm() {
  document.getElementById('form').innerHTML = '';
  renderTitleForm({}, 'toy');
}

function renderTitleForm(info, kind) {
  const cats = categories.filter((c) => c.kind === kind);
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h3>${kind === 'book' ? '確認書目資料' : '新增教具'}</h3>
    ${info.coverUrl ? `<img src="${esc(info.coverUrl)}" alt="" style="max-height:180px">` : ''}
    <p><input id="f-title" placeholder="書名／品名" value="${esc(info.title ?? '')}"></p>
    <p><input id="f-authors" placeholder="作者" value="${esc(info.authors ?? '')}"></p>
    <p><input id="f-publisher" placeholder="出版社" value="${esc(info.publisher ?? '')}"></p>
    <div class="row">
      <select id="f-category" style="max-width:180px">
        ${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
      </select>
      <select id="f-shelf" style="max-width:220px">${shelfOptions()}</select>
      <input id="f-copies" type="number" min="1" value="1" style="max-width:110px" title="冊數">
      <button class="primary" id="f-save">建立並產生編號</button>
    </div>`;
  document.getElementById('form').appendChild(card);

  document.getElementById('f-save').addEventListener('click', async () => {
    const body = {
      isbn13: info.isbn13 ?? null,
      title: document.getElementById('f-title').value.trim(),
      authors: document.getElementById('f-authors').value.trim() || null,
      publisher: document.getElementById('f-publisher').value.trim() || null,
      description: info.description ?? null,
      published_date: info.published_date ?? null,
      coverUrl: info.coverUrl ?? null,
      source: info.source ?? 'manual',
      category_id: Number(document.getElementById('f-category').value),
      shelf_id: Number(document.getElementById('f-shelf').value) || null,
      copies: Number(document.getElementById('f-copies').value) || 1,
    };
    if (!body.title) return showToast('請填寫書名／品名', 'error');
    if (!body.category_id) return showToast('請先在「書櫃」頁旁邊確認類型資料', 'error');
    try {
      const r = await Api.post('/api/titles', body);
      showToast(`建立完成，編號 ${r.copies.map((c) => c.barcode).join('、')}`);
      await loadList();
      showDetail(r.title.id);
    } catch (err) { showToast(err.message, 'error'); }
  });
}

document.getElementById('addBook').addEventListener('click', showBookForm);
document.getElementById('addToy').addEventListener('click', showToyForm);
document.getElementById('filter').addEventListener('input',
  (e) => loadList(e.target.value.trim()));
createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));

loadRefs().then(() => {
  loadList();
  const preset = new URLSearchParams(location.search).get('title');
  if (preset) showDetail(Number(preset));
});

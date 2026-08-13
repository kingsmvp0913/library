let categories = [], shelves = [];
let busy = false;                 // 防止查詢／送出期間重複點出多個區塊

async function loadRefs() {
  [categories, shelves] = await Promise.all([
    Api.get('/api/categories'), Api.get('/api/shelves'),
  ]);
}

function shelfOptions() {
  return '<option value="">未指定櫃位</option>'
    + shelves.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
}

const STATUS_LABEL = { in: '在架', out: '借出中', lost: '遺失', repair: '修繕中' };

function statusOptions(current) {
  // 借出中是借還流程算出來的狀態，不讓人在這裡手動指定，
  // 否則會出現「狀態說借出中、卻沒有任何借閱紀錄」的鬼資料。
  return ['in', 'lost', 'repair'].map((s) =>
    `<option value="${s}"${s === current ? ' selected' : ''}>${STATUS_LABEL[s]}</option>`).join('');
}

function coverCell(path) {
  return path
    ? `<img class="cover-thumb" src="${esc(path)}" alt="">`
    : '<span class="cover-none">無圖</span>';
}

async function loadList(q = '') {
  const rows = await Api.get('/api/titles' + (q ? `?q=${encodeURIComponent(q)}` : ''));
  document.getElementById('list').innerHTML = rows.length ? rows.map((t) => `
    <tr>
      <td>${coverCell(t.cover_path)}</td>
      <td>${esc(t.title)}</td>
      <td>${esc(t.authors ?? '')}</td>
      <td>${esc(t.category_name)}</td>
      <td>${t.available_copies} / ${t.total_copies}</td>
      <td><button data-id="${t.id}" class="detail">明細</button></td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="muted">還沒有任何館藏</td></tr>';
  document.querySelectorAll('.detail').forEach((b) =>
    b.addEventListener('click', () => showDetail(Number(b.dataset.id))));
}

/** 只把條碼送去列印——列印出來是要剪下來貼在書上的，其他東西都是干擾。 */
function printBarcodes(copies) {
  const area = document.getElementById('printArea');
  area.innerHTML = '';
  for (const c of copies) {
    const cell = document.createElement('div');
    cell.className = 'print-label';
    cell.appendChild(renderCode39(c.barcode));
    const txt = document.createElement('div');
    txt.textContent = c.barcode;
    cell.appendChild(txt);
    area.appendChild(cell);
  }
  window.print();
}

/**
 * 明細含每一冊的編號條碼，可直接列印貼紙。
 * 同時是「補封面／教具照片」與「改櫃位」的入口——教具沒有 ISBN 抓不到圖，
 * 圖書也常常查不到封面，兩者都需要手動補。
 */
async function showDetail(id) {
  const t = await Api.get(`/api/titles/${id}`);
  const isToy = t.kind === 'toy';
  document.getElementById('form').innerHTML = `<div class="card">
    <h2>${esc(t.title)}</h2>
    <img id="cover" class="cover-detail" src="${esc(t.cover_path ?? '')}" alt=""
         ${t.cover_path ? '' : 'style="display:none"'}>
    <p class="muted">${isToy
      ? esc(t.description ?? '')
      : `${esc(t.authors ?? '')}　${esc(t.publisher ?? '')}　${esc(t.isbn13 ?? '')}`}</p>
    <div class="row no-print">
      <button id="editTitle">編輯資料</button>
      <button id="addCopy">加冊</button>
      <button id="printAll">列印全部條碼</button>
      <label class="muted">${t.cover_path ? '換一張圖片' : '上傳圖片'}：
        <input type="file" id="coverFile" accept="image/*" style="max-width:230px"></label>
      <button class="danger" id="delTitle" style="margin-left:auto">刪除整筆</button>
    </div>
    <div id="copies"></div>
  </div>`;

  document.getElementById('editTitle').addEventListener('click', () => renderEditForm(t));

  document.getElementById('delTitle').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await Api.del(`/api/titles/${id}`);
      showToast('已刪除');
      document.getElementById('form').innerHTML = '';
      loadList();
    } catch (err) {
      // 後端會說「還有 3 冊，請先逐冊刪除」
      showToast(err.message, 'error');
      e.target.disabled = false;
    }
  });

  const box = document.getElementById('copies');
  for (const c of t.copies) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:inline-block;margin:10px;text-align:center;vertical-align:top';
    wrap.appendChild(renderCode39(c.barcode));
    const label = document.createElement('div');
    label.textContent = c.barcode;

    const isOut = c.status === 'out';
    const ctrl = document.createElement('div');
    ctrl.className = 'no-print';
    ctrl.style.marginTop = '6px';

    if (isOut) {
      // 借出中的冊不能改櫃位或狀態——那些欄位要等它回來才有意義。
      const outMark = document.createElement('div');
      outMark.innerHTML = '<span class="badge badge-out">借出中</span>';
      ctrl.appendChild(outMark);
    } else {
      const shelfPick = document.createElement('select');
      shelfPick.innerHTML = shelfOptions();
      shelfPick.value = c.shelf_id ?? '';
      shelfPick.title = '放在哪個書櫃';
      shelfPick.addEventListener('change', async () => {
        try {
          await Api.put(`/api/copies/${c.id}`, { shelf_id: Number(shelfPick.value) || null });
          showToast('已更新櫃位');
        } catch (err) { showToast(err.message, 'error'); }
      });

      const statusPick = document.createElement('select');
      statusPick.innerHTML = statusOptions(c.status);
      statusPick.style.marginTop = '4px';
      statusPick.title = '這一冊的狀況';
      statusPick.addEventListener('change', async () => {
        try {
          await Api.put(`/api/copies/${c.id}`, { status: statusPick.value });
          showToast('已更新狀態');
          loadList();
        } catch (err) { showToast(err.message, 'error'); }
      });
      ctrl.append(shelfPick, statusPick);
    }

    const btns = document.createElement('div');
    btns.className = 'no-print';
    btns.style.marginTop = '4px';
    const printOne = document.createElement('button');
    printOne.textContent = '列印';
    printOne.addEventListener('click', () => printBarcodes([c]));
    const delOne = document.createElement('button');
    delOne.className = 'danger';
    delOne.textContent = '刪除';
    delOne.addEventListener('click', async () => {
      try {
        await Api.del(`/api/copies/${c.id}`);
        showToast('已刪除這一冊');
        await loadList();
        showDetail(id);
      } catch (err) {
        // 後端會說「有借閱紀錄，請改標記遺失」這種能照著做的話
        showToast(err.message, 'error');
      }
    });
    btns.append(printOne, delOne);
    wrap.append(label, ctrl, btns);
    box.appendChild(wrap);
  }

  document.getElementById('printAll').addEventListener('click', () => printBarcodes(t.copies));

  document.getElementById('addCopy').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await Api.post(`/api/titles/${id}/copies`, { copies: 1 });
      showToast('已加 1 冊');
      await loadList();
      showDetail(id);
    } catch (err) { showToast(err.message, 'error'); e.target.disabled = false; }
  });

  // 檔案上傳要用 FormData，不能走 Api.post（那會把內容 JSON.stringify）。
  document.getElementById('coverFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.disabled = true;
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
      loadList();
    } catch (err) { showToast(err.message, 'error'); }
    finally { e.target.disabled = false; }
  });
}

/** 建檔之後才發現打錯字、或想補上作者與 ISBN——這些都得能改。 */
function renderEditForm(t) {
  const isToy = t.kind === 'toy';
  const cats = categories.filter((c) => c.kind === t.kind);
  document.getElementById('form').innerHTML = `<div class="card">
    <h3>編輯${isToy ? '教具' : '書目'}資料</h3>
    <p><input id="e-title" placeholder="${isToy ? '教具名稱' : '書名'}"
              value="${esc(t.title ?? '')}"></p>
    ${isToy
      ? `<p><input id="e-note" placeholder="存放備註"
                   value="${esc(t.description ?? '')}"></p>`
      : `<p><input id="e-authors" placeholder="作者" value="${esc(t.authors ?? '')}"></p>
         <p><input id="e-publisher" placeholder="出版社" value="${esc(t.publisher ?? '')}"></p>
         <p><input id="e-isbn" placeholder="ISBN（可留空）" value="${esc(t.isbn13 ?? '')}"></p>`}
    <div class="row">
      <select id="e-category" style="max-width:200px">
        ${cats.map((c) => `<option value="${c.id}"${c.id === t.category_id ? ' selected' : ''}>
           ${esc(c.name)}</option>`).join('')}
      </select>
      <button class="primary" id="e-save">儲存</button>
      <button id="e-cancel">取消</button>
    </div>
  </div>`;

  document.getElementById('e-cancel').addEventListener('click', () => showDetail(t.id));

  document.getElementById('e-save').addEventListener('click', async (e) => {
    const body = {
      title: document.getElementById('e-title').value.trim(),
      category_id: Number(document.getElementById('e-category').value),
    };
    if (isToy) {
      body.description = document.getElementById('e-note').value.trim();
    } else {
      body.authors = document.getElementById('e-authors').value.trim();
      body.publisher = document.getElementById('e-publisher').value.trim();
      body.isbn13 = document.getElementById('e-isbn').value.trim();
    }
    if (!body.title) return showToast(isToy ? '請填寫教具名稱' : '請填寫書名', 'error');

    e.target.disabled = true;
    try {
      await Api.put(`/api/titles/${t.id}`, body);
      showToast('已儲存');
      await loadList();
      showDetail(t.id);
    } catch (err) {
      showToast(err.message, 'error');
      e.target.disabled = false;
    }
  });
}

/** 圖書：掃 ISBN → 預覽卡 → 確認建檔。離線或沒金鑰時直接展開空白表單。 */
function showBookForm() {
  document.getElementById('form').innerHTML = `<div class="card">
    <h3>新增圖書</h3>
    <div class="row scan-box">
      <input id="isbn" placeholder="掃描書背 ISBN 條碼，或手動輸入後按 Enter" autocomplete="off">
      <span id="isbnBusy" hidden><span class="spinner"></span> 查詢中…</span>
    </div>
    <div id="isbnHint" class="muted"></div>
  </div>`;
  const isbnEl = document.getElementById('isbn');
  const busyEl = document.getElementById('isbnBusy');
  const hintEl = document.getElementById('isbnHint');
  isbnEl.focus();

  isbnEl.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (busy) return;                        // 查詢中再按 Enter 一律忽略
    const isbn = isbnEl.value.trim();
    if (!isbn) return;

    busy = true;
    isbnEl.disabled = true;
    busyEl.hidden = false;
    hintEl.textContent = '';
    let r;
    try { r = await Api.get(`/api/lookup/isbn/${encodeURIComponent(isbn)}`); }
    catch { r = { found: false, online: false, info: null }; }
    finally {
      busy = false;
      isbnEl.disabled = false;
      busyEl.hidden = true;
    }

    if (r.found && r.source === 'local') {
      showToast(`這本已經有 ${r.existingCopies} 冊，改用「加冊」`, 'error');
      showDetail(r.titleId);
      return;
    }
    // 三種「沒帶到資料」的原因完全不同，訊息要講清楚是哪一種，
    // 否則使用者會以為是這本書的問題，而不知道是整個功能沒生效。
    if (!r.online) {
      hintEl.textContent = '目前沒有網路，無法自動帶資料，請直接手動填寫。';
    } else if (r.hint === 'no-api-key') {
      // 給連結而不是叫使用者去改設定檔——他不該需要知道 config.json 存在。
      hintEl.innerHTML = '尚未設定 Google Books 金鑰，目前掃任何書都不會自動帶資料。'
        + '<a href="/settings.html">前往設定</a>（免費申請，頁面上有步驟）。';
    } else if (!r.found) {
      hintEl.textContent = '查不到這本書的資料，請手動填寫。';
    }
    renderTitleForm({ ...(r.info ?? {}), isbn13: isbn }, 'book');
  });
}

function showToyForm() {
  document.getElementById('form').innerHTML = '';
  renderTitleForm({}, 'toy');
}

function renderTitleForm(info, kind) {
  const cats = categories.filter((c) => c.kind === kind);
  const isToy = kind === 'toy';

  // 一律先移除舊的表單卡片再加新的——不然重複掃會疊出一堆區塊。
  document.getElementById('titleForm')?.remove();

  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'titleForm';
  card.innerHTML = `
    <h3>${isToy ? '新增教具' : '確認書目資料'}</h3>
    ${info.coverUrl ? `<p><img class="cover-preview" src="${esc(info.coverUrl)}" alt=""></p>` : ''}
    <p><input id="f-title" placeholder="${isToy ? '教具名稱' : '書名'}"
              value="${esc(info.title ?? '')}"></p>
    ${isToy
      // 教具沒有作者與出版社，硬要它填那兩欄是沒道理的。
      ? '<p><input id="f-note" placeholder="存放備註（例：附收納袋、需電池）"></p>'
      : `<p><input id="f-authors" placeholder="作者" value="${esc(info.authors ?? '')}"></p>
         <p><input id="f-publisher" placeholder="出版社" value="${esc(info.publisher ?? '')}"></p>`}
    <div class="row">
      <select id="f-category" style="max-width:180px">
        ${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
      </select>
      <select id="f-shelf" style="max-width:220px">${shelfOptions()}</select>
      <input id="f-copies" type="number" min="1" value="1" style="max-width:110px"
             title="${isToy ? '件數' : '冊數'}">
      <button class="primary" id="f-save">建立並產生編號</button>
    </div>`;
  document.getElementById('form').appendChild(card);

  document.getElementById('f-save').addEventListener('click', async (e) => {
    if (busy) return;
    const btn = e.target;
    const body = {
      isbn13: info.isbn13 ?? null,
      title: document.getElementById('f-title').value.trim(),
      authors: isToy ? null : (document.getElementById('f-authors').value.trim() || null),
      publisher: isToy ? null : (document.getElementById('f-publisher').value.trim() || null),
      description: isToy
        ? (document.getElementById('f-note').value.trim() || null)
        : (info.description ?? null),
      published_date: info.published_date ?? null,
      coverUrl: info.coverUrl ?? null,
      source: info.source ?? 'manual',
      category_id: Number(document.getElementById('f-category').value),
      shelf_id: Number(document.getElementById('f-shelf').value) || null,
      copies: Number(document.getElementById('f-copies').value) || 1,
    };
    if (!body.title) return showToast(isToy ? '請填寫教具名稱' : '請填寫書名', 'error');
    if (!body.category_id) return showToast('請先選擇類型', 'error');

    busy = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 建立中…';
    try {
      const r = await Api.post('/api/titles', body);
      showToast(`建立完成，編號 ${r.copies.map((c) => c.barcode).join('、')}`);
      await loadList();
      showDetail(r.title.id);
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = '建立並產生編號';
    } finally {
      busy = false;
    }
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

let categories = [], shelves = [];
let busy = false;                 // 防止查詢／送出期間重複點出多個區塊
const detailDialogEl = document.getElementById('detailDialog');
const detailContentEl = document.getElementById('detailContent');
let detailRequest = 0;

function renderDetailDialog(heading, content, actions = '', actionPlacement = 'footer') {
  const actionBar = actions
    ? `<div class="row ${actionPlacement === 'top'
      ? 'detail-dialog-toolbar'
      : 'dialog-actions detail-dialog-actions'}">${actions}</div>`
    : '';
  detailContentEl.innerHTML = `<div class="row detail-dialog-header">
      <h2>${esc(heading)}</h2>
      <button class="close-detail"><span class="dialog-close-x">✕</span> 關閉</button>
    </div>
    ${actionPlacement === 'top' ? actionBar : ''}
    ${content}
    ${actionPlacement === 'footer' ? actionBar : ''}`;
  detailContentEl.querySelector('.close-detail').addEventListener('click', () => {
    detailDialogEl.close();
  });
  if (!detailDialogEl.open) detailDialogEl.showModal();
}

detailDialogEl.addEventListener('close', () => {
  detailRequest++;
  detailContentEl.innerHTML = '';
});

async function loadRefs() {
  [categories, shelves] = await Promise.all([
    Api.get('/api/categories'), Api.get('/api/shelves'),
  ]);
}

function shelfOptions() {
  return '<option value="">未指定櫃位</option>'
    + shelves.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
}

function batchOptions() {
  document.getElementById('batchCategory').innerHTML = '<option value="">類型不修改</option>'
    + categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  document.getElementById('batchShelf').innerHTML = '<option value="">櫃位不修改</option>'
    + '<option value="unset">改為未指定櫃位</option>'
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
      <td><input type="checkbox" class="pick" value="${t.id}"></td>
      <td>${coverCell(t.cover_path)}</td>
      <td>${esc(t.title)}</td>
      <td>${esc(t.authors ?? '')}</td>
      <td>${esc(t.category_name)}</td>
      <td>${t.available_copies} / ${t.total_copies}</td>
      <td><button data-id="${t.id}" class="detail">明細</button></td>
    </tr>`).join('')
    : '<tr><td colspan="7" class="muted">還沒有任何館藏</td></tr>';
  document.querySelectorAll('.detail').forEach((b) =>
    b.addEventListener('click', () => showDetail(Number(b.dataset.id))));
  // 重新載入清單之後勾選就沒了，全選框要跟著回到未勾，否則它的狀態會騙人。
  document.getElementById('pickAll').checked = false;
}

/**
 * 下載標籤機 App 要匯入的 Excel 檔。
 *
 * 不能走 Api.post——那支會把回應當 JSON 解析，而這裡回的是二進位檔。
 * 用 POST 而不是把 id 串在網址上：勾一整頁的書時網址會爆長。
 */
async function downloadLabelXlsx(titleIds) {
  const res = await fetch('/api/export/labels.xlsx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ titleIds }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? `匯出失敗（${res.status}）`);
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'labels.xlsx';
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * 印在標籤上的櫃位。沒指定櫃位就回空字串，讓標籤完全不印那一行——
 * 貼紙上印「尚未指定櫃位」對老師沒有任何用處，只是佔掉條碼的高度。
 */
function shelfNameOf(shelfId) {
  return shelves.find((s) => s.id === shelfId)?.name ?? '';
}

/** 只把櫃位與條碼送去列印——列印出來是要剪下來貼在書上的，其他東西都是干擾。 */
function printBarcodesOnA4(copies) {
  const area = document.getElementById('printArea');
  area.innerHTML = '';
  for (const c of copies) {
    const cell = document.createElement('div');
    cell.className = 'print-label';
    const shelf = shelfNameOf(c.shelf_id);
    if (shelf) {
      const head = document.createElement('div');
      head.className = 'print-shelf';
      head.textContent = shelf;
      cell.appendChild(head);
    }
    cell.appendChild(renderCode39(c.barcode));
    const txt = document.createElement('div');
    txt.textContent = c.barcode;
    cell.appendChild(txt);
    area.appendChild(cell);
  }
  window.print();
}

/**
 * 送去 NIIMBOT B21 標籤機，一張貼紙一冊。
 * 中途失敗要講清楚印到第幾張——不然老師不知道哪幾本已經有標籤、哪幾本要重印。
 */
async function printBarcodesOnB21(copies, cfg) {
  // 貼紙寬度換算成點之後要取 8 的倍數（一個 byte 存 8 個點），且不能超過印字頭。
  const cols = Math.min(NiimbotB21.PRINTHEAD_DOTS,
    Math.floor(NiimbotB21.mmToDots(cfg.labelWidthMm) / 8) * 8);
  const rows = NiimbotB21.mmToDots(cfg.labelHeightMm);

  for (let i = 0; i < copies.length; i++) {
    try {
      await NiimbotB21.printCanvas(
        renderCode39Label(copies[i].barcode, cols, rows, shelfNameOf(copies[i].shelf_id)));
    } catch (err) {
      // 使用者按了「取消」不是故障，講成失敗會讓他以為機器壞了。
      const reason = err.name === 'NotFoundError' ? '沒有選擇標籤機' : err.message;
      showToast(`${i ? `已印出前 ${i} 張，` : ''}${copies[i].barcode} 沒印成：${reason}`, 'error');
      return;
    }
  }
  showToast(`已送出 ${copies.length} 張標籤`);
}

let labelCfg = null;

/**
 * 依設定決定印到哪裡。設定讀不到就走 A4——
 * 列印是天天在用的功能，不能因為讀不到設定就整個不能印。
 */
async function printBarcodes(copies) {
  if (!labelCfg) {
    try { labelCfg = await Api.get('/api/settings'); }
    catch { labelCfg = { labelPrinter: 'a4' }; }
  }
  if (labelCfg.labelPrinter === 'b21') return printBarcodesOnB21(copies, labelCfg);
  printBarcodesOnA4(copies);
}

/**
 * 套書、繪者、譯者、頁數多半是空的（只有 BookBuddy 匯入的書才會有），
 * 有值才顯示——每本都印一排「套書： 繪者： 譯者：」的空標籤只是雜訊。
 */
function extraMeta(t) {
  const bits = [];
  if (t.series) bits.push(`套書：${t.series}${t.volume ? ` 第 ${t.volume} 冊` : ''}`);
  else if (t.volume) bits.push(`第 ${t.volume} 冊`);
  if (t.illustrator) bits.push(`繪者：${t.illustrator}`);
  if (t.translator) bits.push(`譯者：${t.translator}`);
  if (t.pages) bits.push(`${t.pages} 頁`);
  return bits;
}

/**
 * 明細含每一冊的編號條碼，可直接列印貼紙。
 * 同時是「補封面／教具照片」與「改櫃位」的入口——教具沒有 ISBN 抓不到圖，
 * 圖書也常常查不到封面，兩者都需要手動補。
 */
async function showDetail(id) {
  const request = ++detailRequest;
  renderDetailDialog('館藏明細', '<p class="muted">載入中…</p>');
  let t;
  try {
    t = await Api.get(`/api/titles/${id}`);
  } catch (err) {
    if (request === detailRequest && detailDialogEl.open) {
      renderDetailDialog('館藏明細', `<p class="muted">${esc(err.message)}</p>`);
    }
    return;
  }
  if (request !== detailRequest || !detailDialogEl.open) return;
  const isToy = t.kind === 'toy';
  renderDetailDialog(`館藏明細：${t.title}`, `
    <img id="cover" class="cover-detail" src="${esc(t.cover_path ?? '')}" alt=""
         ${t.cover_path ? '' : 'style="display:none"'}>
    <p class="muted">${isToy
      ? esc(t.description ?? '')
      : `${esc(t.authors ?? '')}　${esc(t.publisher ?? '')}　${esc(t.isbn13 ?? '')}`}</p>
    ${isToy || !extraMeta(t).length ? ''
      : `<p class="muted">${extraMeta(t).map(esc).join('　')}</p>`}
    <div id="copies"></div>`, `
    <button id="editTitle">編輯資料</button>
    <button id="addCopy">加冊</button>
    <button id="printAll">列印全部條碼</button>
    <label class="file-button" for="coverFile">${t.cover_path ? '更換圖片' : '上傳圖片'}</label>
    <input type="file" id="coverFile" accept="image/*" hidden>
    <button class="danger" id="delTitle">刪除整筆</button>`, 'top');

  document.getElementById('editTitle').addEventListener('click', () => renderEditForm(t));

  document.getElementById('delTitle').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await Api.del(`/api/titles/${id}`);
      showToast('已刪除');
      detailDialogEl.close();
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
    wrap.className = 'copy-card';
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
      outMark.innerHTML = '<span class="badge badge-out">借出中</span>'
        + '<span class="muted">　歸還後才能修改狀態</span>';
      ctrl.appendChild(outMark);
    } else {
      const shelfPick = document.createElement('select');
      shelfPick.innerHTML = shelfOptions();
      shelfPick.value = c.shelf_id ?? '';
      shelfPick.title = '放在哪個書櫃';
      shelfPick.addEventListener('change', async () => {
        try {
          await Api.put(`/api/copies/${c.id}`, { shelf_id: Number(shelfPick.value) || null });
          // 標籤上會印櫃位，而這一頁不會重畫——不同步回去就會印出改之前的舊櫃位。
          c.shelf_id = Number(shelfPick.value) || null;
          showToast('已更新櫃位');
        } catch (err) { showToast(err.message, 'error'); }
      });

      const statusPick = document.createElement('select');
      statusPick.innerHTML = statusOptions(c.status);
      statusPick.style.marginTop = '4px';
      statusPick.title = '這一冊的狀況';
      statusPick.addEventListener('change', async () => {
        statusPick.disabled = true;
        try {
          const updated = await Api.put(`/api/copies/${c.id}`, { status: statusPick.value });
          c.status = updated.status;
          showToast('已更新狀態');
          loadList();
        } catch (err) {
          statusPick.value = c.status;
          showToast(err.message, 'error');
        } finally {
          statusPick.disabled = false;
        }
      });
      ctrl.append(shelfPick, statusPick);
    }

    const btns = document.createElement('div');
    btns.className = 'row copy-actions no-print';
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
  detailRequest++;
  const isToy = t.kind === 'toy';
  const cats = categories.filter((c) => c.kind === t.kind);
  renderDetailDialog(`編輯${isToy ? '教具' : '書目'}資料`, `
    <p><input id="e-title" placeholder="${isToy ? '教具名稱' : '書名'}"
              value="${esc(t.title ?? '')}"></p>
    ${isToy
      ? `<p><input id="e-note" placeholder="存放備註"
                   value="${esc(t.description ?? '')}"></p>`
      : `<p><input id="e-authors" placeholder="作者" value="${esc(t.authors ?? '')}"></p>
         <div class="row">
           <input id="e-illustrator" placeholder="繪者（可留空）"
                  value="${esc(t.illustrator ?? '')}">
           <input id="e-translator" placeholder="譯者（可留空）"
                  value="${esc(t.translator ?? '')}">
         </div>
         <p><input id="e-publisher" placeholder="出版社" value="${esc(t.publisher ?? '')}"></p>
         <p><input id="e-isbn" placeholder="ISBN（可留空）" value="${esc(t.isbn13 ?? '')}"></p>
         <div class="row">
           <input id="e-series" placeholder="套書名（可留空）" value="${esc(t.series ?? '')}">
           <input id="e-volume" placeholder="第幾冊" style="max-width:120px"
                  value="${esc(t.volume ?? '')}">
           <input id="e-pages" type="number" min="1" placeholder="頁數" style="max-width:120px"
                  value="${esc(t.pages ?? '')}">
         </div>`}
    <p><select id="e-category" style="max-width:200px">
        ${cats.map((c) => `<option value="${c.id}"${c.id === t.category_id ? ' selected' : ''}>
           ${esc(c.name)}</option>`).join('')}
      </select></p>
  `, `<button class="primary" id="e-save">儲存</button>
      <button id="e-cancel">取消</button>`);

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
      body.illustrator = document.getElementById('e-illustrator').value.trim();
      body.translator = document.getElementById('e-translator').value.trim();
      body.publisher = document.getElementById('e-publisher').value.trim();
      body.isbn13 = document.getElementById('e-isbn').value.trim();
      body.series = document.getElementById('e-series').value.trim();
      body.volume = document.getElementById('e-volume').value.trim();
      body.pages = document.getElementById('e-pages').value.trim();
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

document.getElementById('pickAll').addEventListener('change', (e) => {
  document.querySelectorAll('.pick').forEach((box) => { box.checked = e.target.checked; });
});

document.getElementById('selectedActions').addEventListener('click', () => {
  if (!document.querySelectorAll('.pick:checked').length) {
    return showToast('請先勾選館藏', 'error');
  }
  document.getElementById('selectedDialog').showModal();
});

document.getElementById('closeSelectedDialog').addEventListener('click', () => {
  document.getElementById('selectedDialog').close();
});

document.getElementById('exportLabels').addEventListener('click', async (e) => {
  const ids = [...document.querySelectorAll('.pick:checked')].map((box) => Number(box.value));
  if (!ids.length) return showToast('請先勾選要印標籤的書', 'error');
  const btn = e.target;
  btn.disabled = true;
  try {
    await downloadLabelXlsx(ids);
    showToast(`已匯出 ${ids.length} 本書的標籤檔，每一冊一列`);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('batchUpdate').addEventListener('click', async (e) => {
  const titleIds = [...document.querySelectorAll('.pick:checked')].map((box) => Number(box.value));
  if (!titleIds.length) return showToast('請先勾選要修改的館藏', 'error');
  const category = document.getElementById('batchCategory').value;
  const shelf = document.getElementById('batchShelf').value;
  const status = document.getElementById('batchStatus').value;
  if (!category && !shelf && !status) return showToast('請選擇類型、櫃位或狀態', 'error');

  const body = { titleIds };
  if (category) body.category_id = Number(category);
  if (shelf) body.shelf_id = shelf === 'unset' ? null : Number(shelf);
  if (status) body.status = status;
  e.target.disabled = true;
  try {
    const result = await Api.put('/api/titles/batch', body);
    const done = [];
    if (category) done.push(`類型 ${result.changedTitles} 筆`);
    if (shelf) done.push(`櫃位 ${result.changedCopies} 冊`);
    if (status) done.push(`狀態 ${result.changedCopies} 冊`);
    await loadList();
    document.getElementById('selectedDialog').close();
    showToast(`已更新${done.join('，')}`);
  } catch (err) { showToast(err.message, 'error'); }
  finally { e.target.disabled = false; }
});
createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));

loadRefs().then(() => {
  batchOptions();
  loadList();
  const preset = new URLSearchParams(location.search).get('title');
  if (preset) showDetail(Number(preset));
});

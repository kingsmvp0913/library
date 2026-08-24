/** 把資料存成檔案讓瀏覽器下載，不需要伺服器再跑一趟。 */
function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function readFileText(input) {
  const file = input.files[0];
  if (!file) return null;
  return file.text();
}

// ---- 批量匯入 ----
document.getElementById('doImport').addEventListener('click', async (e) => {
  const btn = e.target;
  const out = document.getElementById('importResult');
  const text = await readFileText(document.getElementById('csvFile'));
  if (text === null) return showToast('請先選擇一個 CSV 檔', 'error');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 匯入中…';
  out.innerHTML = '';
  try {
    const r = await Api.post('/api/import/titles', { csv: text });
    const okLine = `<p>共讀到 ${r.total} 列，成功建立 <strong>${r.created}</strong> 筆。</p>`;
    // 錯誤要逐列列出來，不然使用者只知道「有問題」卻不知道問題在哪一列。
    const errLine = r.errors.length
      ? `<p class="muted">下列 ${r.errors.length} 列沒有建立：</p>
         <table><thead><tr><th>列號</th><th>書名</th><th>原因</th></tr></thead><tbody>
         ${r.errors.map((x) => `<tr><td>${x.row}</td><td>${esc(x.title)}</td>
            <td>${esc(x.message)}</td></tr>`).join('')}
         </tbody></table>`
      : '<p class="muted">沒有任何錯誤。</p>';
    out.innerHTML = okLine + errLine;
    showToast(r.errors.length ? `建立 ${r.created} 筆，${r.errors.length} 列有問題`
      : `建立 ${r.created} 筆`, r.errors.length ? 'error' : 'ok');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '開始匯入';
  }
});

// ---- BookBuddy 匯入 ----
// 兩段式：先產生預覽列表（其他欄位全部預填好），使用者只挑「櫃位」與「冊數」，
// 確認過整張表再送出。BookBuddy 檔本來就沒有這兩項，猜不得。
let bbRows = [];
let bbShelves = [];
let bbCategories = [];

function bbShelfOptions(selected) {
  return `<option value="">未指定櫃位</option>`
    + bbShelves.map((s) => `<option value="${s.id}"${Number(selected) === s.id ? ' selected' : ''}>
        ${esc(s.name)}</option>`).join('');
}

function bbRowHtml(r, i) {
  const meta = [r.subtitle, r.authors, r.publisher, r.published_date]
    .filter(Boolean).join(' · ');
  // 擋下來的列不給勾也不給改——讓它還能編輯，只會讓使用者以為改一改就能匯進去。
  const pickCells = r.blocked
    ? `<td colspan="2" class="muted">${esc(r.blocked)}</td>`
    : `<td><select class="bb-shelf" data-i="${i}" style="min-width:140px">
           ${bbShelfOptions(r.shelf_id)}</select></td>
       <td><input type="number" class="bb-copies" data-i="${i}"
           min="1" max="99" value="${r.copies}" style="width:80px"></td>`;
  return `<tr>
    <td><input type="checkbox" class="bb-pick" data-i="${i}"
      ${r.blocked ? 'disabled' : 'checked'}></td>
    <td>${esc(r.title)}<br><small class="muted">${esc(meta)}</small></td>
    <td><small>${esc(r.isbn13 ?? '')}</small></td>
    ${pickCells}
  </tr>`;
}

function bbPaint(data) {
  bbRows = data.rows;
  const panel = document.getElementById('bbPanel');
  panel.innerHTML = `
    <div class="row" style="margin-top:14px">
      <label style="width:auto">類型（整批套用）</label>
      <select id="bbCat" style="max-width:180px">
        ${bbCategories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
      </select>
      <label style="width:auto">櫃位</label>
      <select id="bbShelfAll" style="max-width:200px">${bbShelfOptions('')}</select>
      <button id="bbApplyShelf">套用到全部</button>
    </div>
    <p class="muted">共讀到 ${data.total} 列，可匯入 <strong>${data.importable}</strong> 列，
      ${data.total - data.importable} 列已存在或有問題（下表標註原因）。</p>
    <table>
      <thead><tr><th style="width:1%">匯入</th><th>書名</th><th>ISBN</th>
        <th>櫃位</th><th>冊數</th></tr></thead>
      <tbody>${bbRows.map(bbRowHtml).join('')}</tbody>
    </table>
    <div class="row" style="margin-top:12px">
      <button class="primary" id="bbCommit">確認匯入</button>
    </div>
    <div id="bbResult"></div>`;

  // 十幾列一個一個挑櫃位太折磨人，整批套用是這個畫面最常用的動作。
  document.getElementById('bbApplyShelf').addEventListener('click', () => {
    const v = document.getElementById('bbShelfAll').value;
    document.querySelectorAll('.bb-shelf').forEach((s) => { s.value = v; });
    showToast(v ? '已套用到全部' : '已把全部改成未指定櫃位');
  });
  document.getElementById('bbCommit').addEventListener('click', bbCommit);
}

/** 送出時以畫面上的值為準——使用者可能改過任何一個下拉或數字。 */
function bbSelected() {
  const categoryId = Number(document.getElementById('bbCat').value);
  const shelfOf = new Map();
  document.querySelectorAll('.bb-shelf').forEach((s) =>
    shelfOf.set(Number(s.dataset.i), s.value ? Number(s.value) : null));
  const copiesOf = new Map();
  document.querySelectorAll('.bb-copies').forEach((n) =>
    copiesOf.set(Number(n.dataset.i), Number(n.value) || 1));

  const out = [];
  document.querySelectorAll('.bb-pick').forEach((box) => {
    if (!box.checked) return;
    const i = Number(box.dataset.i);
    out.push({ ...bbRows[i], category_id: categoryId,
      shelf_id: shelfOf.get(i) ?? null, copies: copiesOf.get(i) ?? 1 });
  });
  return out;
}

async function bbCommit(e) {
  const btn = e.target;
  const rows = bbSelected();
  if (!rows.length) return showToast('沒有勾選任何一列', 'error');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 匯入中…';
  try {
    const r = await Api.post('/api/import/bookbuddy', { rows });
    const errLine = r.errors.length
      ? `<p class="muted">下列 ${r.errors.length} 列沒有建立：</p>
         <table><thead><tr><th>列號</th><th>書名</th><th>原因</th></tr></thead><tbody>
         ${r.errors.map((x) => `<tr><td>${x.row}</td><td>${esc(x.title)}</td>
            <td>${esc(x.message)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">沒有任何錯誤。</p>';
    document.getElementById('bbResult').innerHTML =
      `<p>建立 <strong>${r.created}</strong> 筆書目、<strong>${r.copies}</strong> 冊，
        抓到封面 ${r.covers} 張。</p>` + errLine;
    showToast(r.errors.length ? `建立 ${r.created} 筆，${r.errors.length} 列有問題`
      : `建立 ${r.created} 筆、${r.copies} 冊`, r.errors.length ? 'error' : 'ok');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '確認匯入';
  }
}

document.getElementById('bbPreview').addEventListener('click', async (e) => {
  const btn = e.target;
  const text = await readFileText(document.getElementById('bbFile'));
  if (text === null) return showToast('請先選擇 BookBuddy 匯出的 CSV 檔', 'error');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 讀取中…';
  document.getElementById('bbPanel').innerHTML = '';
  try {
    if (!bbCategories.length) {
      [bbCategories, bbShelves] = await Promise.all([
        Api.get('/api/categories'), Api.get('/api/shelves'),
      ]);
    }
    bbPaint(await Api.post('/api/import/bookbuddy/preview', { csv: text }));
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '產生預覽列表';
  }
});

// ---- 還原備份 ----
document.getElementById('doRestore').addEventListener('click', async (e) => {
  const btn = e.target;
  const out = document.getElementById('restoreResult');
  if (!document.getElementById('confirmRestore').checked) {
    return showToast('請先勾選確認，還原會覆蓋目前的資料', 'error');
  }
  const text = await readFileText(document.getElementById('backupFile'));
  if (text === null) return showToast('請先選擇備份檔', 'error');

  let backup;
  try { backup = JSON.parse(text); }
  catch { return showToast('這個檔不是有效的備份檔（JSON 格式錯誤）', 'error'); }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 還原中…';
  try {
    const r = await Api.post('/api/import/restore', { backup, confirm: true });
    // 先把還原前的現況存下來——還原不可逆，這是唯一的退路。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadJson(r.previousBackup, `還原前備份-${stamp}.json`);
    out.innerHTML = `<p>還原完成：書目 ${r.restored.titles} 筆、單冊 ${r.restored.copies} 筆、
      借閱人 ${r.restored.borrowers} 筆、借閱紀錄 ${r.restored.loans} 筆。</p>
      <p class="muted">還原前的現況已自動下載成「還原前備份-${stamp}.json」。</p>`;
    showToast('還原完成');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '還原';
  }
});

/**
 * 把檔案清單畫成可下載的連結。
 * 自動備份與系統紀錄都只是「一堆檔案」，共用同一段就好。
 */
async function paintFileList(hostId, url, hrefBase, emptyText, labelOf) {
  const host = document.getElementById(hostId);
  if (!host) return;
  try {
    const { files } = await Api.get(url);
    if (!files.length) { host.textContent = emptyText; return; }
    host.innerHTML = `<table><tbody>${files.map((f) => `
      <tr><td>${esc(labelOf(f))}</td>
        <td style="width:1%"><a href="${hrefBase}/${encodeURIComponent(f)}">
          <button>下載</button></a></td></tr>`).join('')}</tbody></table>`;
  } catch (err) {
    host.textContent = '讀取失敗：' + err.message;
  }
}

// 檔名是機器格式（auto-2026-08-13T09-30-00.json），畫面上要給人看得懂的時間
function backupLabel(f) {
  const m = f.match(/^auto-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
  return m ? `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}` : f;
}

function logLabel(f) {
  const m = f.match(/^library-(\d{4})-(\d{2})-(\d{2})\.log$/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : f;
}

paintFileList('backupList', '/api/backups', '/api/backups',
  '還沒有自動備份（系統啟動且已有館藏資料時才會產生）。', backupLabel);
paintFileList('logList', '/api/logs', '/api/logs',
  '目前沒有任何紀錄。', logLabel);

createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));

// 對帳用的三份清單改由 Excel 匯出；匯入範本仍維持 CSV，供既有匯入流程使用。
for (const name of ['titles', 'borrowers', 'loans']) {
  const link = document.querySelector(`a[href="/api/export/${name}.csv"]`);
  if (link) link.href = `/api/export/${name}.xlsx`;
}

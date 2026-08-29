const resultEl = document.getElementById('result');
const scanEl = document.getElementById('scan');
const borrowerEl = document.getElementById('borrower');
const batchCountEl = document.getElementById('batchCount');
const batchEmptyEl = document.getElementById('batchEmpty');
const batchTableEl = document.getElementById('batchTable');
const batchItemsEl = document.getElementById('batchItems');
const batchSummaryEl = document.getElementById('batchSummary');
const clearBatchEl = document.getElementById('clearBatch');
const confirmBatchEl = document.getElementById('confirmBatch');
const pending = new Map();
let scansInFlight = 0;
let confirming = false;

/** 掃到書時顯示封面，讓老師一眼確認拿對書了。 */
function coverImg(path) {
  return path ? `<p><img class="cover-scan" src="${esc(path)}" alt=""></p>` : '';
}

async function loadOpenLoans() {
  const rows = await Api.get('/api/loans?open=1');
  document.getElementById('openLoans').innerHTML = rows.length
    ? rows.map((r) => `<tr>
        <td>${esc(r.barcode)}</td>
        <td>${esc(r.title)}</td>
        <td>${esc(r.borrower_name)}${r.class_name ? '（' + esc(r.class_name) + '）' : ''}</td>
        <td class="muted">${new Date(r.borrowed_at).toLocaleDateString('zh-TW')}</td>
      </tr>`).join('')
    : '<tr><td class="muted">目前沒有外借中的書</td></tr>';
}

async function loadBorrowers() {
  try {
    const borrowers = await Api.get('/api/borrowers');
    borrowerEl.innerHTML = `<option value="">純歸還，不選借閱人</option>
      ${borrowers.map((b) => `<option value="${b.id}">${esc(b.name)}${b.class_name ? '（' + esc(b.class_name) + '）' : ''}</option>`).join('')}`;
  } catch (err) {
    borrowerEl.innerHTML = '<option value="">借閱人載入失敗</option>';
    showToast(err.message, 'error');
  }
  renderBatch();
}

function renderBatch() {
  const items = [...pending.values()];
  const borrowCount = items.filter((item) => item.action === 'borrow').length;
  const returnCount = items.length - borrowCount;
  const borrowerName = borrowerEl.selectedOptions[0]?.textContent ?? '';

  batchCountEl.textContent = items.length;
  batchEmptyEl.hidden = items.length > 0;
  batchTableEl.hidden = items.length === 0;
  batchItemsEl.innerHTML = items.map((item) => {
    const borrow = item.action === 'borrow';
    const detail = borrow
      ? (borrowerEl.value
        ? `借給：${esc(borrowerName)}`
        : '<span class="muted">尚未選擇借閱人</span>')
      : `<span class="batch-shelf">放回：${esc(item.shelfLabel)}</span>`;
    return `<tr>
      <td>${esc(item.copy.barcode)}</td>
      <td>${esc(item.title.title)}</td>
      <td><span class="badge ${borrow ? 'badge-borrow' : 'badge-return'}">${borrow ? '借出' : '歸還'}</span></td>
      <td>${detail}</td>
      <td><button class="batch-remove" data-remove-barcode="${esc(item.copy.barcode)}">移除</button></td>
    </tr>`;
  }).join('');

  const borrowerMissing = borrowCount > 0 && !borrowerEl.value;
  batchSummaryEl.textContent = `待借出 ${borrowCount} 冊 · 待歸還 ${returnCount} 冊`
    + (borrowerMissing ? ' · 請選擇借閱人' : '');
  clearBatchEl.disabled = confirming || items.length === 0;
  confirmBatchEl.disabled = confirming || scansInFlight > 0 || items.length === 0 || borrowerMissing;
  confirmBatchEl.textContent = confirming
    ? '處理中…'
    : (scansInFlight > 0 ? '讀取掃碼中…' : `確認全部（${items.length}）`);
  scanEl.disabled = confirming;
  borrowerEl.disabled = confirming;
}

function renderCompletion(items, borrowerName) {
  const borrowed = items.filter((item) => item.action === 'borrow');
  const returned = items.filter((item) => item.action === 'return');
  resultEl.innerHTML = `<div class="card batch-complete">
    <h2>這一批已完成</h2>
    <p>借出 ${borrowed.length} 冊${borrowed.length ? `（${esc(borrowerName)}）` : ''}，歸還 ${returned.length} 冊。</p>
    ${returned.length ? `<h3>歸還物品請放回</h3>
      <table><tbody>${returned.map((item) => `<tr>
        <td>${esc(item.copy.barcode)}</td>
        <td>${esc(item.title.title)}</td>
        <td class="batch-shelf">${esc(item.shelfLabel)}</td>
      </tr>`).join('')}</tbody></table>` : ''}
  </div>`;
}

async function handleScan(code) {
  scansInFlight++;
  renderBatch();
  try {
    const data = await Api.post('/api/scan', { barcode: code });
    if (data.action === 'blocked') {
      resultEl.innerHTML = `<div class="card">
        <h2>${esc(data.title.title)}</h2>
        ${coverImg(data.title.cover_path)}
        <p>${esc(data.message ?? '')}</p></div>`;
      return;
    }
    if (pending.has(data.copy.barcode)) {
      showToast(`${data.copy.barcode} 已經在待確認清單中`, 'error');
      return;
    }
    pending.set(data.copy.barcode, data);
    resultEl.innerHTML = '';
    showToast(`已加入待${data.action === 'borrow' ? '借出' : '歸還'}：${data.title.title}`);
  } catch (err) {
    resultEl.innerHTML = `<div class="card"><p>${esc(err.message)}</p></div>`;
  } finally {
    scansInFlight--;
    renderBatch();
    if (!confirming) scanEl.focus();
  }
}

batchItemsEl.addEventListener('click', (e) => {
  const button = e.target.closest('[data-remove-barcode]');
  if (!button) return;
  pending.delete(button.dataset.removeBarcode);
  renderBatch();
  scanEl.focus();
});

clearBatchEl.addEventListener('click', () => {
  pending.clear();
  resultEl.innerHTML = '';
  renderBatch();
  scanEl.focus();
});

borrowerEl.addEventListener('change', () => {
  renderBatch();
  scanEl.focus();
});

confirmBatchEl.addEventListener('click', async () => {
  const items = [...pending.values()];
  const borrowerId = borrowerEl.value;
  if (items.some((item) => item.action === 'borrow') && !borrowerId) {
    showToast('清單中有待借出項目，請先選擇借閱人', 'error');
    borrowerEl.focus();
    return;
  }

  confirming = true;
  renderBatch();
  try {
    const data = await Api.post('/api/scan/batch', {
      barcodes: items.map((item) => item.copy.barcode),
      ...(borrowerId ? { borrower_id: Number(borrowerId) } : {}),
    });
    const completedByBarcode = new Map(data.results.map((item) => [item.barcode, item]));
    const completed = items.map((item) => ({
      ...item,
      ...completedByBarcode.get(item.copy.barcode),
    }));
    const borrowerName = borrowerEl.selectedOptions[0]?.textContent ?? '';
    pending.clear();
    renderCompletion(completed, borrowerName);
    showToast(`整批完成：${completed.length} 冊`);
    loadOpenLoans();
  } catch (err) {
    showToast(err.message, 'error');
    resultEl.innerHTML = `<div class="card"><p>${esc(err.message)}</p></div>`;
  } finally {
    confirming = false;
    renderBatch();
    scanEl.focus();
  }
});

createScanInput({
  input: scanEl,
  onScan: handleScan,
  cameraButton: document.getElementById('camera'),
  video: document.getElementById('video'),
});
createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));
loadBorrowers();
loadOpenLoans();

// 從全站搜尋跳過來時直接帶入編號
const preset = new URLSearchParams(location.search).get('barcode');
if (preset) handleScan(preset);

const resultEl = document.getElementById('result');
const scanEl = document.getElementById('scan');

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

async function renderBorrow(data) {
  const borrowers = await Api.get('/api/borrowers');
  resultEl.innerHTML = `
    <div class="card">
      <h2>${esc(data.title.title)} <span class="badge badge-in">在架</span></h2>
      <p class="muted">${esc(data.copy.barcode)}　${esc(data.title.authors ?? '')}</p>
      <div class="row">
        <select id="borrower" style="max-width:320px">
          <option value="">請選擇借閱人…</option>
          ${borrowers.map((b) => `<option value="${b.id}">${esc(b.name)}${b.class_name ? '（' + esc(b.class_name) + '）' : ''}</option>`).join('')}
        </select>
        <button class="primary" id="doBorrow">確認借出</button>
      </div>
    </div>`;
  document.getElementById('doBorrow').addEventListener('click', async () => {
    const borrowerId = document.getElementById('borrower').value;
    if (!borrowerId) return showToast('請先選擇借閱人', 'error');
    try {
      await Api.post('/api/loans', {
        barcode: data.copy.barcode, borrower_id: Number(borrowerId),
      });
      showToast('借出成功');
      resultEl.innerHTML = '';
      loadOpenLoans();
      scanEl.focus();
    } catch (err) { showToast(err.message, 'error'); }
  });
}

function renderReturn(data) {
  resultEl.innerHTML = `
    <div class="card">
      <h2>${esc(data.title.title)} <span class="badge badge-out">借出中</span></h2>
      <p class="muted">${esc(data.copy.barcode)}　借閱人：${esc(data.borrower?.name ?? '未知')}</p>
      <div class="shelf-banner">請放回：${esc(data.shelfLabel)}</div>
      <button class="primary" id="doReturn">確認歸還</button>
    </div>`;
  document.getElementById('doReturn').addEventListener('click', async () => {
    try {
      const r = await Api.post('/api/returns', { barcode: data.copy.barcode });
      showToast('歸還完成，請放回 ' + r.shelfLabel);
      resultEl.innerHTML = '';
      loadOpenLoans();
      scanEl.focus();
    } catch (err) { showToast(err.message, 'error'); }
  });
}

async function handleScan(code) {
  try {
    const data = await Api.post('/api/scan', { barcode: code });
    if (data.action === 'borrow') return renderBorrow(data);
    if (data.action === 'return') return renderReturn(data);
    resultEl.innerHTML = `<div class="card">
      <h2>${esc(data.title.title)}</h2>
      <p class="muted">${esc(data.message ?? '')}</p></div>`;
  } catch (err) {
    resultEl.innerHTML = `<div class="card"><p>${esc(err.message)}</p></div>`;
  }
}

createScanInput({
  input: scanEl,
  onScan: handleScan,
  cameraButton: document.getElementById('camera'),
  video: document.getElementById('video'),
});
createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));
loadOpenLoans();

// 從全站搜尋跳過來時直接帶入編號
const preset = new URLSearchParams(location.search).get('barcode');
if (preset) handleScan(preset);

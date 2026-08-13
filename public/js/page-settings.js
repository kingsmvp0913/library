const statusEl = document.getElementById('status');
const maskedEl = document.getElementById('masked');
const keyEl = document.getElementById('apiKey');
const resultEl = document.getElementById('testResult');

const labelResultEl = document.getElementById('labelResult');
const widthEl = document.getElementById('labelWidth');
const heightEl = document.getElementById('labelHeight');

/** 選 A4 時貼紙尺寸沒有意義，藏起來免得使用者以為要填。 */
function paintLabelForm(printer) {
  document.querySelectorAll('input[name="labelPrinter"]').forEach((r) => {
    r.checked = r.value === printer;
  });
  document.getElementById('labelSizeRow').style.display = printer === 'b21' ? '' : 'none';
}

async function loadStatus() {
  try {
    const s = await Api.get('/api/settings');
    widthEl.value = s.labelWidthMm;
    heightEl.value = s.labelHeightMm;
    paintLabelForm(s.labelPrinter);
    if (s.hasGoogleBooksApiKey) {
      statusEl.textContent = '已設定';
      statusEl.className = 'badge badge-in';
      maskedEl.textContent = s.googleBooksApiKeyMasked;
    } else {
      statusEl.textContent = '尚未設定';
      statusEl.className = 'badge badge-out';
      maskedEl.textContent = '（目前掃 ISBN 不會自動帶資料）';
    }
  } catch (err) {
    statusEl.textContent = '讀取失敗';
    statusEl.className = 'badge badge-out';
    maskedEl.textContent = err.message;
  }
}

document.getElementById('testBtn').addEventListener('click', async (e) => {
  const btn = e.target;
  const key = keyEl.value.trim();
  if (!key) return showToast('請先貼上金鑰', 'error');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 測試中…';
  resultEl.textContent = '';
  try {
    const r = await Api.post('/api/settings/test-key', { googleBooksApiKey: key });
    resultEl.textContent = (r.ok ? '✅ ' : '⚠️ ') + r.message;
    showToast(r.ok ? '金鑰可用' : '金鑰無法使用', r.ok ? 'ok' : 'error');
  } catch (err) {
    resultEl.textContent = '⚠️ ' + err.message;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '測試看看';
  }
});

document.getElementById('saveBtn').addEventListener('click', async (e) => {
  const btn = e.target;
  const key = keyEl.value.trim();
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 儲存中…';
  try {
    await Api.put('/api/settings', { googleBooksApiKey: key });
    keyEl.value = '';                       // 存好就不要繼續把完整金鑰留在畫面上
    resultEl.textContent = key
      ? '已儲存，立刻生效。可以直接去館藏頁掃 ISBN 試試。'
      : '已清空金鑰，掃 ISBN 將不再自動帶資料。';
    showToast('已儲存');
    await loadStatus();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '儲存';
  }
});

document.querySelectorAll('input[name="labelPrinter"]').forEach((radio) => {
  radio.addEventListener('change', () => paintLabelForm(radio.value));
});

document.getElementById('saveLabel').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  try {
    const s = await Api.put('/api/settings', {
      labelPrinter: document.querySelector('input[name="labelPrinter"]:checked').value,
      labelWidthMm: Number(widthEl.value),
      labelHeightMm: Number(heightEl.value),
    });
    labelResultEl.textContent = s.labelPrinter === 'b21'
      ? `已設定為 B21，貼紙 ${s.labelWidthMm} × ${s.labelHeightMm} mm。去館藏頁按「列印」就會送到標籤機。`
      : '已設定為 A4 貼紙。去館藏頁按「列印」會開啟一般的列印視窗。';
    showToast('已儲存');
  } catch (err) {
    labelResultEl.textContent = '⚠️ ' + err.message;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));
loadStatus();

const statusEl = document.getElementById('status');
const maskedEl = document.getElementById('masked');
const keyEl = document.getElementById('apiKey');
const resultEl = document.getElementById('testResult');

const labelResultEl = document.getElementById('labelResult');
const widthEl = document.getElementById('labelWidth');
const heightEl = document.getElementById('labelHeight');

/** 選 A4 時貼紙尺寸與測試列印都沒有意義，藏起來免得使用者以為要填、要按。 */
function paintLabelForm(printer) {
  document.querySelectorAll('input[name="labelPrinter"]').forEach((r) => {
    r.checked = r.value === printer;
  });
  const show = printer === 'b21' ? '' : 'none';
  document.getElementById('labelSizeRow').style.display = show;
  document.getElementById('b21TestRow').style.display = show;
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

/**
 * 測試標籤：上面一條 3 點寬的細線，下面一塊整片黑。
 *
 * 這兩塊會走不同的指令——細線那幾列黑點只有 3 個，走座標指令（封包 19 bytes）；
 * 整片黑走整列點陣（50mm 貼紙是 61 bytes）。所以印出來的結果本身就是診斷：
 * 兩塊都有代表傳輸沒問題，只有其中一塊代表另一種封包沒生效。
 * 印一張真的條碼標籤全白時，分不出是圖沒畫出來還是封包沒送到。
 */
function testLabelCanvas(cols, rows) {
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';                                  // 透明會被當成全黑
  ctx.fillRect(0, 0, cols, rows);
  ctx.fillStyle = '#000';
  ctx.fillRect(Math.floor(cols / 2) - 1, 0, 3, Math.floor(rows / 3));
  ctx.fillRect(0, Math.floor((rows * 2) / 3), cols, Math.floor(rows / 3));
  return canvas;
}

/**
 * 印完就直接把診斷紀錄複製走。印成空白時整段流程一步都不會噴錯，
 * 而機器在使用者那邊、他不會開 DevTools——那段位元組是唯一的線索。
 */
async function copyDiagnostics(failure) {
  const log = NiimbotB21.diagnosticLog();
  const text = (failure ? `列印中斷：${failure}\n\n` : '')
    + (log || '（沒有任何紀錄——這一張根本沒送到標籤機）');

  const box = document.getElementById('b21TestResult');
  box.textContent = '';
  const head = document.createElement('p');
  box.appendChild(head);

  try {
    await navigator.clipboard.writeText(text);
    head.textContent = failure
      ? `⚠️ ${failure}。診斷紀錄已複製，請貼給維護系統的人。`
      : '✅ 測試標籤已送出，診斷紀錄已複製。印出來不對的話，把它貼給維護系統的人。';
    showToast('診斷紀錄已複製');
  } catch {
    // 剪貼簿被擋掉時不能只說失敗，還是要讓他拿得到內容。
    head.textContent = '瀏覽器擋掉了自動複製。請按 Ctrl+C 複製下面這段，再貼給維護系統的人：';
    const area = document.createElement('textarea');
    area.className = 'diag-log';
    area.rows = 8;
    area.value = text;
    box.appendChild(area);
    area.select();
  }
}

document.getElementById('b21Test').addEventListener('click', async (e) => {
  const btn = e.target;
  // 用畫面上目前填的尺寸，不是存檔的——才能改了尺寸馬上試，不必先儲存。
  const cols = Math.min(NiimbotB21.PRINTHEAD_DOTS,
    Math.floor(NiimbotB21.mmToDots(Number(widthEl.value)) / 8) * 8);
  const rows = NiimbotB21.mmToDots(Number(heightEl.value));
  if (!(cols > 0) || !(rows > 0)) {
    return showToast('請先填好貼紙的寬與高，再按測試', 'error');
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 列印中…';
  let failure = null;
  try {
    await NiimbotB21.printCanvas(testLabelCanvas(cols, rows));
  } catch (err) {
    // 使用者按了「取消」不是故障，講成失敗會讓他以為機器壞了。
    failure = err.name === 'NotFoundError' ? '沒有選擇標籤機' : err.message;
    showToast(failure, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '列印測試標籤';
  }
  await copyDiagnostics(failure);
});

createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));
loadStatus();

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

createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));

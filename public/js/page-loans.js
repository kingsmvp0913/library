async function load(openOnly) {
  const rows = await Api.get('/api/loans' + (openOnly ? '?open=1' : ''));
  document.getElementById('list').innerHTML = rows.length ? rows.map((r) => `
    <tr>
      <td>${esc(r.barcode)}</td>
      <td>${esc(r.title)}</td>
      <td>${esc(r.borrower_name)}${r.class_name ? '（' + esc(r.class_name) + '）' : ''}</td>
      <td>${new Date(r.borrowed_at).toLocaleString('zh-TW')}</td>
      <td>${r.returned_at
        ? new Date(r.returned_at).toLocaleString('zh-TW')
        : '<span class="badge badge-out">借出中</span>'}</td>
    </tr>`).join('')
    : '<tr><td class="muted">沒有借閱紀錄</td></tr>';
}

document.getElementById('openOnly').addEventListener('change', (e) => load(e.target.checked));
createOmniSearch(document.getElementById('omni'), document.getElementById('omniPanel'));
load(false);

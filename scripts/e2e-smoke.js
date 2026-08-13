#!/usr/bin/env node
/**
 * e2e-smoke.js — 對真正跑起來的系統走一遍幼稚園的日常流程。
 *
 * 這支補的是自動化測試的兩個盲點：
 *   1. jest 用 pg-mem，這裡用真的 PostgreSQL（partial index、JOIN 行為都可能不同）
 *   2. jest 用 supertest 注入 app，這裡打真的 HTTP
 * 前端點擊仍然只能人工驗，這支不涵蓋。
 *
 * 用法：先啟動系統，再 `node scripts/e2e-smoke.js`
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
const BASE = `http://localhost:${cfg.PORT ?? 3940}`;

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  [OK] ${label}`); }
  else { fail++; console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); }
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, opts);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

(async () => {
  // 每次跑用不同後綴，避免與前一次的資料撞 UNIQUE
  const tag = String(Date.now()).slice(-6);
  console.log(`=== 端到端煙霧測試（tag=${tag}）===`);

  console.log('\n[1] 建立書櫃');
  const top = await api('POST', '/api/shelves', { name: `A櫃${tag}` });
  check('只填名稱就能建立書櫃', top.status === 200 && top.body.id > 0, JSON.stringify(top.body));
  check('代碼自動產生，使用者不必自己編',
    /^S[0-9]{3}$/.test(top.body.code ?? ''), `code=${top.body.code}`);
  const noName = await api('POST', '/api/shelves', {});
  check('缺名稱回 400', noName.status === 400, `實際 ${noName.status}`);

  console.log('\n[2] 建立借閱人');
  const borrower = await api('POST', '/api/borrowers', { name: `小明${tag}`, class_name: '小班' });
  check('建立借閱人', borrower.status === 200 && borrower.body.id > 0);

  console.log('\n[3] 建立圖書 2 冊與教具 1 件');
  const cats = await api('GET', '/api/categories');
  const bookCat = cats.body.find((c) => c.kind === 'book');
  const toyCat = cats.body.find((c) => c.kind === 'toy');
  check('類型種子資料含圖書與教具', !!bookCat && !!toyCat);

  const book = await api('POST', '/api/titles', {
    isbn13: `978000000${tag}`, title: `好餓的毛毛蟲${tag}`, authors: '艾瑞．卡爾',
    category_id: bookCat.id, copies: 2, shelf_id: top.body.id,
  });
  check('建立圖書 2 冊', book.status === 200 && book.body.copies.length === 2,
    JSON.stringify(book.body).slice(0, 120));
  check('圖書編號是 B- 開頭', /^B-\d{6}$/.test(book.body.copies[0].barcode),
    book.body.copies[0]?.barcode);

  const toy = await api('POST', '/api/titles', {
    title: `木製積木${tag}`, category_id: toyCat.id, copies: 1,
  });
  check('建立教具（無 ISBN）', toy.status === 200);
  check('教具編號是 T- 開頭', /^T-\d{6}$/.test(toy.body.copies[0].barcode),
    toy.body.copies[0]?.barcode);

  const dup = await api('POST', '/api/titles', {
    isbn13: `978000000${tag}`, title: '重複', category_id: bookCat.id,
  });
  check('同 ISBN 重複建立被擋（409）', dup.status === 409, `實際 ${dup.status}`);

  console.log('\n[4] 掃碼借書');
  const barcode = book.body.copies[0].barcode;
  const scan1 = await api('POST', '/api/scan', { barcode });
  check('在架的冊回 borrow', scan1.body.action === 'borrow', scan1.body.action);

  const loan = await api('POST', '/api/loans', { barcode, borrower_id: borrower.body.id });
  check('借出成功', loan.status === 200, JSON.stringify(loan.body).slice(0, 120));

  const again = await api('POST', '/api/loans', { barcode, borrower_id: borrower.body.id });
  check('同一冊不能借第二次（409）', again.status === 409, `實際 ${again.status}`);

  console.log('\n[5] 掃碼還書並顯示櫃位');
  const scan2 = await api('POST', '/api/scan', { barcode });
  check('借出中的冊回 return', scan2.body.action === 'return', scan2.body.action);
  check('櫃位字串就是書櫃名稱',
    scan2.body.shelfLabel === `A櫃${tag}`, scan2.body.shelfLabel);
  check('帶回借閱人', scan2.body.borrower?.name === `小明${tag}`, scan2.body.borrower?.name);

  const ret = await api('POST', '/api/returns', { barcode });
  check('歸還成功並回傳櫃位',
    ret.status === 200 && ret.body.shelfLabel === `A櫃${tag}`, ret.body.shelfLabel);

  const retAgain = await api('POST', '/api/returns', { barcode });
  check('沒借出的冊不能歸還（409）', retAgain.status === 409, `實際 ${retAgain.status}`);

  console.log('\n[6] 借閱紀錄（真 PG 的 partial index 下歷史紀錄要看得到）');
  const open = await api('GET', '/api/loans?open=1');
  check('未歸還清單不含已還的', !open.body.some((l) => l.barcode === barcode));
  const all = await api('GET', '/api/loans');
  check('全部紀錄看得到已歸還的那筆',
    all.body.some((l) => l.barcode === barcode && l.returned_at),
    `共 ${all.body.length} 筆`);

  console.log('\n[7] 教具借還走同一條流程');
  const toyBc = toy.body.copies[0].barcode;
  const toyLoan = await api('POST', '/api/loans',
    { barcode: toyBc, borrower_id: borrower.body.id });
  check('教具可以借出', toyLoan.status === 200);
  const toyRet = await api('POST', '/api/returns', { barcode: toyBc });
  check('教具未指定櫃位時有明確字樣',
    toyRet.body.shelfLabel === '尚未指定櫃位', toyRet.body.shelfLabel);

  console.log('\n[8] 全站搜尋');
  const s1 = await api('GET', `/api/search/suggest?q=毛毛蟲${tag}`);
  check('用書名搜得到書目',
    s1.body.groups.find((g) => g.type === 'title').items.length > 0);
  const s2 = await api('GET', `/api/search/suggest?q=${barcode}`);
  check('用編號搜得到單冊',
    s2.body.groups.find((g) => g.type === 'copy').items[0]?.title === barcode);
  const s3 = await api('GET', `/api/search/suggest?q=小明${tag}`);
  check('用姓名搜得到借閱人',
    s3.body.groups.find((g) => g.type === 'borrower').items.length > 0);
  const s4 = await api('GET', `/api/search/suggest?q=A櫃${tag}`);
  check('用櫃名搜得到書櫃',
    s4.body.groups.find((g) => g.type === 'shelf').items.length > 0);

  console.log('\n[9] 館藏統計');
  const titles = await api('GET', `/api/titles?q=毛毛蟲${tag}`);
  const row = titles.body[0];
  check('總冊數正確', row?.total_copies === 2, `total=${row?.total_copies}`);
  check('在架冊數正確', row?.available_copies === 2, `available=${row?.available_copies}`);

  console.log('\n[10] 單冊維護');
  const copyId = book.body.copies[1].id;
  const moved = await api('PUT', `/api/copies/${copyId}`, { shelf_id: top.body.id });
  check('可以改櫃位', moved.status === 200 && moved.body.shelf_id === top.body.id);
  const noRename = await api('PUT', `/api/copies/${copyId}`, { barcode: 'B-999999' });
  check('不可修改編號（400）', noRename.status === 400, `實際 ${noRename.status}`);

  console.log('\n[11] 匯出');
  const csvRes = await fetch(BASE + '/api/export/titles.csv');
  // 必須看原始 bytes：fetch 的 .text() 依規範會自動剝掉 UTF-8 BOM，用它永遠驗不到。
  const csvBytes = new Uint8Array(await csvRes.clone().arrayBuffer());
  const csvText = await csvRes.text();
  check('館藏 CSV 有 UTF-8 BOM（Excel 開中文才不會亂碼）',
    csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF,
    `前三 byte = ${[...csvBytes.slice(0, 3)].map((b) => b.toString(16)).join(' ')}`);
  check('館藏 CSV 含剛建的書', csvText.includes(`毛毛蟲${tag}`));
  check('館藏 CSV 帶下載檔名',
    (csvRes.headers.get('content-disposition') ?? '').includes('.csv'));
  const borrowersCsv = await (await fetch(BASE + '/api/export/borrowers.csv')).text();
  check('借閱人 CSV 含剛建的人', borrowersCsv.includes(`小明${tag}`));
  const loansCsv = await (await fetch(BASE + '/api/export/loans.csv')).text();
  check('借閱紀錄 CSV 有資料', loansCsv.split('\n').length > 2);

  const backup = await api('GET', '/api/export/backup.json');
  check('完整備份含七張表', Object.keys(backup.body.tables).length === 7);
  check('備份含 counters（沒有它還原後會撞號）',
    Array.isArray(backup.body.tables.counters) && backup.body.tables.counters.length === 4,
    `counters=${backup.body.tables.counters?.length}`);

  console.log('\n[12] 批量匯入');
  const cats2 = await api('GET', '/api/categories');
  const bookCatName = cats2.body.find((c) => c.kind === 'book').name;
  const importCsv = `書名,作者,出版社,ISBN,類型,櫃位,冊數,備註
匯入測試書${tag},作者,出版社,97811111${tag},${bookCatName},A櫃${tag},2,
,沒書名的壞列,,,${bookCatName},,1,
壞類型${tag},,,,不存在的類型,,1,`;
  const imp = await api('POST', '/api/import/titles', { csv: importCsv });
  check('成功建立 1 筆', imp.body.created === 1, `created=${imp.body.created}`);
  check('兩列錯誤被逐列回報', imp.body.errors.length === 2,
    JSON.stringify(imp.body.errors).slice(0, 120));
  // 這份 CSV 的第 2 列是正常的，第一個壞列在第 3 列（標頭算第 1 列）
  check('錯誤帶得出列號', imp.body.errors[0]?.row === 3, `row=${imp.body.errors[0]?.row}`);

  const impList = await api('GET', `/api/titles?q=匯入測試書${tag}`);
  check('匯入的書有 2 冊且發了編號', impList.body[0]?.total_copies === 2);
  check('匯入時指定的櫃位有生效', impList.body.length === 1);

  console.log('\n[13] 沒設定金鑰時的提示');
  const noKey = await api('GET', '/api/lookup/isbn/9786264063463');
  if (backup.body.tables.titles.length >= 0) {
    check('查不到時回報原因（no-api-key 或單純查無）',
      noKey.body.found === false && 'hint' in noKey.body,
      JSON.stringify(noKey.body));
  }

  console.log('\n[14] 修改');
  const titleId = book.body.title.id;
  const renamed = await api('PUT', `/api/titles/${titleId}`,
    { title: `改過書名${tag}`, authors: '改過作者' });
  check('書目可以改名與改作者',
    renamed.status === 200 && renamed.body.title === `改過書名${tag}`,
    JSON.stringify(renamed.body).slice(0, 100));
  const isbnClash = await api('PUT', `/api/titles/${toy.body.title.id}`,
    { isbn13: `978000000${tag}` });
  check('改成別人已在用的 ISBN 被擋（409）', isbnClash.status === 409,
    `實際 ${isbnClash.status}`);
  const shelfRenamed = await api('PUT', `/api/shelves/${top.body.id}`, { name: `改名櫃${tag}` });
  check('書櫃可以改名', shelfRenamed.status === 200 && shelfRenamed.body.name === `改名櫃${tag}`);
  check('書櫃改名不影響代碼', shelfRenamed.body.code === top.body.code);
  const newCat = await api('POST', '/api/categories', { name: `有聲書${tag}`, kind: 'book' });
  check('類型只填名稱就能建立，代碼自動產生',
    newCat.status === 200 && /^C[0-9]{3}$/.test(newCat.body.code ?? ''),
    `code=${newCat.body.code}`);

  console.log('\n[15] 刪除防護要講人話');
  const delShelf = await api('DELETE', `/api/shelves/${top.body.id}`);
  check('書櫃還有書時不可刪除（409）', delShelf.status === 409, `實際 ${delShelf.status}`);
  check('訊息講得出還有幾本', /\d/.test(delShelf.body?.error ?? ''), delShelf.body?.error);
  check('訊息沒有資料庫術語',
    !/foreign key|constraint|violates/i.test(delShelf.body?.error ?? ''), delShelf.body?.error);

  const delTitle = await api('DELETE', `/api/titles/${titleId}`);
  check('還有冊的書目不可刪除（409）', delTitle.status === 409, delTitle.body?.error);

  const delUsedCopy = await api('DELETE', `/api/copies/${book.body.copies[0].id}`);
  check('有借閱紀錄的冊不可刪除（409）', delUsedCopy.status === 409, delUsedCopy.body?.error);
  check('並建議改標記遺失', /遺失/.test(delUsedCopy.body?.error ?? ''), delUsedCopy.body?.error);

  const delBorrower = await api('DELETE', `/api/borrowers/${borrower.body.id}`);
  check('有紀錄的借閱人不可刪除（409）', delBorrower.status === 409, delBorrower.body?.error);
  check('並建議改用停用', /停用/.test(delBorrower.body?.error ?? ''), delBorrower.body?.error);

  // 沒借過、也沒被用到的資料要真的刪得掉，否則防護就變成「什麼都刪不掉」
  const freshShelf = await api('POST', '/api/shelves', { name: `空櫃${tag}` });
  check('空書櫃可以刪除',
    (await api('DELETE', `/api/shelves/${freshShelf.body.id}`)).status === 200);
  check('沒有館藏在用的類型可以刪除',
    (await api('DELETE', `/api/categories/${newCat.body.id}`)).status === 200);

  console.log('\n[16] 借閱人停用');
  await api('PUT', `/api/borrowers/${borrower.body.id}`, { active: false });
  const activeList = await api('GET', '/api/borrowers');
  check('停用後不出現在預設清單（借書下拉也看不到）',
    !activeList.body.some((b) => b.id === borrower.body.id));
  const allList = await api('GET', '/api/borrowers?includeInactive=1');
  check('但管理畫面叫得出來', allList.body.some((b) => b.id === borrower.body.id));
  await api('PUT', `/api/borrowers/${borrower.body.id}`, { active: true });
  check('可以再啟用',
    (await api('GET', '/api/borrowers')).body.some((b) => b.id === borrower.body.id));

  console.log('\n[17] 明細查詢（全站搜尋點下去要真的有東西）');
  const mingLoans = await api('GET', `/api/loans?borrower=${borrower.body.id}`);
  check('查得到這個人的借閱紀錄', mingLoans.body.length > 0, `${mingLoans.body.length} 筆`);
  check('借閱紀錄帶得出書名', !!mingLoans.body[0]?.title, mingLoans.body[0]?.title);
  const mingOpen = await api('GET', `/api/loans?borrower=${borrower.body.id}&open=1`);
  check('可以只看未歸還的',
    mingOpen.body.length <= mingLoans.body.length,
    `未歸還 ${mingOpen.body.length} / 全部 ${mingLoans.body.length}`);

  const shelfCopies = await api('GET', `/api/copies?shelf=${top.body.id}`);
  check('查得到這個書櫃上的書', shelfCopies.body.length > 0, `${shelfCopies.body.length} 冊`);
  check('書櫃明細帶得出書名與狀態',
    !!shelfCopies.body[0]?.title && !!shelfCopies.body[0]?.status);
  check('沒帶 shelf 參數不可以整包倒出來',
    (await api('GET', '/api/copies')).status === 400);

  console.log('\n[18] 自動備份與系統紀錄');
  const backups = await api('GET', '/api/backups');
  check('列得出自動備份（啟動時產生）', backups.body.files.length > 0,
    `${backups.body.files.length} 份`);
  const logs = await api('GET', '/api/logs');
  check('列得出系統紀錄', logs.body.files.length > 0, `${logs.body.files.length} 個`);
  // 檔名沒驗就是路徑穿越，使用者整台電腦都讀得到
  check('紀錄檔名不合格式時擋下（400）',
    (await api('GET', '/api/logs/library-9999.log')).status === 400);
  check('備份檔名不合格式時擋下（400）',
    (await api('GET', '/api/backups/whatever.json')).status === 400);

  // 還原會清掉整個資料庫，預設不跑——這台機器上可能有使用者手動輸入的資料。
  // 要驗證還原路徑請加參數：node scripts/e2e-smoke.js --include-restore
  if (process.argv.includes('--include-restore')) {
    console.log('\n[19] 還原（原地還原剛才那份備份）');
    const before = (await api('GET', '/api/titles')).body.length;
    const r = await api('POST', '/api/import/restore',
      { backup: backup.body, confirm: true });
    check('還原成功', r.status === 200, JSON.stringify(r.body).slice(0, 120));
    check('還原有回傳還原前的備份（唯一的退路）', !!r.body.previousBackup?.tables);
    const after = (await api('GET', '/api/titles')).body.length;
    check('還原後書目數回到備份當時', after === backup.body.tables.titles.length,
      `還原前畫面 ${before} 筆、備份 ${backup.body.tables.titles.length} 筆、還原後 ${after} 筆`);
  } else {
    console.log('\n[19] 還原 —— 已跳過（會清空資料庫）。要驗請加 --include-restore');
  }

  console.log(`\n=== 結果：${pass} 通過、${fail} 失敗 ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('煙霧測試中斷：' + err.message);
  console.error('請確認系統已經啟動（雙擊「啟動.bat」）。');
  process.exit(1);
});

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

  console.log('\n[1] 建立書櫃兩層');
  const top = await api('POST', '/api/shelves', { code: `A${tag}`, name: `A櫃${tag}` });
  check('建立頂層櫃', top.status === 200 && top.body.id > 0, JSON.stringify(top.body));
  const lv = await api('POST', '/api/shelves',
    { code: `A${tag}-2`, name: '第2層', parent_id: top.body.id });
  check('建立第二層', lv.status === 200);
  const bad = await api('POST', '/api/shelves',
    { code: `A${tag}-3`, name: '第3層', parent_id: lv.body.id });
  check('第三層被擋下（回 400）', bad.status === 400, `實際 ${bad.status}`);

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
    category_id: bookCat.id, copies: 2, shelf_id: lv.body.id,
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
  check('櫃位字串正確組出「櫃 · 層」',
    scan2.body.shelfLabel === `A櫃${tag} · 第2層`, scan2.body.shelfLabel);
  check('帶回借閱人', scan2.body.borrower?.name === `小明${tag}`, scan2.body.borrower?.name);

  const ret = await api('POST', '/api/returns', { barcode });
  check('歸還成功並回傳櫃位', ret.status === 200 && ret.body.shelfLabel.includes('第2層'),
    ret.body.shelfLabel);

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

  console.log(`\n=== 結果：${pass} 通過、${fail} 失敗 ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('煙霧測試中斷：' + err.message);
  console.error('請確認系統已經啟動（雙擊「啟動.bat」）。');
  process.exit(1);
});

const { toCsv, parseCsv, BOM } = require('../lib/csv.js');

describe('toCsv', () => {
  // 沒有 BOM 的 UTF-8 CSV，Excel 會用系統編碼開，中文全變亂碼。
  test('開頭有 UTF-8 BOM，Excel 才不會把中文開成亂碼', () => {
    expect(toCsv(['書名'], [['好餓的毛毛蟲']]).startsWith(BOM)).toBe(true);
  });

  test('含逗號的欄位會被引號包起來', () => {
    const out = toCsv(['書名'], [['A,B']]);
    expect(out).toContain('"A,B"');
  });

  test('含雙引號的欄位會把引號加倍', () => {
    expect(toCsv(['書名'], [['他說"你好"']])).toContain('"他說""你好"""');
  });

  test('含換行的欄位會被引號包起來', () => {
    expect(toCsv(['備註'], [['第一行\n第二行']])).toContain('"第一行\n第二行"');
  });

  test('null 與 undefined 輸出成空字串，不是字面的 null', () => {
    const out = toCsv(['a', 'b'], [[null, undefined]]);
    expect(out).not.toContain('null');
    expect(out).not.toContain('undefined');
  });
});

describe('parseCsv', () => {
  test('解析基本表格並以標頭為 key', () => {
    const rows = parseCsv('書名,作者\n毛毛蟲,卡爾\n');
    expect(rows).toEqual([{ 書名: '毛毛蟲', 作者: '卡爾' }]);
  });

  test('吃得下 BOM（使用者從 Excel 另存的檔一定有）', () => {
    const rows = parseCsv(BOM + '書名\n毛毛蟲\n');
    expect(rows[0]['書名']).toBe('毛毛蟲');
  });

  test('引號內的逗號不當成欄位分隔', () => {
    const rows = parseCsv('書名,作者\n"A,B",卡爾\n');
    expect(rows[0]['書名']).toBe('A,B');
  });

  test('引號內的換行不當成換行', () => {
    const rows = parseCsv('備註\n"第一行\n第二行"\n');
    expect(rows[0]['備註']).toBe('第一行\n第二行');
  });

  test('雙引號跳脫還原成單一引號', () => {
    const rows = parseCsv('書名\n"他說""你好"""\n');
    expect(rows[0]['書名']).toBe('他說"你好"');
  });

  // Excel 存出來的檔是 CRLF，當成資料的一部分會讓每個值尾巴多一個 \r
  test('CRLF 換行不會在值尾留下 \\r', () => {
    const rows = parseCsv('書名,作者\r\n毛毛蟲,卡爾\r\n');
    expect(rows[0]['作者']).toBe('卡爾');
  });

  test('略過完全空白的列', () => {
    expect(parseCsv('書名\n毛毛蟲\n\n')).toHaveLength(1);
  });

  test('欄位數少於標頭時補空字串，不要變成 undefined', () => {
    const rows = parseCsv('書名,作者\n只有書名\n');
    expect(rows[0]['作者']).toBe('');
  });

  test('來回轉換後內容不變', () => {
    const original = [{ 書名: 'A,B', 備註: '他說"嗨"\n下一行' }];
    const csv = toCsv(['書名', '備註'], original.map((r) => [r['書名'], r['備註']]));
    expect(parseCsv(csv)).toEqual(original);
  });
});

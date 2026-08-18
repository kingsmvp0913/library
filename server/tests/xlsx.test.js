const zlib = require('zlib');
const { toXlsx, crc32, colName, safeSheetName } = require('../lib/xlsx.js');

/**
 * 這支測試驗的是「產出來的位元組是不是一個合法的 .xlsx」，不是「Excel 打不打得開」——
 * 後者只有真的拿檔案去餵那支 App 才知道。所以這裡自己把 zip 拆開來檢查，
 * 而不是只斷言「有回傳 Buffer」：格式錯了照樣會回傳 Buffer，錯在使用者那端才爆。
 *
 * 只解 stored（不壓縮）的項目，因為 lib/xlsx.js 就只產這一種。
 */
function unzip(buf) {
  const files = {};
  let pos = 0;
  while (buf.readUInt32LE(pos) === 0x04034b50) {
    const method = buf.readUInt16LE(pos + 8);
    if (method !== 0) throw new Error(`預期 stored，實際壓縮方式 ${method}`);
    const crc = buf.readUInt32LE(pos + 14);
    const size = buf.readUInt32LE(pos + 22);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const name = buf.slice(pos + 30, pos + 30 + nameLen).toString('utf8');
    const start = pos + 30 + nameLen + extraLen;
    const data = buf.slice(start, start + size);
    if (zlib.crc32(data) !== crc) throw new Error(`${name} 的 CRC 對不上`);
    files[name] = data.toString('utf8');
    pos = start + size;
  }
  return files;
}

describe('xlsx 產生器', () => {
  // Node 內建的 zlib.crc32 是獨立實作，拿它當對照組才驗得出自己這支寫錯。
  test('CRC32 與 Node 內建實作一致', () => {
    for (const s of ['', 'B-000001', '毛毛蟲', 'a'.repeat(1000)]) {
      expect(crc32(Buffer.from(s, 'utf8'))).toBe(zlib.crc32(Buffer.from(s, 'utf8')));
    }
  });

  test('產出的 zip 每一項都解得開，且含 OPC 規定的那幾支檔', () => {
    const files = unzip(toXlsx(['編號'], [['B-000001']]));
    expect(Object.keys(files)).toEqual([
      '[Content_Types].xml',          // 規格要求它是第一項
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/sharedStrings.xml',
      'xl/worksheets/sheet1.xml',
    ]);
  });

  test('標頭與每一列都寫進去，且座標是對的', () => {
    const files = unzip(toXlsx(['編號', '櫃位'], [['B-000001', 'A櫃'], ['B-000002', '']]));
    const sheet = files['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('<row r="1">');
    expect(sheet).toContain('<row r="3">');
    expect(sheet).toContain('<c r="B3"');
    expect(sheet).toContain('ref="A1:B3"');
    expect(files['xl/sharedStrings.xml']).toContain('<t xml:space="preserve">B-000002</t>');
  });

  /**
   * 這條是這個檔案存在的理由：編號被對方當成數字或日期，印出來的條碼就跟書上的對不上，
   * 而且不會有任何錯誤訊息。全部 cell 都必須是 t="s"（sharedString，即文字）。
   */
  test('每一格都是文字型別，不會被當成數字', () => {
    const sheet = unzip(toXlsx(['編號'], [['000123'], ['2026-08-18']]))['xl/worksheets/sheet1.xml'];
    expect(sheet.match(/<c /g)).toHaveLength(3);
    expect(sheet.match(/t="s"/g)).toHaveLength(3);
  });

  // 書名是使用者貼進來的，& 與 < 不跳脫會讓對方開檔直接說「檔案毀損」。
  test('XML 特殊字元會跳脫，控制字元會被拿掉', () => {
    const shared = unzip(toXlsx(['書名'], [['A & B <c>\x07']]))['xl/sharedStrings.xml'];
    expect(shared).toContain('A &amp; B &lt;c&gt;');
    expect(shared).not.toContain('\x07');
  });

  // 同一個字串只存一份，cell 放索引——所以重複的櫃位名稱不會讓檔案膨脹。
  test('重複的值共用同一筆 sharedString', () => {
    const shared = unzip(toXlsx(['櫃位'], [['A櫃'], ['A櫃'], ['B櫃']]))['xl/sharedStrings.xml'];
    expect(shared).toContain('uniqueCount="3"');       // 櫃位、A櫃、B櫃
    expect(shared.match(/A櫃/g)).toHaveLength(1);
  });

  test('欄名換算', () => {
    expect(colName(0)).toBe('A');
    expect(colName(25)).toBe('Z');
    expect(colName(26)).toBe('AA');
  });

  // Excel 對工作表名稱有硬限制，違反了是整份檔打不開，不是名稱被截掉而已。
  test('工作表名稱會去掉不合法字元並截到 31 字', () => {
    expect(safeSheetName('標籤/清單[2026]')).toBe('標籤清單2026');
    expect(safeSheetName('標'.repeat(40))).toHaveLength(31);
    expect(safeSheetName('')).toBe('工作表1');
  });
});

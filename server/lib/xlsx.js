// 產生 .xlsx。標籤機的 App 只吃 Excel 檔，不吃 CSV。
//
// 為什麼不裝 exceljs／sheetjs：這裡只要「一張工作表、全部欄位都是文字」，
// 用得到的規格不到全套的百分之一，而多一個相依就多一次「使用者端要重跑安裝」
// （lib/csv.js 已經立過同樣的規矩）。
//
// .xlsx 就是一個 zip，裡面幾支固定的 XML。這裡刻意照 Excel 自己的寫法產：
// 字串走 sharedStrings（不是 inline string）、每個 cell 都帶 r="A1" 座標——
// 對方的解析器是哪一套我們不知道，只能盡量長得跟 Excel 產的一樣。

/** 全部值一律當文字。編號 B-000001 這種被對方當成數字或日期就毀了。 */
const CELL_TYPE_SHARED_STRING = 's';
// Excel 內建格式 49 = Text。除了 t="s"，也明確設定顯示格式，
// 讓開檔後欄位的「數字格式」不是 General，長數字不會變科學記號。
const TEXT_STYLE_INDEX = 1;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * zip 檔案項目。一律用 stored（不壓縮）：檔案本來就只有幾十 KB，
 * 而少一層 deflate 就少一種「對方的解壓縮實作有沒有支援」的變數。
 */
function zipEntry(name, data, offset) {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);        // local file header 標記
  local.writeUInt16LE(20, 4);                // 解壓縮需要的版本 2.0
  local.writeUInt16LE(0, 6);                 // 旗標
  local.writeUInt16LE(0, 8);                 // 壓縮方式 0 = stored
  local.writeUInt16LE(0, 10);                // 修改時間
  local.writeUInt16LE(0x0021, 12);           // 修改日期，固定 1980-01-01：
                                             // 內容一樣就產出一樣的位元組，測試才驗得住
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);      // 壓縮後大小
  local.writeUInt32LE(data.length, 22);      // 原始大小
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);                // extra 欄位長度

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);      // central directory 標記
  central.writeUInt16LE(20, 4);              // 產生者版本
  central.writeUInt16LE(20, 6);              // 解壓縮需要的版本
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x0021, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);              // extra
  central.writeUInt16LE(0, 32);              // 註解
  central.writeUInt16LE(0, 34);              // 磁碟編號
  central.writeUInt16LE(0, 36);              // 內部屬性
  central.writeUInt32LE(0, 38);              // 外部屬性
  central.writeUInt32LE(offset, 42);         // 這一項的 local header 位置

  return {
    local: Buffer.concat([local, nameBuf, data]),
    central: Buffer.concat([central, nameBuf]),
  };
}

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const entry = zipEntry(f.name, f.data, offset);
    locals.push(entry.local);
    centrals.push(entry.central);
    offset += entry.local.length;
  }
  const centralBuf = Buffer.concat(centrals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);          // end of central directory 標記
  end.writeUInt16LE(0, 4);                   // 本磁碟編號
  end.writeUInt16LE(0, 6);                   // central directory 所在磁碟
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                  // 註解長度

  return Buffer.concat([...locals, centralBuf, end]);
}

function xmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // XML 1.0 不允許的控制字元。留著的話對方開檔會直接說「檔案毀損」，
    // 而書名備註是使用者貼進來的，什麼都可能有。
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/** 欄索引轉 Excel 欄名：0→A、25→Z、26→AA。 */
function colName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/** 工作表名稱：Excel 限 31 字，且這幾個字元不能用。 */
function safeSheetName(name) {
  const cleaned = String(name ?? '').replace(/[[\]:*?/\\]/g, '').trim();
  return cleaned.slice(0, 31) || '工作表1';
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const DOC_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

/**
 * 產生單一工作表的 .xlsx，回傳 Buffer。
 * headers 是第一列的欄位名稱，rows 是二維陣列，全部當文字寫入。
 */
function toXlsx(headers, rows, sheetName = '工作表1') {
  const table = [headers, ...rows];

  // sharedStrings：同一個字串只存一份，cell 裡放它的索引。
  const strings = [];
  const indexOf = new Map();
  const idFor = (value) => {
    const s = value === null || value === undefined ? '' : String(value);
    if (!indexOf.has(s)) { indexOf.set(s, strings.length); strings.push(s); }
    return indexOf.get(s);
  };

  const sheetRows = table.map((row, r) => {
    const cells = row.map((value, c) =>
      `<c r="${colName(c)}${r + 1}" s="${TEXT_STYLE_INDEX}" t="${CELL_TYPE_SHARED_STRING}"><v>${idFor(value)}</v></c>`
    ).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  const lastCol = colName(Math.max(1, headers.length) - 1);
  const sheet = `${XML_HEAD}<worksheet xmlns="${NS_MAIN}">`
    + `<dimension ref="A1:${lastCol}${table.length}"/>`
    + `<sheetData>${sheetRows}</sheetData></worksheet>`;

  // xml:space="preserve"：欄位值前後的空白不可以被吃掉，否則編號會對不上。
  const sharedStrings = `${XML_HEAD}<sst xmlns="${NS_MAIN}" `
    + `count="${table.reduce((n, r) => n + r.length, 0)}" uniqueCount="${strings.length}">`
    + strings.map((s) => `<si><t xml:space="preserve">${xmlText(s)}</t></si>`).join('')
    + '</sst>';

  const workbook = `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + `<sheets><sheet name="${xmlText(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>`
    + '</workbook>';

  const workbookRels = `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">`
    + `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>`
    + `<Relationship Id="rId2" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/>`
    + `<Relationship Id="rId3" Type="${NS_REL}/styles" Target="styles.xml"/>`
    + '</Relationships>';

  // 第一個 xf 是預設格式；第二個指定 Excel 的內建「文字」格式（numFmtId 49）。
  const styles = `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">`
    + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
    + '<borders count="1"><border/></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
    + '</styleSheet>';

  const rootRels = `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">`
    + `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>`
    + '</Relationships>';

  const contentTypes = `${XML_HEAD}<Types xmlns="${NS_TYPES}">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + `<Override PartName="/xl/workbook.xml" ContentType="${DOC_TYPE}.sheet.main+xml"/>`
    + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${DOC_TYPE}.worksheet+xml"/>`
    + `<Override PartName="/xl/sharedStrings.xml" ContentType="${DOC_TYPE}.sharedStrings+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="${DOC_TYPE}.styles+xml"/>`
    + '</Types>';

  // [Content_Types].xml 必須是 zip 的第一項，這是 OPC 規格要求的。
  return zip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedStrings, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(styles, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') },
  ]);
}

module.exports = { toXlsx, crc32, colName, safeSheetName };

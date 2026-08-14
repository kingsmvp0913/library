// NIIMBOT B21 標籤機（藍牙）。只支援這一台機型、只做一件事：送一張單色點陣圖去印。
//
// 協定是社群逆向出來的（https://printers.niim.blue），不是官方文件——韌體改版就可能失效。
// 失效時的表現通常是「機器沒反應」而不是報錯，所以每一個控制指令都要等機器回應，
// 不能單向送完就當作成功。
//
// 為什麼不引用現成的 niimbluelib：那包目前還是 0.0.1-alpha，且相依 capacitor／serialport。
// 本專案前端沒有打包器，引入它等於為了一台印表機生出一整條建置流程。

const NIIMBOT_SERVICE = 'e7810a71-73ae-499d-8c15-faa9aef0c3f2';

// B21 的機器參數。印字頭 384 點 ÷ 203dpi = 48mm，這是實際印得出來的最大寬度，
// 就算貼紙是 50mm 寬也一樣，超出的部分不會印。
const B21 = { dpi: 203, printheadDots: 384, densityDefault: 3 };

const CMD = {
  Connect: 0xc1,
  SetDensity: 0x21,
  SetLabelType: 0x23,
  PrintStart: 0x01,
  PageStart: 0x03,
  SetPageSize: 0x13,
  PrintBitmapRowIndexed: 0x83,
  PrintEmptyRow: 0x84,
  PrintBitmapRow: 0x85,
  PrinterCheckLine: 0x86,
  PageEnd: 0xe3,
  PrintStatus: 0xa3,
  PrintEnd: 0xf3,
};

// 每個指令對應的回應 command id。列印過程中機器會自己送進度通知，
// 收到對不上的封包要略過，不能當成自己這一支的回應。
const RESPONSE_OF = {
  [CMD.Connect]: 0xc2,
  [CMD.SetDensity]: 0x31,
  [CMD.SetLabelType]: 0x33,
  [CMD.PrintStart]: 0x02,
  [CMD.PageStart]: 0x04,
  [CMD.SetPageSize]: 0x14,
  [CMD.PrinterCheckLine]: 0xd3,
  [CMD.PageEnd]: 0xe4,
  [CMD.PrintStatus]: 0xb3,
  [CMD.PrintEnd]: 0xf4,
};

/** 標籤紙材質。1 = 一般有間隙的貼紙，就是 B21 出廠附的那種。 */
const LABEL_TYPE_WITH_GAPS = 1;

/**
 * 啟動指令的四種組合。⚠️ 這是暫時的診斷用表，確認之後只留對的那一組。
 *
 * 實機（B21S）目前的表現是：紙照走、每個指令都正常回應、機器自稱 100%，紙上全白，
 * 而 PrintStatus 回報的已印頁數是 0——「機器根本沒被告知要印幾份」完全符合這個樣子。
 * 份數可能要帶在 PrintStart，也可能要帶在 SetPageSize，手上沒有 B21S 的實機抓包，
 * 所以不猜：由測試列印一次印四張，讓紙自己指出哪一組會出墨。
 */
const START_VARIANTS = [
  { name: '現行寫法（都不帶份數）', startQty: false, sizeQty: false },
  { name: 'PrintStart 帶份數', startQty: true, sizeQty: false },
  { name: 'SetPageSize 帶份數', startQty: false, sizeQty: true },
  { name: '兩支都帶份數', startQty: true, sizeQty: true },
];

/**
 * 收尾前至少等這麼久。判定不出「印完了沒」之前，這是唯一能保證不把工作提早中止的做法——
 * 0xf3 太早送就是「紙有走、紙上全白」的成因，寧可每張多花兩秒半。
 */
const MIN_PRINT_MS = 2500;

/** 封包：55 55 [cmd] [len] [data...] [checksum] AA AA，checksum 是 cmd 起算到 data 結束的 XOR。 */
function buildPacket(cmd, data) {
  const body = [cmd, data.length, ...data];
  let checksum = 0;
  for (const b of body) checksum ^= b;
  const packet = new Uint8Array([0x55, 0x55, ...body, checksum, 0xaa, 0xaa]);
  // 只有 Connect 這一支前面要多一個 0x03，其他指令都不加。
  return cmd === CMD.Connect ? new Uint8Array([0x03, ...packet]) : packet;
}

/**
 * 從收到的位元組裡切出完整封包。藍牙通知會切斷也會黏包，
 * 所以剩下的半截要留著跟下一批拼。
 */
function parsePackets(buf) {
  const packets = [];
  let pos = 0;
  while (pos + 7 <= buf.length) {
    if (buf[pos] !== 0x55 || buf[pos + 1] !== 0x55) { pos++; continue; }   // 對不到開頭就往後找
    const len = buf[pos + 3];
    const end = pos + 7 + len;
    if (end > buf.length) break;                                          // 還沒收完，等下一批
    packets.push({ cmd: buf[pos + 2], data: buf.slice(pos + 4, pos + 4 + len) });
    pos = end;
  }
  return { packets, rest: buf.slice(pos) };
}

function u16(n) { return [(n >> 8) & 0xff, n & 0xff]; }

/**
 * 把點陣圖壓成一列一列的指令素材。
 *
 * bitmap：{ cols, rows, isBlack(x, y) }。cols 必須是 8 的倍數（一個 byte 存 8 個點）。
 *
 * 這裡做兩件事，都是機器要求的，不是最佳化：
 * 連續相同的列合併成 repeat（貼紙上大片留白與條碼本體都是整片相同的列），
 * 以及每 200 列插一個檢查點——B21 少了檢查點會印到一半停住。
 */
function encodeBitmap(bitmap) {
  const { cols, rows } = bitmap;
  if (cols % 8 !== 0) throw new Error('點陣圖寬度必須是 8 的倍數');

  const parts = [];
  for (let y = 0; y < rows; y++) {
    const rowData = new Uint8Array(cols / 8);
    let blackPixels = 0;
    for (let x = 0; x < cols; x++) {
      if (bitmap.isBlack(x, y)) {
        rowData[x >> 3] |= 1 << (7 - (x % 8));                            // 最高位是最左邊那一點
        blackPixels++;
      }
    }

    const prev = parts[parts.length - 1];
    const sameAsPrev = prev && prev.type !== 'check'
      && rowData.every((b, i) => b === prev.rowData[i]);

    // repeat 只有 1 個 byte。不必另外設上限——底下的檢查點每 200 列就會切斷一次。
    if (sameAsPrev) prev.repeat++;
    else parts.push({ type: blackPixels === 0 ? 'void' : 'pixels', row: y, repeat: 1, rowData, blackPixels });

    if (y % 200 === 199) parts.push({ type: 'check', row: y });
  }
  return { cols, rows, parts };
}

/** 黑點很少的列改送座標而不是整列點陣——機器對這種列有自己的處理，照著逆向結果走。 */
function indexBlackPixels(rowData) {
  const out = [];
  rowData.forEach((byte, i) => {
    for (let bit = 0; bit < 8; bit++) {
      if (byte & (1 << (7 - bit))) out.push(...u16(i * 8 + bit));
    }
  });
  return out;
}

/** 黑點總數用 3 個 byte 帶，順序是 00 低位 高位（照實機逆向的結果，不是筆誤）。 */
function pixelCountBytes(total) {
  return [0, total & 0xff, (total >> 8) & 0xff];
}

/** 把 encodeBitmap 的結果轉成一連串要送出去的封包。 */
function bitmapPackets(image) {
  return image.parts.map((p) => {
    if (p.type === 'check') return buildPacket(CMD.PrinterCheckLine, [...u16(p.row), 0x01]);
    if (p.type === 'void') return buildPacket(CMD.PrintEmptyRow, [...u16(p.row), p.repeat]);
    if (p.blackPixels <= 6) {
      return buildPacket(CMD.PrintBitmapRowIndexed,
        [...u16(p.row), ...pixelCountBytes(p.blackPixels), p.repeat, ...indexBlackPixels(p.rowData)]);
    }
    return buildPacket(CMD.PrintBitmapRow,
      [...u16(p.row), ...pixelCountBytes(p.blackPixels), p.repeat, ...p.rowData]);
  });
}

/** mm 換算成印字頭的點。條碼的條寬必須落在整數點上，換算完不要再讓瀏覽器縮放。 */
function mmToDots(mm) {
  return Math.round((mm / 25.4) * B21.dpi);
}

// ── 以下是瀏覽器才會跑到的部分（藍牙連線）。node 測試只用上面的純函式。 ──

/**
 * 診斷紀錄。印出來是空白時整段流程一步都不會噴錯——機器收下每一個指令、回應也正常，
 * 只是紙上什麼都沒有。要判斷是哪一層出問題，唯一的線索是實際送出／收到的位元組，
 * 而機器不在維護者手邊、使用者也不會開 DevTools，所以留在記憶體裡讓他一鍵複製回報。
 */
const diag = { lines: [], t0: 0 };

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function note(text) {
  // 一張標籤大約 60 行。超過就停，免得連印幾十張之後吃掉整個分頁的記憶體。
  if (diag.lines.length === 400) diag.lines.push('（紀錄過長，以下省略）');
  if (diag.lines.length >= 400) return;
  diag.lines.push(`+${String(Date.now() - diag.t0).padStart(6)}ms  ${text}`);
}

/**
 * 點陣圖摘要。這三個數字各自排掉一種可能：
 * 黑點是 0 就是圖根本沒畫進 canvas；封包種類看得出走的是整列點陣還是座標；
 * 最大封包大小則是判斷「有沒有大過藍牙單次寫入上限」的依據。
 */
function noteBitmap(image, packets) {
  const black = image.parts.reduce((n, p) => n + (p.blackPixels ?? 0) * (p.repeat ?? 0), 0);
  const byCmd = {};
  let maxLen = 0;
  for (const p of packets) {
    byCmd[p[2]] = (byCmd[p[2]] ?? 0) + 1;
    if (p.length > maxLen) maxLen = p.length;
  }
  const kinds = Object.entries(byCmd)
    .map(([cmd, n]) => `0x${Number(cmd).toString(16)}×${n}`).join('、');
  note(`點陣圖 ${image.cols}×${image.rows} 點，黑點 ${black} 個`);
  note(`點陣封包 ${packets.length} 個（${kinds}），最大 ${maxLen} bytes`);
}

const conn = { device: null, channel: null, buf: new Uint8Array(), waiting: null };

function handleNotification(event) {
  const chunk = new Uint8Array(event.target.value.buffer);
  const merged = new Uint8Array(conn.buf.length + chunk.length);
  merged.set(conn.buf);
  merged.set(chunk, conn.buf.length);

  const { packets, rest } = parsePackets(merged);
  conn.buf = rest;
  for (const p of packets) {
    // 對不上自己這一支的封包也要記——機器主動送的進度通知同樣是線索。
    note(`收 0x${p.cmd.toString(16).padStart(2, '0')} ${hex(p.data)}`);
    if (conn.waiting && p.cmd === conn.waiting.respId) conn.waiting.resolve(p);
  }
}

async function writePacket(packet) {
  if (!conn.channel) throw new Error('標籤機連線已中斷');
  note(`送 ${String(packet.length).padStart(3)}B ${hex(packet)}`);
  try {
    await conn.channel.writeValueWithoutResponse(packet.buffer);
  } catch (err) {
    // 封包大過藍牙單次寫入上限就是在這裡爆——整列點陣（0x85）最大，控制指令都很短。
    note(`送不出去：${err.name} ${err.message}`);
    throw err;
  }
  await new Promise((r) => setTimeout(r, 10));      // 送太快機器會漏封包
}

/** 送一個控制指令並等回應。等不到就是機器沒反應，必須當成失敗，不能繼續往下送。 */
async function command(cmd, data = [1], timeoutMs = 2000) {
  const respId = RESPONSE_OF[cmd];
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.waiting = null;
      note(`等不到 0x${cmd.toString(16)} 的回應（等了 ${timeoutMs}ms）`);
      reject(new Error(`標籤機沒有回應（指令 0x${cmd.toString(16)}）`));
    }, timeoutMs);
    conn.waiting = { respId, resolve: (p) => { clearTimeout(timer); conn.waiting = null; resolve(p); } };
  });
  await writePacket(buildPacket(cmd, data));
  return answer;
}

async function findChannel(gatt) {
  for (const service of await gatt.getPrimaryServices()) {
    for (const c of await service.getCharacteristics()) {
      if (c.properties.notify && c.properties.writeWithoutResponse) return c;
    }
  }
  return null;
}

const NiimbotB21 = {
  DPI: B21.dpi,
  PRINTHEAD_DOTS: B21.printheadDots,
  START_VARIANTS,
  mmToDots,

  /** Chrome／Edge 才有 Web Bluetooth，而且必須是 localhost 或 https。 */
  isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  },

  isConnected() {
    return !!conn.channel && !!conn.device?.gatt?.connected;
  },

  /**
   * 連線。第一次會跳出瀏覽器的藍牙裝置選擇視窗，之後同一個分頁內都不會再跳——
   * 所以連上後要把 device 留著，不能每印一張就重新選一次。
   */
  async connect() {
    if (this.isConnected()) { note('沿用已經連上的標籤機'); return; }
    if (!this.isSupported()) throw new Error('這個瀏覽器不支援藍牙列印，請改用 Chrome 或 Edge');

    if (!conn.device) {
      conn.device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'B21' }, { services: [NIIMBOT_SERVICE] }],
        optionalServices: [NIIMBOT_SERVICE],
      });
      conn.device.addEventListener('gattserverdisconnected', () => { conn.channel = null; });
    }

    const gatt = await conn.device.gatt.connect();
    const channel = await findChannel(gatt);
    if (!channel) {
      gatt.disconnect();
      throw new Error('找不到標籤機的傳輸通道，請關掉標籤機再開一次');
    }
    channel.addEventListener('characteristicvaluechanged', handleNotification);
    await channel.startNotifications();
    conn.channel = channel;
    conn.buf = new Uint8Array();
    note(`已連上「${conn.device.name ?? '未命名裝置'}」，傳輸通道 ${channel.uuid}`);
    await command(CMD.Connect);
  },

  disconnect() {
    conn.device?.gatt?.disconnect();
    conn.channel = null;
    conn.buf = new Uint8Array();
  },

  /**
   * 印一張。canvas 的寬就是印字頭方向的點數（要 8 的倍數且不超過 384），高是走紙長度。
   *
   * 白色以外的顏色一律當黑點，所以 canvas 一定要先填白底——
   * 剛建好的 canvas 是透明的，透明會被當成全黑，整張變成一片黑。
   */
  async printCanvas(canvas, { density = B21.densityDefault, variant = 0 } = {}) {
    if (canvas.width > B21.printheadDots) {
      throw new Error(`標籤太寬（${canvas.width} 點），B21 最多只能印 ${B21.printheadDots} 點（約 48mm）`);
    }
    const start = START_VARIANTS[variant] ?? START_VARIANTS[0];
    // 每張標籤重來一次。診斷要的是「這一張為什麼不對」，接在一起反而找不到。
    diag.t0 = Date.now();
    diag.lines = [
      'NIIMBOT B21 診斷紀錄（只保留最後送出的那一張標籤）',
      `時間：${new Date().toLocaleString('zh-TW')}`,
      `瀏覽器：${navigator.userAgent}`,
      `標籤：${canvas.width} × ${canvas.height} 點，濃度 ${density}`,
      `啟動指令組合：${start.name}`,
    ];
    await this.connect();

    const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const image = encodeBitmap({
      cols: canvas.width,
      rows: canvas.height,
      isBlack: (x, y) => {
        const i = (y * canvas.width + x) * 4;
        return px[i] !== 255 || px[i + 1] !== 255 || px[i + 2] !== 255;
      },
    });

    const rowPackets = bitmapPackets(image);
    noteBitmap(image, rowPackets);

    await command(CMD.SetDensity, [density]);
    await command(CMD.SetLabelType, [LABEL_TYPE_WITH_GAPS]);
    await command(CMD.PrintStart, start.startQty ? [...u16(1), 0, 0, 0] : [1]);

    await command(CMD.PageStart);
    await command(CMD.SetPageSize, start.sizeQty
      ? [...u16(image.rows), ...u16(image.cols), ...u16(1)]
      : [...u16(image.rows), ...u16(image.cols)]);
    for (const packet of rowPackets) await writePacket(packet);             // 點陣列不會有回應
    const pageEndAt = Date.now();
    await command(CMD.PageEnd, [1], 10000);

    // 問一次 PrintStatus 只是為了把機器的回應留進紀錄，不拿來當收尾依據：
    // 實機在 PageEnd 之後 61ms 就回報 100%，那個數字顯然不是「印完了」。
    try {
      await command(CMD.PrintStatus, [1], 5000);
    } catch {
      note('機器不回應 PrintStatus');
    }

    // 收尾一律等滿 MIN_PRINT_MS。0xf3 是「結束列印」不是「印好了沒」，
    // 太早送就會在機器還沒印之前把工作中止掉——紙照走、每個指令都正常回應、
    // 程式判定成功，紙上卻整張全白。判定不出進度之前，只能靠時間保證紙走得完。
    const dwell = MIN_PRINT_MS - (Date.now() - pageEndAt);
    if (dwell > 0) await new Promise((r) => setTimeout(r, dwell));

    await command(CMD.PrintEnd, [1], 5000);
    note('這一張收尾完成');
  },

  /** 給「複製診斷紀錄」那顆按鈕用。沒印過任何東西時回空字串。 */
  diagnosticLog() {
    return diag.lines.join('\n');
  },
};

// 讓封包編碼能被 node 測試檢查（瀏覽器照常用全域物件）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildPacket, parsePackets, encodeBitmap, bitmapPackets, pixelCountBytes, indexBlackPixels, mmToDots, CMD };
}

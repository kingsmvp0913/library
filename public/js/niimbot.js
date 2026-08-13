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
  [CMD.PrintEnd]: 0xf4,
};

/** 標籤紙材質。1 = 一般有間隙的貼紙，就是 B21 出廠附的那種。 */
const LABEL_TYPE_WITH_GAPS = 1;

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

const conn = { device: null, channel: null, buf: new Uint8Array(), waiting: null };

function handleNotification(event) {
  const chunk = new Uint8Array(event.target.value.buffer);
  const merged = new Uint8Array(conn.buf.length + chunk.length);
  merged.set(conn.buf);
  merged.set(chunk, conn.buf.length);

  const { packets, rest } = parsePackets(merged);
  conn.buf = rest;
  for (const p of packets) {
    if (conn.waiting && p.cmd === conn.waiting.respId) conn.waiting.resolve(p);
  }
}

async function writePacket(packet) {
  if (!conn.channel) throw new Error('標籤機連線已中斷');
  await conn.channel.writeValueWithoutResponse(packet.buffer);
  await new Promise((r) => setTimeout(r, 10));      // 送太快機器會漏封包
}

/** 送一個控制指令並等回應。等不到就是機器沒反應，必須當成失敗，不能繼續往下送。 */
async function command(cmd, data = [1], timeoutMs = 2000) {
  const respId = RESPONSE_OF[cmd];
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.waiting = null;
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
    if (this.isConnected()) return;
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
  async printCanvas(canvas, { density = B21.densityDefault } = {}) {
    if (canvas.width > B21.printheadDots) {
      throw new Error(`標籤太寬（${canvas.width} 點），B21 最多只能印 ${B21.printheadDots} 點（約 48mm）`);
    }
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

    await command(CMD.SetDensity, [density]);
    await command(CMD.SetLabelType, [LABEL_TYPE_WITH_GAPS]);
    await command(CMD.PrintStart);

    await command(CMD.PageStart);
    await command(CMD.SetPageSize, [...u16(image.rows), ...u16(image.cols)]);
    for (const packet of bitmapPackets(image)) await writePacket(packet);   // 點陣列不會有回應
    await command(CMD.PageEnd, [1], 10000);

    // 印完才會回 1。這支同時是「結束列印」與「問印好了沒」，要一直問到它說好。
    for (let i = 0; i < 60; i++) {
      const res = await command(CMD.PrintEnd, [1], 5000);
      if (res.data[0] === 1) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('標籤機遲遲沒有印完，請檢查是否卡紙或缺紙');
  },
};

// 讓封包編碼能被 node 測試檢查（瀏覽器照常用全域物件）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildPacket, parsePackets, encodeBitmap, bitmapPackets, pixelCountBytes, indexBlackPixels, mmToDots, CMD };
}

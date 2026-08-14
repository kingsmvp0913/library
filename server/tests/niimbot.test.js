const {
  buildPacket, parsePackets, encodeBitmap, bitmapPackets, pixelCountBytes, mmToDots, CMD,
} = require('../../public/js/niimbot.js');

const hex = (bytes) => Buffer.from(bytes).toString('hex');

/**
 * 這支測試驗的是「送出去的位元組對不對」，不是「印得出來」——後者只有接上真機才知道。
 *
 * 底下兩組期望值是協定文件（https://printers.niim.blue）裡實際抓包記錄下來的封包，
 * 不是照著本專案的程式反推的。位元組錯了機器只會沒反應，不會報錯，
 * 所以有實機封包可以對照的地方一定要對照。
 */
describe('NIIMBOT 封包編碼', () => {
  test('對得上文件記錄的 RfidInfo 封包', () => {
    expect(hex(buildPacket(0x1a, [0x01]))).toBe('55551a01011aaaaa');
  });

  test('checksum 是 command 與 data 的 XOR', () => {
    const packet = buildPacket(0x4a, [0x04]);
    expect(packet[packet.length - 3]).toBe(0x4a ^ 0x01 ^ 0x04);
  });

  // 少了這個 byte 機器不會回應，而畫面上看不出任何異狀。
  test('只有 Connect 前面多一個 0x03', () => {
    expect(buildPacket(CMD.Connect, [1])[0]).toBe(0x03);
    expect(buildPacket(CMD.PageStart, [1])[0]).toBe(0x55);
  });
});

describe('回應封包解析', () => {
  test('一次收到兩個封包要切成兩個', () => {
    const buf = Buffer.from('55554a01044faaaa5555f60101f6aaaa', 'hex');
    const { packets, rest } = parsePackets(new Uint8Array(buf));
    expect(packets.map((p) => p.cmd)).toEqual([0x4a, 0xf6]);
    expect(rest.length).toBe(0);
  });

  // 藍牙通知會把封包切斷。切到一半的要留著跟下一批拼，不能丟掉也不能當成完整封包。
  test('收到半截封包時留著等下一批', () => {
    const whole = Buffer.from('55554a01044faaaa', 'hex');
    const first = parsePackets(new Uint8Array(whole.subarray(0, 5)));
    expect(first.packets).toHaveLength(0);
    expect(first.rest.length).toBe(5);

    const merged = new Uint8Array([...first.rest, ...whole.subarray(5)]);
    expect(parsePackets(merged).packets.map((p) => p.cmd)).toEqual([0x4a]);
  });
});

describe('點陣圖編碼', () => {
  const solidRow = (cols, rows) => ({ cols, rows, isBlack: () => true });

  test('寬度不是 8 的倍數要擋下來（一個 byte 存 8 個點）', () => {
    expect(() => encodeBitmap({ cols: 300, rows: 10, isBlack: () => false }))
      .toThrow(/8 的倍數/);
  });

  // 一張貼紙上大片留白與條碼本體都是整片相同的列，不合併會送出幾百個封包。
  test('連續相同的列合併成一個封包', () => {
    const image = encodeBitmap(solidRow(48, 30));
    expect(image.parts).toHaveLength(1);
    expect(image.parts[0].repeat).toBe(30);
  });

  // repeat 只有 1 個 byte，溢位會靜默印出長度不對的空白。
  // 目前是靠檢查點每 200 列切斷一次來保證不會溢位，所以檢查點不能拿掉。
  test('再長的空白也不會讓 repeat 溢出 1 個 byte', () => {
    const image = encodeBitmap({ cols: 48, rows: 1000, isBlack: () => false });
    for (const part of image.parts) expect(part.repeat ?? 0).toBeLessThanOrEqual(255);
  });

  // B21 少了檢查點會印到一半停住。
  test('每 200 列插一個檢查點', () => {
    const image = encodeBitmap({ cols: 48, rows: 401, isBlack: () => false });
    expect(image.parts.filter((p) => p.type === 'check').map((p) => p.row)).toEqual([199, 399]);
  });

  test('全白的列走空白列指令，不送整列點陣', () => {
    const packets = bitmapPackets(encodeBitmap({ cols: 48, rows: 4, isBlack: () => false }));
    expect(packets).toHaveLength(1);
    expect(packets[0][2]).toBe(CMD.PrintEmptyRow);
  });

  test('黑點多的列送整列點陣', () => {
    const packets = bitmapPackets(encodeBitmap(solidRow(48, 1)));
    expect(packets[0][2]).toBe(CMD.PrintBitmapRow);
    expect(hex(packets[0].slice(10, 16))).toBe('ffffffffffff');   // 48 點全黑 = 6 個 0xff
  });

  /**
   * 文件裡記錄的實機封包：第 126 列、第 39~42 點是黑的。
   * 一個 byte 錯位就會整條印歪，而這是唯一能在沒有機器的情況下驗到位元組的方法。
   */
  test('黑點很少的列對得上文件記錄的座標封包', () => {
    const image = encodeBitmap({
      cols: 48,
      rows: 127,
      isBlack: (x, y) => y === 126 && x >= 39 && x <= 42,
    });
    const packets = bitmapPackets(image);
    expect(hex(packets[packets.length - 1]))
      .toBe('5555830e007e00040001002700280029002afaaaaa');
  });

  test('黑點數量用 3 個 byte 帶，順序是 00 低位 高位', () => {
    expect(pixelCountBytes(4)).toEqual([0, 4, 0]);
    expect(pixelCountBytes(300)).toEqual([0, 0x2c, 0x01]);
  });
});

describe('mm 換算成印字頭的點', () => {
  // 203dpi。條寬落在小數上會被四捨五入成一寬一窄，掃碼槍就讀不出來。
  test('50mm 換算後超過印字頭的 384 點——所以 50mm 貼紙也只印得到 48mm', () => {
    expect(mmToDots(50)).toBe(400);
    expect(mmToDots(48)).toBe(384);
    expect(mmToDots(30)).toBe(240);
  });
});

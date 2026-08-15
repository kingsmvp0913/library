const { CODE39, code39DotWidth } = require('../../public/js/barcode.js');

// 條碼編碼表打錯時，畫面上看起來完全正常，只有拿掃碼槍掃才會發現。
// 這幾條驗的是 Code39 規格本身的不變量，能攔下大部分手誤。
describe('Code39 編碼表', () => {
  test('本專案編號用到的字元全部有定義', () => {
    for (const ch of 'BT-0123456789') {
      expect(CODE39[ch]).toBeDefined();
    }
    expect(CODE39['*']).toBeDefined();          // 起訖符
  });

  test('每個字元都是 9 個元素', () => {
    for (const [ch, pattern] of Object.entries(CODE39)) {
      expect(`${ch}:${pattern.length}`).toBe(`${ch}:9`);
    }
  });

  // Code39 的核心不變量：9 個元素中恰好 3 個是寬的。
  test('每個字元恰好 3 個寬元素', () => {
    for (const [ch, pattern] of Object.entries(CODE39)) {
      const wide = [...pattern].filter((c) => c === 'w').length;
      expect(`${ch}:${wide}`).toBe(`${ch}:3`);
    }
  });

  test('只由 n 與 w 組成', () => {
    for (const [ch, pattern] of Object.entries(CODE39)) {
      expect(`${ch}:${/^[nw]+$/.test(pattern)}`).toBe(`${ch}:true`);
    }
  });

  // 兩個字元共用同一個 pattern，代表表打錯了——掃出來會是錯的字。
  test('沒有兩個字元共用同一個 pattern', () => {
    const seen = new Map();
    for (const [ch, pattern] of Object.entries(CODE39)) {
      expect(seen.has(pattern) ? `${seen.get(pattern)}與${ch}重複` : 'ok').toBe('ok');
      seen.set(pattern, ch);
    }
  });

  test('涵蓋 Code39 完整字集共 44 個字元', () => {
    expect(Object.keys(CODE39).length).toBe(44);
  });
});

// 條碼太寬會被截掉，而截掉的條碼看起來仍然像條碼，只有拿掃碼槍掃才會發現。
// 真正的限制不是印字頭的 384 點，是貼紙的 320 點（40mm）——印字頭比貼紙寬。
describe('條碼在標籤機上的寬度', () => {
  const LABEL_DOTS = 320;                 // 40mm 貼紙
  const QUIET_ZONE = 10 * 2;              // Code39 規定的靜區＝10 倍窄條

  test('本專案的編號印得進 40mm 貼紙', () => {
    expect(code39DotWidth('B-000001')).toBe(258);
    expect(code39DotWidth('T-999999')).toBe(258);
  });

  // 掃碼槍靠條碼兩側的空白判斷頭尾，沒有靜區就掃不出來。實機量到紙在機器裡左右
  // 會晃約 2mm（16 點），所以名目靜區必須比規定值再寬出這段餘裕。
  test('條碼兩側留得下靜區，而且還吃得起紙左右晃 2mm', () => {
    const margin = (LABEL_DOTS - code39DotWidth('B-000001')) / 2;
    expect(margin).toBeGreaterThanOrEqual(QUIET_ZONE);
    expect(margin).toBeGreaterThan(QUIET_ZONE + 8);
  });

  test('編號多一位就多 26 點——哪天流水號進位要重新確認印不印得下', () => {
    expect(code39DotWidth('B-0000001') - code39DotWidth('B-000001')).toBe(26);
  });
});

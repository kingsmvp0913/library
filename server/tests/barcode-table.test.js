const { CODE39 } = require('../../public/js/barcode.js');

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

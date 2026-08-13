// Code39：每個字元 9 個元素（5 條 4 空），n=窄 w=寬，其中恰好 3 個是寬的。
// 前後必須加 * 當起訖符。選 Code39 而非 Code128：編碼表小得多，自行實作出錯機會低，
// 且掃碼槍普遍支援；B-000001 的字元全在其字集內。
const CODE39 = {
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
  '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
  'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn',
  'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
  'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn',
  'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn',
  'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn',
  'Z': 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn',
  '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn',
};

const NARROW = 2, WIDE = 5, HEIGHT = 60;

/** 產生 Code39 條碼 SVG。text 會轉大寫；不支援的字元會拋錯。 */
function renderCode39(text) {
  const chars = ('*' + String(text).toUpperCase() + '*').split('');
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  let x = 0;
  for (const ch of chars) {
    const pattern = CODE39[ch];
    if (!pattern) throw new Error(`條碼不支援這個字元：${ch}`);
    for (let i = 0; i < pattern.length; i++) {
      const w = pattern[i] === 'w' ? WIDE : NARROW;
      if (i % 2 === 0) {                       // 偶數位是黑條，奇數位是空白
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', x);
        rect.setAttribute('y', 0);
        rect.setAttribute('width', w);
        rect.setAttribute('height', HEIGHT);
        rect.setAttribute('fill', '#000');
        svg.appendChild(rect);
      }
      x += w;
    }
    x += NARROW;                                // 字元間隔
  }
  svg.setAttribute('width', x);
  svg.setAttribute('height', HEIGHT);
  svg.setAttribute('viewBox', `0 0 ${x} ${HEIGHT}`);
  svg.style.background = '#fff';                // 條碼底色必須是白的，深色模式也一樣
  return svg;
}

// 讓編碼表能被 node 測試檢查（瀏覽器照常用全域函式）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CODE39, renderCode39 };
}

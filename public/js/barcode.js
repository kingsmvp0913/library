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

/** 條碼要幾點寬。熱感標籤機在畫之前就得知道印不印得下。 */
function code39DotWidth(text) {
  const chars = String(text).length + 2;                    // 前後的 * 也要算
  return chars * (6 * NARROW + 3 * WIDE + NARROW) - NARROW; // 最後一個字元後面不留間隔
}

/**
 * 把編號畫成要送去熱感標籤機的單色點陣圖（條碼在上、編號文字在下）。
 *
 * 尺寸單位是印字頭的「點」而不是 mm：熱感印字頭一個點就是一個黑點，
 * 條寬落在小數上會被四捨五入成一寬一窄，掃碼槍就讀不出來。
 * 所以這裡直接用整數點畫，畫完不可以再縮放。NARROW／WIDE 同時是 SVG 單位與點數，
 * 改動它們會同時影響 A4 列印與標籤機。
 */
function renderCode39Label(text, cols, rows) {
  const label = String(text).toUpperCase();
  const barsWidth = code39DotWidth(label);
  if (barsWidth > cols) {
    throw new Error(`編號 ${label} 的條碼需要 ${barsWidth} 點，比標籤可印寬度 ${cols} 點還寬`);
  }
  const textHeight = 28;                                    // 約 3.5mm，老師肉眼讀得到就夠
  const barsHeight = rows - textHeight - 12;
  if (barsHeight < 40) throw new Error(`標籤只有 ${rows} 點高，條碼會矮到掃不出來`);

  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');

  // 一定要先填白：剛建好的 canvas 是透明的，而印表機把「非白」一律當黑點，整張會變全黑。
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cols, rows);

  ctx.fillStyle = '#000';
  let x = Math.floor((cols - barsWidth) / 2);
  for (const ch of ('*' + label + '*').split('')) {
    const pattern = CODE39[ch];
    if (!pattern) throw new Error(`條碼不支援這個字元：${ch}`);
    for (let i = 0; i < pattern.length; i++) {
      const w = pattern[i] === 'w' ? WIDE : NARROW;
      if (i % 2 === 0) ctx.fillRect(x, 4, w, barsHeight);   // 偶數位是黑條
      x += w;
    }
    x += NARROW;
  }

  ctx.font = `bold ${textHeight}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, cols / 2, rows - 4);
  return canvas;
}

// 讓編碼表能被 node 測試檢查（瀏覽器照常用全域函式）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CODE39, renderCode39, code39DotWidth };
}

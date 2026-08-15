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

// 窄條 2 點是 203dpi 印得出來的下限，再細會糊掉，所以只能動寬條。
// 寬窄比從 2.5:1 收到 2:1（Code39 規定的下限，掃碼槍普遍支援），條碼從 288 點縮到
// 258 點——省下的 30 點全部變成兩側的靜區。實機量到紙在機器裡左右會晃約 2mm，
// 靜區只有 2mm 時右側曾經只剩 0.7mm，掃碼槍會找不到條碼的頭尾。
const NARROW = 2, WIDE = 4, HEIGHT = 60;

/**
 * 印字頭的第 0 點沒有對齊貼紙左緣，而是落在貼紙裡面約 1.5mm（12 點）。
 * 所以貼紙最左邊那 12 點印不到，而點陣圖最右邊那 12 點會被擠出紙外。
 *
 * 這不是推論出來的：舊版條碼 288 點置中時，這個模型預測左留白 3.5mm、右留白 0.5mm，
 * 實機量到的是 3.3–4.0mm 與 0.7mm。不補正就是右邊靜區幾乎歸零，掃碼槍找不到頭尾。
 *
 * ⚠️ 這個值屬於「這一台 B21S ＋ 目前導紙夾的位置」。換機器、或有人動過導紙夾，
 * 就要重印一張滿版黑帶的測試標籤重新量，不要沿用。刻意不做成設定欄位——多一個
 * 沒人看得懂的選項，比偶爾改一次程式更糟。
 */
const PAPER_OFFSET = 12;

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
 * 把編號畫成要送去熱感標籤機的單色點陣圖（櫃位在最上、條碼在中、編號文字在下）。
 *
 * 尺寸單位是印字頭的「點」而不是 mm：熱感印字頭一個點就是一個黑點，
 * 條寬落在小數上會被四捨五入成一寬一窄，掃碼槍就讀不出來。
 * 所以這裡直接用整數點畫，畫完不可以再縮放。NARROW／WIDE 同時是 SVG 單位與點數，
 * 改動它們會同時影響 A4 列印與標籤機。
 *
 * shelf 留空就完全不印那一行，把高度讓給條碼——印「尚未指定櫃位」只是浪費貼紙。
 */
function renderCode39Label(text, cols, rows, shelf = '') {
  const label = String(text).toUpperCase();
  const barsWidth = code39DotWidth(label);
  // 內容要對齊「貼紙的中線」，而貼紙中線在點陣圖上是 cols/2 - PAPER_OFFSET。
  // 左邊印不到第 0 點以左，所以能置中又不被截掉的最大寬度是 cols - 2×PAPER_OFFSET。
  const usableCols = cols - 2 * PAPER_OFFSET;
  if (barsWidth > usableCols) {
    throw new Error(`編號 ${label} 的條碼需要 ${barsWidth} 點，比標籤印得到的 ${usableCols} 點還寬`);
  }
  // 櫃位是老師掃完書之後唯一要看的資訊，維持大字；編號只有在條碼掃不出來時才會有人
  // 去念它，所以縮小。
  //
  // 櫃位那一行的高度「一律保留」，沒填櫃位就留白，不要把空間讓給條碼——每張標籤的
  // 條碼一樣高，貼在書背上才看得出是同一套；而且沒指定櫃位只是資料還沒補完，
  // 不是把版面撐大的理由。
  const shelfHeight = 28;                                   // 約 3.5mm
  const numberHeight = 20;                                  // 約 2.5mm
  const barsHeight = rows - numberHeight - shelfHeight - 12;
  if (barsHeight < 40) {
    throw new Error(`標籤只有 ${rows} 點高，條碼會矮到掃不出來。`
      + '請到設定頁把貼紙高度調大一點。');
  }

  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');

  // 一定要先填白：剛建好的 canvas 是透明的，而印表機把「非白」一律當黑點，整張會變全黑。
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cols, rows);

  ctx.fillStyle = '#000';

  // 貼紙的中心不在點陣圖的中心——印字頭的第 0 點落在貼紙裡面，見 PAPER_OFFSET。
  const middle = cols / 2 - PAPER_OFFSET;

  if (shelf) {
    // 第四個參數是最大寬度：櫃位名稱是使用者自己取的，太長時讓它壓扁，不要靜默切掉。
    ctx.font = `bold ${shelfHeight}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(shelf, middle, 4, usableCols - 8);
  }

  const barsTop = 4 + shelfHeight;
  let x = Math.floor(middle - barsWidth / 2);
  for (const ch of ('*' + label + '*').split('')) {
    const pattern = CODE39[ch];
    if (!pattern) throw new Error(`條碼不支援這個字元：${ch}`);
    for (let i = 0; i < pattern.length; i++) {
      const w = pattern[i] === 'w' ? WIDE : NARROW;
      if (i % 2 === 0) ctx.fillRect(x, barsTop, w, barsHeight);   // 偶數位是黑條
      x += w;
    }
    x += NARROW;
  }

  ctx.font = `bold ${numberHeight}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, middle, rows - 4);
  return canvas;
}

// 讓編碼表能被 node 測試檢查（瀏覽器照常用全域函式）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CODE39, renderCode39, code39DotWidth };
}

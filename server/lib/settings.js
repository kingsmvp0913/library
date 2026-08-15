const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// 允許用環境變數覆寫，測試才能指向暫存檔。
// 少了這個，測試會讀到開發機真正的 config.json，「沒有金鑰」這種前提就永遠不成立，
// 而且 jest.resetModules() 之後模組內變數會被重置，只靠 setConfigPath() 蓋不住。
let configPath = process.env.LIBRARY_CONFIG_PATH
  || path.join(ROOT, 'data', 'config.json');

/** 供測試指向暫存檔用，正式流程不會呼叫。 */
function setConfigPath(p) { configPath = p; }
function getConfigPath() { return configPath; }

/**
 * 每次都重新讀檔，不做模組載入時的 snapshot。
 * 使用者在網頁上改完設定必須立刻生效——要求他重開系統，這個功能等於沒做。
 * 檔案只有幾百 bytes，讀取成本可以忽略。
 */
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

/** 只覆寫 patch 指定的鍵，其餘設定原封不動。 */
function updateConfig(patch) {
  const cfg = readConfig();
  Object.assign(cfg, patch);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

function getGoogleKey() {
  return String(readConfig().GOOGLE_BOOKS_API_KEY ?? '').trim();
}

/**
 * 編號標籤要印到哪裡、貼紙多大。
 * 預設 A4——沒有標籤機的人佔多數，而且 A4 不必先接任何硬體就印得出來。
 */
function getLabelSettings() {
  const cfg = readConfig();
  return {
    printer: cfg.LABEL_PRINTER === 'b21' ? 'b21' : 'a4',
    // 40×20 是 B21S 出廠附的那捲。實機驗過：填錯高度不會報錯，機器會進位吃掉兩張
    // 貼紙，內容跨過裁切線，看起來像「印歪了」甚至「整張空白」。
    widthMm: Number(cfg.LABEL_WIDTH_MM) || 40,
    heightMm: Number(cfg.LABEL_HEIGHT_MM) || 20,
  };
}

/** 只露出頭尾，讓使用者認得出是哪一把，但看不到完整值。 */
function maskKey(key) {
  const k = String(key ?? '').trim();
  if (!k) return '';
  if (k.length <= 12) return k.slice(0, 2) + '••••';
  return `${k.slice(0, 6)}••••••${k.slice(-4)}`;
}

module.exports = {
  readConfig, updateConfig, getGoogleKey, getLabelSettings, maskKey, setConfigPath, getConfigPath,
};

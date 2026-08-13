const fs = require('fs');
const os = require('os');
const path = require('path');

// 把設定檔指向一個乾淨的暫存檔，讓測試完全不受這台機器的實際設定影響。
// 沒有這一步，「尚未設定金鑰」之類的測試會讀到開發機真正的 config.json 而失效，
// 而且不同機器跑出來的結果會不一樣。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-test-'));
const file = path.join(dir, 'config.json');
fs.writeFileSync(file, JSON.stringify({ PORT: 3940 }), 'utf8');

process.env.LIBRARY_CONFIG_PATH = file;

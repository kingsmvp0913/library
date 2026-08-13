const express = require('express');
const settings = require('../lib/settings.js');

const router = express.Router();

// B21 貼紙最寬 50mm。高度上限抓 100mm，再長就不是貼在書上的編號標籤了。
const SIZE_LIMITS = { labelWidthMm: [20, 50], labelHeightMm: [10, 100] };

function currentSettings() {
  const key = settings.getGoogleKey();
  const label = settings.getLabelSettings();
  return {
    hasGoogleBooksApiKey: !!key,
    googleBooksApiKeyMasked: settings.maskKey(key),
    labelPrinter: label.printer,
    labelWidthMm: label.widthMm,
    labelHeightMm: label.heightMm,
  };
}

router.get('/settings', (req, res) => {
  res.json(currentSettings());
});

// 只開放金鑰與標籤設定。DATABASE_URL／PORT 改錯會讓系統整個開不起來，
// 那是維護者的事，不該從網頁改。
router.put('/settings', (req, res, next) => {
  try {
    const patch = {};

    if (req.body.googleBooksApiKey !== undefined) {
      patch.GOOGLE_BOOKS_API_KEY = String(req.body.googleBooksApiKey).trim();  // 貼上時很容易多帶空白
    }

    if (req.body.labelPrinter !== undefined) {
      if (!['a4', 'b21'].includes(req.body.labelPrinter)) {
        return res.status(400).json({ error: '標籤輸出方式只能選「A4 貼紙」或「NIIMBOT B21」' });
      }
      patch.LABEL_PRINTER = req.body.labelPrinter;
    }

    for (const [field, [min, max]] of Object.entries(SIZE_LIMITS)) {
      if (req.body[field] === undefined) continue;
      const mm = Number(req.body[field]);
      if (!Number.isFinite(mm) || mm < min || mm > max) {
        const what = field === 'labelWidthMm' ? '寬度' : '高度';
        return res.status(400).json({ error: `標籤${what}請填 ${min} 到 ${max} 之間的數字（單位 mm）` });
      }
      patch[field === 'labelWidthMm' ? 'LABEL_WIDTH_MM' : 'LABEL_HEIGHT_MM'] = mm;
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: '沒有要修改的設定' });
    }
    settings.updateConfig(patch);
    res.json({ ok: true, ...currentSettings() });
  } catch (err) { next(err); }
});

/**
 * 用「使用者剛貼上、還沒儲存」的金鑰實際打一次 Google Books。
 * 三種失敗原因的處理方式完全不同，訊息必須分開講，不能一律說「失敗」。
 */
router.post('/settings/test-key', async (req, res, next) => {
  try {
    const key = String(req.body.googleBooksApiKey ?? '').trim();
    if (!key) return res.status(400).json({ error: '請先填入金鑰再測試' });

    const url = 'https://www.googleapis.com/books/v1/volumes?q=isbn:9780140328721&key='
      + encodeURIComponent(key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const r = await fetch(url, { signal: controller.signal });
      if (r.status === 403 || r.status === 400) {
        return res.json({
          ok: false,
          message: '金鑰無效，或這個專案還沒啟用 Books API。請回 Google Cloud Console 確認這兩件事。',
        });
      }
      if (r.status === 429) {
        return res.json({
          ok: false,
          message: '今天的查詢次數已用完（配額上限）。金鑰本身沒問題，明天會自動恢復。',
        });
      }
      if (!r.ok) {
        return res.json({ ok: false, message: `Google 回應 ${r.status}，請稍後再試。` });
      }
      const data = await r.json();
      return res.json({
        ok: true,
        message: data.totalItems
          ? '金鑰可以正常使用。'
          : '金鑰可以連線，但測試書目沒有回傳資料，仍可正常使用。',
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // 連不上時不能講成金鑰錯——使用者會跑去重辦一把新的，白費工。
    if (err.name === 'AbortError' || /fetch|ENOTFOUND|ECONNREFUSED|network/i.test(err.message)) {
      return res.json({
        ok: false,
        message: '連不到 Google，請確認這台電腦目前有網路。（金鑰是否正確無法在離線時判斷）',
      });
    }
    next(err);
  }
});

module.exports = router;

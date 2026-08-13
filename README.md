# 幼稚園圖書／教具管理系統

單機使用，管圖書與教具：掃 ISBN 建檔、掃編號借還、還書時提示放回哪一格。

## 給使用者

- **第一次使用**：雙擊 **`安裝.bat`**
- **之後每次**：雙擊 **`啟動.bat`**（會自動更新到最新版）
- **關閉**：關掉黑色視窗

不需要懂 Node、PostgreSQL、git 或命令列。

## 給維護者

- **首次部署必須用 `git clone`**（不能解壓 zip），否則 `啟動.bat` 的自動更新不會生效。
- 設定都在 `data/config.json`：`DATABASE_URL`、`PORT`、`GOOGLE_BOOKS_API_KEY`。這個檔不進版控。
- 加了新的 npm 套件之後，要請使用者重跑一次 `安裝.bat`（啟動時不跑 `npm install`，太慢）。
- `安裝.bat` 存 CP950、`啟動.bat` 純 ASCII，兩者都必須是 CRLF。改完要**雙擊確認中文不是亂碼**。
- 開發規則見 `.claude/CLAUDE.md`，設計規格與實作計畫見 `docs/superpowers/`。

## 測試

```bash
npm run test:quiet          # 單元／API 測試（jest + pg-mem，不需啟動系統）
node scripts/e2e-smoke.js   # 端到端煙霧測試（需先啟動系統，打真的 PostgreSQL 與 HTTP）
```

兩者互補：jest 用 pg-mem，煙霧測試用真的資料庫 —— 兩者在 partial index 與 JOIN 上的行為並不相同，只跑其中一邊會漏。

前端沒有自動化測試，改動 `public/` 一律需要瀏覽器人工實測（含深色模式）。

## 目前已知的缺口

- **Google Books 需自備 API 金鑰**（免費）。未填時系統照常運作，只是中文書大多要人工填寫。填進 `data/config.json` 的 `GOOGLE_BOOKS_API_KEY` 即生效。
- **台灣 ISBN 全國新書資訊網（`server/lib/isbn/ncl.js`）尚未接通**。原假設的查詢網址回的是平臺框架頁，不含書目。此來源失敗只會回「查無」，不影響其他功能。

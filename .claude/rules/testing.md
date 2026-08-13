---
paths:
  - "server/tests/**"
---

# 測試規則

> 來源：改寫自 `C:\odoo-v2\.claude\rules\testing.md`。該專案同樣用 jest + pg-mem + supertest，下列 pg-mem 限制是在那裡**實際踩過**的。
> ⚠️ **本專案尚未逐條複驗** —— 遇到對不上的狀況以實測為準，並回頭修正本檔。

## pg-mem 已知限制

**這些是測試環境的限制，不要為了繞過它們去改正式 SQL。** 正確做法是跳過該測試並註解原因，或在測試層改寫查詢。

1. **`WHERE <serial_pk> = ANY($1::int[])` 永遠查不到既有列** —— int 陣列型別調解與 SERIAL 底層型別對不上，連字面量都查不到。`DELETE` 同樣靜默影響 0 列。改用 `IN (SELECT ...)`。
2. **一旦建了 partial unique index，`<欄位> IS NOT NULL AND <比較>` 會查不到列** —— 拿掉冗餘的 `IS NOT NULL`（語意等價）。
   > 🎯 **本專案直接命中此坑**：`loans_one_open_per_copy` 就是 partial unique index（`WHERE returned_at IS NULL`）。查「未歸還紀錄」時**不要**寫成 `WHERE copy_id=$1 AND returned_at IS NULL AND ...` 的冗餘形式。
   > **這個 index 在真實 schema 必須保留** —— 資料庫是「一冊不能同時借出兩次」的最後一道防線，不能只靠應用層檢查。若 pg-mem 完全無法建立它，測試層改用應用層檢查覆蓋，但**要在測試檔註明這條防線在測試中沒被覆蓋到**。
   > **2026-08-13 本專案實測，兩個結論**：
   > (a) ✅ **pg-mem 真的強制這個 index** —— 直接 INSERT 第二筆未歸還紀錄會被擋下（`scan.test.js` 的「資料庫層防線」有覆蓋）。
   > (b) ⚠️ **但列被 UPDATE 到離開 partial index 之後，多表 JOIN 會整個漏掉那一列。** 症狀：`SELECT *`／`COUNT(*)`／`WHERE returned_at IS NOT NULL` 全都查得到，**只有 JOIN 版本回 0 筆**——已歸還的紀錄在畫面上憑空消失。移除該 index 後 JOIN 立刻正常，可據此判定。
   >
   > **本專案對策**：`GET /api/loans` 刻意不用 JOIN，改成分開查再於 JS 合併（見 `routes/scan.js`）。這不是為了遷就測試而改壞正式 SQL——分開查在真 PG 與 pg-mem 都正確；若堅持 JOIN，借閱紀錄這個功能在測試裡永遠驗不到。**凡是要 JOIN `loans` 的新查詢都會踩到同一個坑。**
3. **`newDb()` 一律帶 `{ noAstCoverageCheck: true }`**（2026-08-13 實測）—— 否則表已存在時再跑一次 `CREATE TABLE IF NOT EXISTS`，pg-mem 會拋「The query you ran generated an AST which parts have not been read by the query planner」。`migrate()` 每次啟動都要能重跑，**正式 SQL 不可為了遷就測試環境而改**。
4. **`LIKE` 轉 regex 沒有 dotAll，`%` 跨不了換行** —— fixture 用空白而非 `\n` 當分隔。
5. **不支援相關子查詢**（子查詢內參照外層 alias），要改寫成 `NOT IN`；**改 `NOT IN` 時務必在子查詢加 `IS NOT NULL`** —— 真 PG 裡 `NOT IN` 清單只要含一個 NULL，整個條件恆為 UNKNOWN，查詢會靜默全失效。
   > 🎯 **2026-08-13 本專案實際踩到**：`SELECT t.*, (SELECT COUNT(*) FROM copies c WHERE c.title_id = t.id) FROM titles t` 會噴 `Unknown alias "t"`，API 回 500。
   > **本專案的「算冊數」一律分開查，不要寫成相關子查詢**：先撈 `titles`，再 `SELECT COUNT(*) FROM copies WHERE title_id = $1`。`/api/titles` 的 `total_copies`／`available_copies` 同樣適用。
6. **不支援 `btrim`。**
7. **`ROLLBACK` 是假的** —— 別依賴 transaction 回滾來隔離測試。
8. **表在測試間不清空** —— 寫新測試要假設有殘留資料。

## 測試設計

9. **測試挑的輸入值必須有鑑別力** —— 避開「正確行為與錯誤行為結果剛好相同」的值。例：驗「離線時不發網路請求」，若 mock 的網路層本來就回空，測了等於沒測——要斷言 fetch **完全沒被呼叫**。
10. **測「順序／覆蓋權」類邏輯，fixture 必須放兩筆以上** —— 只有一筆時 `push` 與 `unshift` 行為相同，全綠證明不了任何事。
11. **測試改寫要保住原測試的 intent，不是只讓它變綠** —— 否則覆蓋率會靜默塌陷。
12. **測試要建關聯資料先建父列** —— `copies.title_id` → `titles`，`titles.category_id` → `categories`，`loans.copy_id` → `copies`。
13. **外部 ISBN API 一律 mock，測試絕不打外網。** NCL 爬蟲的解析邏輯用**存檔的 HTML 樣本**驗證。
14. **測試絕不可讀到真正的 `data/config.json`**（2026-08-13 實際踩到）—— 否則「尚未設定金鑰」這類前提會因為開發機剛好設了金鑰而不成立，測試靜默失去意義，而且換一台機器結果就不同。
    已用 `server/tests/setup-env.js`（jest `setupFiles`）把 `LIBRARY_CONFIG_PATH` 指到暫存檔全域隔離。
    ⚠️ **這件事必須靠環境變數，不能只靠 `settings.setConfigPath()`** —— `jest.resetModules()` 會把模組內變數重置回預設路徑，setter 蓋不住。**新增任何讀設定的模組時，一律走 `lib/settings.js`，不要自己 `readFileSync` 設定檔。**

## 本專案必測的行為

不是為了覆蓋率，是這幾條錯了會直接造成資料錯亂：

- 同一冊不能同時借出兩次
- 歸還時回傳的櫃位字串正確組出「櫃 · 層」；未指定櫃位時有明確回應而非空字串
- 編號流水號併發不重號
- **離線時 lookup 直接回 `{online:false}` 且未發出任何網路請求**（斷言 fetch 未被呼叫）
- Google Books 回 429 時 fallback 到 NCL；NCL 也失敗則回 `{found:false}` 而非拋錯
- 搜尋自動完成四類（書目／單冊／借閱人／書櫃）都有結果且各自限量

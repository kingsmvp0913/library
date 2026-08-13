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
   > **2026-08-13 本專案實測**：pg-mem 執行 `CREATE UNIQUE INDEX ... WHERE returned_at IS NULL` **不拋錯**。但「語句不報錯」≠「真的強制唯一性」——是否實際擋得下重複的未歸還紀錄，由 `scan.test.js` 的資料庫層測試驗證，結論以那支測試為準。
3. **`newDb()` 一律帶 `{ noAstCoverageCheck: true }`**（2026-08-13 實測）—— 否則表已存在時再跑一次 `CREATE TABLE IF NOT EXISTS`，pg-mem 會拋「The query you ran generated an AST which parts have not been read by the query planner」。`migrate()` 每次啟動都要能重跑，**正式 SQL 不可為了遷就測試環境而改**。
4. **`LIKE` 轉 regex 沒有 dotAll，`%` 跨不了換行** —— fixture 用空白而非 `\n` 當分隔。
5. **不支援相關子查詢**（子查詢內參照外層 alias），要改寫成 `NOT IN`；**改 `NOT IN` 時務必在子查詢加 `IS NOT NULL`** —— 真 PG 裡 `NOT IN` 清單只要含一個 NULL，整個條件恆為 UNKNOWN，查詢會靜默全失效。
6. **不支援 `btrim`。**
7. **`ROLLBACK` 是假的** —— 別依賴 transaction 回滾來隔離測試。
8. **表在測試間不清空** —— 寫新測試要假設有殘留資料。

## 測試設計

9. **測試挑的輸入值必須有鑑別力** —— 避開「正確行為與錯誤行為結果剛好相同」的值。例：驗「離線時不發網路請求」，若 mock 的網路層本來就回空，測了等於沒測——要斷言 fetch **完全沒被呼叫**。
10. **測「順序／覆蓋權」類邏輯，fixture 必須放兩筆以上** —— 只有一筆時 `push` 與 `unshift` 行為相同，全綠證明不了任何事。
11. **測試改寫要保住原測試的 intent，不是只讓它變綠** —— 否則覆蓋率會靜默塌陷。
12. **測試要建關聯資料先建父列** —— `copies.title_id` → `titles`，`titles.category_id` → `categories`，`loans.copy_id` → `copies`。
13. **外部 ISBN API 一律 mock，測試絕不打外網。** NCL 爬蟲的解析邏輯用**存檔的 HTML 樣本**驗證。

## 本專案必測的行為

不是為了覆蓋率，是這幾條錯了會直接造成資料錯亂：

- 同一冊不能同時借出兩次
- 歸還時回傳的櫃位字串正確組出「櫃 · 層」；未指定櫃位時有明確回應而非空字串
- 編號流水號併發不重號
- **離線時 lookup 直接回 `{online:false}` 且未發出任何網路請求**（斷言 fetch 未被呼叫）
- Google Books 回 429 時 fallback 到 NCL；NCL 也失敗則回 `{found:false}` 而非拋錯
- 搜尋自動完成四類（書目／單冊／借閱人／書櫃）都有結果且各自限量

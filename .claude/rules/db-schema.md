---
paths:
  - "server/db.js"
---

# 資料庫 schema 規則

> 來源：改寫自 `C:\odoo-v2\.claude\rules\db-schema.md`，只保留與本專案相關的條目。

1. **所有時間戳欄位一律用 `TIMESTAMPTZ`，不要用 `TIMESTAMP`** —— 台灣時區下 `TIMESTAMP` 會產生 8 小時落差，「借出多久了」這類比較會直接誤判。
2. **migration 是 add-if-missing 框架 —— 改欄位的 DEFAULT 字面值對既有資料庫完全無效。** 既有 DB 早就跑過 `ALTER`，DEFAULT 已凍結。要改預設行為必須從真正生效的地方下手（例如建立時的 INSERT 寫死值）。
3. **沒有 drop column 機制。** 欄位停用只能「程式不再讀寫、欄位保留」；同時要移除其他地方對該欄位的回填邏輯，否則死欄位看起來還活著。
4. **設定類數值用 `??` 取預設值，不要用 `||`** —— `(limit || 10)` 會讓「設 0」被預設值蓋掉，功能表面存在卻永遠關不掉。
5. **一次性資料正規化 migration 必須 idempotent**（每次啟動都會跑），且不能用 `btrim`（pg-mem 不支援）。
6. **`copies.barcode` 與 `loans_one_open_per_copy` 的唯一性約束由資料庫保證，不可只靠應用層。** 見 `.claude/rules/testing.md` 第 2 條。
7. **連線字串放 `data/config.json` 的 `DATABASE_URL`，不是 `.env`，也不要寫死在程式裡。** 使用者端由 `安裝.bat` 以 winget 裝 PostgreSQL 17（預設 `localhost:5432`）；但**開發機已有 `postgresql-x64-10/16/17` 三個服務在跑**，5432 可能被佔用或密碼不同——改 `config.json` 即可，不要因此改動預設值或程式碼。
8. **`setup.js` 建資料庫要先連 `postgres` 系統庫再 `CREATE DATABASE`**，且必須先查 `pg_database` 確認不存在才建（重跑 `安裝.bat` 不能炸）。整個 setup 流程必須 idempotent。

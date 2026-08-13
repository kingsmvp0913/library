# CLAUDE.md — 幼稚園圖書／教具管理系統

> 本檔改寫自 `C:\odoo-v2\.claude\CLAUDE.md`。**所有 Odoo 慣例、pipeline／agent、Docker／VPN、多人平行 worktree 規則已刪除**——本專案是單機、單人維護的 Node web app，與 Odoo 無關。
> 設計規格：`docs/superpowers/specs/2026-08-13-library-system-design.md`

## 0. 這個專案是什麼

幼稚園自用的館藏管理：管圖書與教具，掃 ISBN 建檔、掃編號借還。**單機執行**（`http://localhost:3940`），無登入、無對外網開放。**機器可能沒有網路** —— 離線是正常狀態，不是故障。

技術棧：Node 24 + Express 4 + PostgreSQL 17 + 原生 JS/CSS 前端 + jest/pg-mem/supertest。

**最終使用者不懂電腦。** 他只會看到兩個檔：`安裝.bat`（跑一次）、`啟動.bat`（每次，含自動更新）。任何要求他開命令列、改設定檔、自行安裝套件的設計都是錯的。

## 1. Hard Rules

- **NEVER guess intent.** 有歧義時攤開 2–3 種解讀；複雜任務動手前先講出一個核心假設。攤開之後仍不確定就問，不要用猜的往下做。
- **Stop when confused.** 先講清楚哪裡不明白再繼續。
- **NEVER add fields/models/logic beyond the agreed spec.** 規格沒寫的欄位、模型、功能一律不做。要加先改規格。
- **禁止寫死任何絕對路徑**（`C:\...`、`/home/...`）。一律相對路徑或環境變數。
- **秘密不進版控**：`GOOGLE_BOOKS_API_KEY` 只放 `.env`（附 `.env.example` 當範本）。用 Node 24 原生 `node --env-file=.env`，不要為此引入 `dotenv`。
- Think in English. Output Traditional Chinese (Taiwan). No preambles.
- 不得在未經使用者明確同意下修改工作流程設定（hook、`settings.json`、CI、本檔）。

## 2. 這個專案的領域規則

- **「單冊」才是借還的主體，不是「書目」。** 借出／歸還／櫃位一律作用在 `copies`，不要寫成對 `titles` 操作。同一 ISBN 有 3 冊就是 3 筆 `copies`，各自獨立進出。
- **編號（`copies.barcode`）是貼在實體書上的 KEY，產生後永不變更。** 沒有「重新編號」功能。
- **編號取號必須是單一原子語句**：`UPDATE counters SET last_no = last_no + 1 WHERE kind=$1 RETURNING last_no`。不要「先 SELECT 再 UPDATE」，會重號。
- **圖書與教具共用同一套 `titles`／`copies`，只靠 `categories.kind` 區分。** 不要為教具另開一組表或另寫一條流程。教具的 `isbn13` 為 NULL 是正常的。
- **離線必須是靜默降級，不是錯誤。** 沒網路時：不發網路請求、不等 timeout、不跳錯誤，直接展開人工填寫表單。**借還書任何情況下都不得依賴網路。**
- **外部 ISBN 來源一律隔離在 `server/lib/isbn/<provider>.js`，任一支失敗只記 log 不冒泡。** 台灣 ISBN 全國新書資訊網（`ncl.js`）是爬 HTML 的脆弱來源，對方改版就會壞——解析失敗一律視為「查無」。
- **封面圖一律下載落檔，不存外連網址。** 斷網時仍要看得到封面。

### 一鍵安裝／啟動（改 `安裝.bat`／`啟動.bat`／`scripts/` 前必讀）

- **所有設定集中在 `data/config.json`**（`DATABASE_URL`／`PORT`／`GOOGLE_BOOKS_API_KEY`）。不另開 `.env`。`setup.js` 首次產生後**不再覆寫**——使用者的修改必須保住。
- **`start.js` 關舊進程必須排在開瀏覽器之前。** 否則 `git pull` 拉到的新版沒生效、瀏覽器連的是舊進程，而畫面上完全看不出異狀（pmis 實際踩過）。
- **給使用者的錯誤訊息一律是「下一步該做什麼」，不是 stack trace。** 例：「資料庫初始化失敗。請開啟 `data\config.json` 修改 `DATABASE_URL` 的帳號密碼，再執行一次本檔。」
- **啟動流程不得因為更新失敗而中斷。** `git pull` 失敗只印警告、照樣用現有版本啟動——舊版能用遠比開不起來好。同理，任何選配步驟（抓封面、外部 API）失敗都不得擋住啟動。
- **`.bat` 編碼**：`啟動.bat` 純 ASCII + `chcp 65001`，中文全交給 node 印；`安裝.bat` 存 CP950 且不加 `chcp`（node 還沒裝好，沒有 node 可用）。**兩者都不可存 UTF-8 with BOM**（BOM 會被 cmd 當命令，第一行直接報錯）。改完只能**雙擊人工確認中文不是亂碼**，自動化測試驗不到。
- **winget 裝完必須重讀 PATH**，否則同一個 cmd 視窗 `where node` 仍然找不到。重讀後還是找不到就停下來請使用者重開視窗，不要硬往下跑。

## 3. Edit Protocol

- Commit 訊息：`[模組]: 為什麼（不是做了什麼）`。
- **Minimum code that solves the problem.** 不做臆測性功能，不為單一用途做抽象。（檢驗法：資深工程師會不會覺得這過度設計？）
- 只碰非動不可的地方。不順手整理相鄰的程式碼、註解、排版。
- 完全比照既有風格。零順手重構。
- 動手加程式前先讀 exports、直接呼叫端、共用工具。「看起來無關」很危險——不確定某段程式為何長這樣就問。
- 慣例 > 個人品味。即使不認同也照既有慣例走；真心覺得慣例有害就明講，不要默默分叉。

## 4. Output Style

繁中術語：專案／資料庫／佈署／模組。保留英文：Variable／Function／Hook／Class／Field／Model／Method／Controller／Route。

## 5. General Engineering Rules

- **Goal-Driven Execution**：動手前先定義成功條件，反覆迭代到驗證通過。不要機械式照步驟走。
- **Surface Conflicts, Don't Average Them**：兩個做法牴觸時挑一個（較新／較有測試覆蓋的），說明理由，另一個標記待清理。不要把牴觸的做法混著用。
- **Tests Verify Intent**：測試要編碼「為什麼這行為重要」，不是只驗「它做了什麼」。business logic 改了卻不會紅的測試是壞測試。
- **Checkpoint After Every Significant Step**：講清楚做了什麼、驗證了什麼、還剩什麼。描述不出來的狀態就不要往下做。
- **Fail Loud**：有任何一步被跳過，就不能說「完成」。有測試被 skip，就不能說「測試通過」。預設要攤開不確定性，不是藏起來。
- **不確定就先做不依賴該答案的部分**，需要答案的部分明講假設或提問，不要卡死也不要瞎猜。

## 6. 測試

**全跑指令**：`npm run test:quiet`（`jest --runInBand --silent --noStackTrace --no-color`）。

- **必須 `--runInBand`**：平行 worker 下 pg-mem 會產生浮動假紅。
- **紅了才對那一支單獨跑完整輸出** —— console log 在全綠時是噪音，在除錯時是線索。
- **基線自己量**：動手改任何東西之前先跑一次全跑，把 `Tests:` 那行記下來當基線。之後出現的紅燈一律先假設是自己造成的。
- **不要在規則檔裡寫死「既有紅燈」清單或通過數字** —— 那種清單會腐爛，最後變成教人把自己改壞的東西當既有問題放過去。
- **取指令的 exit code 不要經過管線或尾隨指令**（`cmd | tail`、`cmd; echo $?` 拿到的都不是 `cmd` 的碼）。先落檔再統計：`cmd > tmp/out.log 2>&1; echo "EXITCODE=$?" >> tmp/out.log`。
- **落檔一律寫進 `tmp/`，不要丟在專案根目錄。** 測試輸出、診斷腳本、暫時的重現腳本都算。`tmp/` 已在 `.gitignore` 內。（實測教訓：一輪開發下來根目錄長出 59 個 `.log`，雖然沒進版控，但把專案結構埋掉了。）
- **測試輸出若超過 20,000 bytes 就值得處理**：`npm run test:quiet > out 2>&1; wc -c < out`。方法可移植，數字不可移植——別套用別的專案量到的數字。
- **不要為了省 token 而少跑測試。** 要壓的是輸出，不是覆蓋率。

詳細的 pg-mem 限制見 `.claude/rules/testing.md`。

## 7. 常見操作

```bash
npm start                 # 起 server → http://localhost:3940
npm run test:quiet        # 全跑測試（精簡輸出）
npx jest <檔名> 2>&1       # 單支跑，含完整 console（除錯用）
```

**改了 `server/**.js` 必須重啟 server** —— 常駐進程載的是舊碼，不重啟會誤判修法無效。

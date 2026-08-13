# 幼稚園圖書／教具管理系統 — 設計規格

- 日期：2026-08-13
- 專案路徑：`C:\library`（remote: `github.com/kingsmvp0913/library.git`，`main` 分支尚無 commit）
- 狀態：設計定稿，待實作計畫

---

## 1. 目標與使用情境

幼稚園自用的館藏管理，管圖書與教具。核心動作只有三個：**建檔（掃 ISBN 自動補資料）→ 貼編號條碼 → 掃碼借還**。

- 使用者：園內老師，**單機使用**（`http://localhost:3940`）。
- 不做登入、不做權限分層、不對外網開放。
- **這台機器可能沒有網路** —— 系統必須在離線時正常運作，只是不自動補書目資料。
- **使用者不懂電腦** —— 安裝、啟動、更新一律是「雙擊一個檔」，不得要求使用者開命令列、改設定檔或自行安裝相依套件。見 §11。

## 2. 技術棧

照 `odoo-v2` 平台本體的技術棧，但只是沿用骨架與開發規則，與 Odoo 無關。

| 項目 | 選擇 |
|---|---|
| Runtime | Node.js v24 |
| 後端 | Express 4 |
| 資料庫 | PostgreSQL 17（由 `安裝.bat` 以 winget 自動安裝），資料庫名 `library`，連線字串存 `data/config.json` |
| 前端 | 原生 JS / CSS，無框架，多頁式 |
| 測試 | jest `--runInBand` + pg-mem + supertest |
| 啟動 | `npm start` → `http://localhost:3940` |

目錄結構仿 `odoo-v2/app`：

```
library/
├── 安裝.bat                # 第一次使用點這個（winget 裝 Node/PG/Git → npm install → 建 DB）
├── 啟動.bat                # 之後每次都點這個（git pull 自動更新 → 起 server → 開瀏覽器）
├── scripts/
│   ├── setup.js            # 安裝編排：建 config.json → CREATE DATABASE → migrate → 種子資料
│   ├── start.js            # 啟動編排：讀 config → 關舊進程 → 開瀏覽器 → 起 server
│   └── free-port.js        # 關掉佔用該埠的舊進程
├── data/
│   ├── config.json         # DATABASE_URL / PORT / GOOGLE_BOOKS_API_KEY（不進版控）
│   └── covers/             # 封面圖落檔（不進版控）
├── server/
│   ├── index.js            # Express 進入點
│   ├── db.js               # 連線池 + schema 初始化
│   ├── lib/
│   │   ├── barcode-no.js   # 編號產生（原子性）
│   │   ├── net-status.js   # 離線偵測與快取
│   │   └── isbn/
│   │       ├── index.js       # 多來源 fallback 協調
│   │       ├── google-books.js
│   │       └── ncl.js         # 台灣 ISBN 全國新書資訊網（備用、脆弱）
│   ├── routes/             # 一個資源一支 route 檔
│   └── tests/              # 一支 route 配一支 *.test.js
├── public/
│   ├── *.html              # 5 個頁面
│   ├── css/
│   └── js/
│       ├── app.js          # 共用 fetch / toast / 格式化
│       ├── scan-input.js   # 掃碼輸入（槍 + 鏡頭）
│       ├── omnisearch.js   # 全站自動完成
│       └── barcode.js      # Code128 SVG 產生（無外部依賴）
└── docs/
```

## 3. 資料模型

### 3.1 `shelves` 書櫃（自關聯，最多兩層）

| 欄位 | 型別 | 說明 |
|---|---|---|
| id | SERIAL PK | |
| code | TEXT UNIQUE NOT NULL | 例 `A`、`A-2` |
| name | TEXT NOT NULL | 例「A櫃」「第2層」 |
| parent_id | INT FK→shelves | NULL = 頂層櫃 |
| note | TEXT | |
| sort_order | INT DEFAULT 0 | |
| active | BOOL DEFAULT TRUE | |

**限制**：只允許兩層 —— `parent_id` 指向的列，其自身 `parent_id` 必須為 NULL。跨列限制無法用 CHECK 表達，在應用層驗證（新增／修改書櫃時檢查）。

不分層的園所直接只建頂層櫃即可，介面上「層」為選填。

### 3.2 `categories` 類型

| 欄位 | 型別 | 說明 |
|---|---|---|
| id | SERIAL PK | |
| code | TEXT UNIQUE NOT NULL | |
| name | TEXT NOT NULL | 例「繪本」「桌遊」 |
| kind | TEXT NOT NULL | `book` / `toy`，**決定編號前綴** |
| sort_order | INT DEFAULT 0 | |
| active | BOOL DEFAULT TRUE | |

圖書與教具**共用同一套館藏資料**，靠 `kind` 區分。預設種子資料：圖書類「繪本」「橋樑書」「工具書」；教具類「教具」「桌遊」。

### 3.3 `titles` 書目

| 欄位 | 型別 | 說明 |
|---|---|---|
| id | SERIAL PK | |
| isbn13 | TEXT UNIQUE | 教具為 NULL（PG 的 UNIQUE 允許多筆 NULL） |
| title | TEXT NOT NULL | |
| subtitle / authors / publisher / published_date / description | TEXT | |
| cover_path | TEXT | 相對路徑，例 `data/covers/9789573317249.jpg` |
| category_id | INT FK→categories NOT NULL | |
| source | TEXT NOT NULL DEFAULT 'manual' | `google` / `ncl` / `manual` |
| created_at / updated_at | TIMESTAMPTZ | |

### 3.4 `copies` 單冊 ← **這是借還的主體**

| 欄位 | 型別 | 說明 |
|---|---|---|
| id | SERIAL PK | |
| **barcode** | TEXT UNIQUE NOT NULL | **系統產生的編號，貼在實體書上的 KEY** |
| title_id | INT FK→titles NOT NULL | |
| shelf_id | INT FK→shelves | 這一冊放哪一格 |
| status | TEXT NOT NULL DEFAULT 'in' | `in` 在架 / `out` 借出 / `lost` 遺失 / `repair` 修繕 |
| note / acquired_at | | |

### 3.5 `borrowers` 借閱人

| 欄位 | 型別 | 說明 |
|---|---|---|
| id | SERIAL PK | |
| code | TEXT UNIQUE | 選填 |
| name | TEXT NOT NULL | |
| class_name | TEXT | 班級 |
| note / active | | |

不分學生／老師身分（依使用者決定）。借書時以「可搜尋的下拉」選取。

### 3.6 `loans` 借還紀錄

| 欄位 | 型別 | 說明 |
|---|---|---|
| id | SERIAL PK | |
| copy_id | INT FK→copies NOT NULL | |
| borrower_id | INT FK→borrowers NOT NULL | |
| borrowed_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| returned_at | TIMESTAMPTZ | NULL = 尚未歸還 |
| return_shelf_id | INT FK→shelves | 歸還當下提示的櫃位，存查用 |

**完整性保證**：
```sql
CREATE UNIQUE INDEX loans_one_open_per_copy ON loans(copy_id) WHERE returned_at IS NULL;
```
一冊同時只能有一筆未歸還紀錄，從資料庫層杜絕重複借出。

> ⚠️ **已知風險**：pg-mem 對 partial unique index 的支援未經驗證。若測試環境不支援，測試層改以應用層檢查覆蓋，但**真實 schema 必須保留這個 index**（資料庫是最後一道防線，不能只靠應用層）。實作第一步就要驗證此點並回報。

### 3.7 `counters` 編號流水號

| 欄位 | 型別 |
|---|---|
| kind | TEXT PK（`book` / `toy`） |
| last_no | INT NOT NULL DEFAULT 0 |

## 4. 編號規則

- 圖書：`B-000001`；教具：`T-000001`。前綴由 `categories.kind` 決定，兩者流水號各自獨立。
- **原子性**：用單一語句取號，避免併發重號。
  ```sql
  UPDATE counters SET last_no = last_no + 1 WHERE kind = $1 RETURNING last_no;
  ```
  （不用 SEQUENCE，因為 pg-mem 對 SEQUENCE 支援度不明；單語句 UPDATE...RETURNING 兩邊都可行。）
- 條碼以純 JS 產生 **Code39 SVG**（無外部依賴、無需上網），列印貼紙。支援單張列印與批次列印（剛建的 N 冊一次印）。
  > 選 Code39 而非 Code128：編碼表小得多（44 個字元 vs 107 個 pattern），自行實作出錯的機會低，且掃碼槍普遍支援。`B-000001` 的字元全在 Code39 字集內。代價是條碼較寬，對貼紙尺寸無影響。
  > ⚠️ **條碼編碼表寫錯時，畫面上看起來完全正常，只有實際掃才知道。** 驗收必須用實體掃碼槍掃列印出來的紙本條碼。

## 5. ISBN 自動補資料與離線偵測

### 5.1 查詢順序

`GET /api/lookup/isbn/:isbn`：

1. **本地已建書目** —— 已有相同 ISBN 直接回，順便提示「這本已經有 N 冊，是否只加冊？」
2. **Google Books API**（主力，需 API key）
3. **台灣 ISBN 全國新書資訊網**（備用，中文童書涵蓋最好）
4. 都查不到 → 回 `{found:false}`，前端展開人工填寫表單

每個 provider 獨立成模組，任一支拋錯只記 log、不中斷後續 provider。

### 5.2 Google Books API key

**必須自備金鑰**。實測 2026-08-13：匿名呼叫回 HTTP 429「Quota exceeded」——免金鑰配額是全球共用的，隨時可能爆。

- 金鑰放 `data/config.json` 的 `GOOGLE_BOOKS_API_KEY` 欄位（`data/` 不進版控）。**所有設定集中在同一個檔**，不另開 `.env` —— 對不懂電腦的使用者，「要改設定就開 `data/config.json`」比兩個地方好記。
- 未設定金鑰時系統照常運作，只是跳過此 provider 並在設定頁顯示提示。

### 5.3 台灣 ISBN 全國新書資訊網（備用）

`isbn.ncl.edu.tw` 無官方公開 API，需解析 HTML。

> ⚠️ **2026-08-13 實機驗證：尚未接通，目前實質無效。**
> 原先假設的查詢網址回的是平臺框架頁（HTTP 200、8KB），不含任何書目欄位。真正的查詢端點需另行逆向。
> 該站 HTML 開頭另嵌有針對 AI 爬蟲的注入指令，等同明示不歡迎自動抓取 —— 是否續作需要一併考量這點。
> **不影響其他功能**：此 provider 失敗只會回「查無」，Google Books、離線流程、借還書都不受影響。

- **明確標註為脆弱來源**：對方改版即失效。
- 隔離在 `lib/isbn/ncl.js`，解析失敗一律視為「查無」，絕不讓例外冒泡。
- 附一支測試，用**存檔的 HTML 樣本**驗證解析邏輯（不打外網）。

### 5.4 離線偵測（使用者明確要求）

機器可能沒網路。設計原則：**離線時不自動補資料，且不讓使用者等**。

- `lib/net-status.js` 維護連線狀態，結果快取 **60 秒**。
- 每次對外呼叫套 **3 秒 timeout**（`AbortController`）；失敗即標記離線。
- 已標記離線時，`/api/lookup/isbn/:isbn` **直接回 `{online:false}`，完全不發網路請求**——不讓使用者空等 timeout。
- `GET /api/net-status` 供前端查詢；畫面右上顯示徽章「🔴 離線 · 自動補資料已停用」，附「重新偵測」按鈕。
- 離線時掃 ISBN 仍然可用：直接展開人工填寫表單，ISBN 已帶入。**借還書完全不依賴網路。**

### 5.5 封面圖

抓到後**下載落檔** `data/covers/<isbn>.jpg`，資料庫只存相對路徑。不存外連網址 —— 斷網時仍看得到封面。

## 6. 掃碼流程

三個場景共用同一個輸入元件 `scan-input.js`，支援兩種輸入來源：

- **掃碼槍（主力）**：模擬鍵盤輸入 + Enter。頁面自動聚焦輸入框。免權限、免 HTTPS。
- **筆電／外接鏡頭（備援）**：`BarcodeDetector` API。因為只在 localhost 使用，屬 secure context，**免 HTTPS 即可取得相機權限**。
  > 效果預期：書背 EAN-13 是細條碼，筆電內建廣角定焦鏡頭辨識率明顯低於掃碼槍。定位為「沒帶槍時的備援」，不是主要流程。

### 6.1 新增館藏

兩個入口，之後的流程相同（選類型／櫃位／冊數 → 建立書目 + N 冊 → 立刻顯示各冊編號，可批次列印條碼）：

- **圖書：掃 ISBN** → 查詢 → **預覽卡（封面＋書名＋作者＋出版社）** → 確認。
- **教具：手動新增**（教具沒有 ISBN，`titles.isbn13` 留 NULL）→ 填名稱、說明 → **可自行上傳一張照片**當預覽圖。
  - 上傳走 `POST /api/titles/:id/cover`（multer，限圖片、限 5MB），存 `data/covers/title-<id>.jpg`，與抓下來的封面走同一個 `cover_path` 欄位。
  - 圖書若抓不到封面，也可以用同一個入口手動補圖。

### 6.2 列表掃碼借還（同一格輸入框，系統自行判斷）

掃「單冊編號」→ `POST /api/scan` → 依該冊 `status` 決定畫面：

| 現況 | 畫面 | 動作 |
|---|---|---|
| `in` 在架 | 書封 + 書名 + **可搜尋的借閱人下拉** | Enter 借出 |
| `out` 借出中 | **大字顯示「請放回：A櫃 · 第2層」** + 借閱人與借出時間 | 一鍵歸還 |
| `lost` / `repair` | 狀態警示 | 提示先處理狀態 |

「還書自動列出櫃位」即取 `copies.shelf_id` 一路往上組成「櫃 · 層」字串；未設櫃位則顯示「尚未指定櫃位」並提供就地指定。

## 7. 全站搜尋自動完成

單一搜尋框（每頁都有），`GET /api/search/suggest?q=`：

- 同時查四類，各取 5 筆，分組回傳：
  - **書目** — 書名 / 作者 / ISBN
  - **單冊** — 編號
  - **借閱人** — 姓名 / 班級
  - **書櫃** — 名稱 / 代碼
- 每筆附 `type` 與跳轉目標，Enter 直接跳到對應頁面。
- 實作用 PostgreSQL `ILIKE '%q%'` + `LIMIT`。**不引入 `pg_trgm`** —— 幼稚園館藏數千筆，ILIKE 完全足夠，少一個 extension 依賴。
- 前端 debounce 200ms，方向鍵選取，Esc 關閉。

## 8. 畫面（5 頁）

| 頁面 | 內容 |
|---|---|
| **借還台**（首頁） | 大型掃碼輸入框 + 全站搜尋 + 今日借還清單 + 目前外借中 |
| **館藏** | 書目列表，可依類型／櫃位／狀態篩選；「新增」進掃 ISBN 流程；展開看各冊與其編號、櫃位、狀態 |
| **書櫃管理** | 兩層樹狀維護；顯示每櫃現有冊數 |
| **借閱人管理** | 清單維護，可搜尋 |
| **借閱紀錄** | 全部借還歷史，可搜尋、可篩「未歸還」 |

## 9. API 一覽

```
GET    /api/net-status
GET    /api/lookup/isbn/:isbn

GET    /api/shelves            POST /api/shelves     PUT /api/shelves/:id     DELETE /api/shelves/:id
GET    /api/categories         POST /api/categories  PUT /api/categories/:id  DELETE /api/categories/:id
GET    /api/borrowers?q=       POST /api/borrowers   PUT /api/borrowers/:id   DELETE /api/borrowers/:id

GET    /api/titles?q=&category=&shelf=&status=
POST   /api/titles                       # 建書目 + N 冊，回各冊編號
GET    /api/titles/:id                   # 含所屬各冊
PUT    /api/titles/:id
POST   /api/titles/:id/copies            # 加冊
POST   /api/titles/:id/cover             # 手動上傳封面／教具照片（multer，限圖片 5MB）

GET    /api/copies/:barcode
PUT    /api/copies/:id                   # 改櫃位 / 狀態

POST   /api/scan                         # { barcode } → 該冊現況與建議動作
POST   /api/loans                        # { copy_id, borrower_id } → 借出
POST   /api/returns                      # { barcode } → 歸還，回傳應放回的櫃位
GET    /api/loans?open=1&q=

GET    /api/search/suggest?q=
```

## 10. 測試策略

- 一支 route 配一支 `*.test.js`（jest + supertest + pg-mem）。
- **外部 ISBN API 一律 mock，測試絕不打外網。**
- 必測的行為（Rule 9：測試驗證意圖，不只驗證實作）：
  - 同一冊不能同時借出兩次（partial unique index / 應用層）
  - 歸還時回傳的櫃位字串正確組出「櫃 · 層」，未指定櫃位有明確回應
  - 編號流水號併發不重號
  - **離線時 lookup 直接回 `{online:false}` 且未發出任何網路請求**
  - Google Books 回 429 時 fallback 到 NCL，NCL 也失敗則回 `{found:false}` 而非拋錯
  - 搜尋自動完成四類都有結果且各自限量
- 測試輸出精簡：`npm run test:quiet`（`--runInBand --silent --noStackTrace --no-color`）。

## 11. 安裝、啟動與更新（一鍵）

**設計來源**：照抄 `C:\pmis` 已在生產使用的模式（`安裝.bat` + `啟動.bat` + `scripts/setup.js` + `scripts/start.js`）。使用者只會看到兩個檔。

### 11.1 使用者視角

| 情境 | 動作 |
|---|---|
| 第一次使用 | 雙擊 **`安裝.bat`**，等它跑完 |
| 每天使用 | 雙擊 **`啟動.bat`**，瀏覽器自動打開 |
| 想更新到新版 | **不用做任何事** —— `啟動.bat` 每次啟動都會自動更新 |
| 關閉系統 | 關掉黑色視窗 |

**使用者不需要知道 Node、PostgreSQL、git、命令列的存在。**

### 11.2 `安裝.bat`（跑一次）

照 pmis 的五步，全部具備「已安裝就跳過」的判斷：

1. `where node` 找不到 → `winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements`
2. `where psql` 或登錄檔 `HKLM\SOFTWARE\PostgreSQL\Installations` 都找不到 → `winget install -e --id PostgreSQL.PostgreSQL.17 --silent ...`
3. `where git` 找不到 → `winget install -e --id Git.Git --silent ...`（**git 是自動更新的前提**）
4. `npm install`
5. `node scripts\setup.js`（建 config → CREATE DATABASE → migrate → 種子資料）

**必要細節**（都是 pmis 已踩過的）：

- **裝完必須重讀 PATH**：winget 裝完，當前 cmd 視窗的 PATH 是舊的，`where node` 仍然找不到。要從登錄檔重讀 `HKLM\...\Session Manager\Environment` 與 `HKCU\Environment` 的 `Path` 併回 `PATH`（pmis 的 `:refreshpath` 子程序）。
- **重讀後 node 仍找不到就停下來**，用白話告訴使用者「請關掉這個視窗，重新點一次安裝.bat」，`pause` 之後 `exit /b 1`。**不要硬往下跑**，否則後面每一步都會失敗，畫面噴一堆看不懂的錯。
- **`setup.js` 失敗要給可執行的下一步**，不是丟 stack trace：「資料庫初始化失敗。若您電腦已有 PostgreSQL 且密碼不是 postgres，請開啟 `data\config.json` 修改 `DATABASE_URL` 的帳號密碼，再執行一次本檔。」

### 11.3 `啟動.bat`（每次）

```bat
@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 先更新再啟動，新版本這次就生效；沒有 git 或不是 git repo 時靜默跳過
where git >nul 2>nul && git pull --ff-only
node "scripts\start.js"
if errorlevel 1 pause
```

`scripts/start.js` 的職責與順序：

1. 讀 `data/config.json`；不存在或損毀 → 白話提示「請先雙擊安裝.bat」後 exit 1
2. **先關掉佔用該埠的舊進程**（`free-port.js`）
   > ⚠️ **這一步必須排在開瀏覽器之前。** 否則 `git pull` 拉到的新版沒生效、瀏覽器連上的是舊進程，而**畫面上完全看不出異狀** —— 這是 pmis 實際踩過的坑，註解要保留。
   > 埠被「不是本系統」的程式佔用時，不要硬殺，改提示使用者換 `config.json` 的 `PORT`。
3. 開預設瀏覽器到 `http://localhost:3940`（失敗不致命）
4. `migrate()` → `app.listen()`，並印出「圖書系統已啟動：http://localhost:3940（關閉此視窗即停止）」

### 11.4 `data/config.json`

由 `setup.js` 首次產生，之後不覆寫（使用者的修改要保住）：

```json
{
  "DATABASE_URL": "postgres://postgres:postgres@localhost:5432/library",
  "PORT": 3940,
  "GOOGLE_BOOKS_API_KEY": ""
}
```

- 不進版控。`buildConfig(overrides)` 寫成**純函式**（無 I/O）以便測試。
- 金鑰留空是合法狀態 —— 系統照常運作，只是跳過 Google Books 這個來源。

### 11.5 自動更新的前提與限制

- 更新機制是 `git pull --ff-only`，**因此使用者的電腦必須是用 `git clone` 取得這份程式**，不能是解壓縮 zip。
- **首次部署由懂電腦的人做一次 `git clone`**（就是你），之後使用者完全不需要碰。
- `--ff-only` 保證使用者端絕不產生合併衝突：本機沒有任何改動，永遠是快轉。若使用者端不知怎地有了本機改動導致 pull 失敗，**啟動流程不得中斷** —— `git pull` 失敗只印警告，照樣用現有版本啟動。舊版能用，遠比為了更新而開不起來好。
- `npm install` **不在啟動時跑**（太慢）。若某次更新新增了套件相依，需請使用者重跑一次 `安裝.bat`。

### 11.6 `.bat` 編碼（會變亂碼的坑）

`cmd.exe` 用「當前 codepage」解讀 `.bat` 內的位元組，這台機器預設是 CP950。

- **`啟動.bat`：純 ASCII**，第一行 `chcp 65001 >nul`。**所有中文訊息一律由 node 印**（node 輸出 UTF-8，配合 `chcp 65001` 正常顯示）。
- **`安裝.bat`：存 CP950（Big5），不加 `chcp`。** 因為它在 node 裝好之前就要印中文，沒有 node 可用。
- **兩者都不可存成 UTF-8 with BOM** —— BOM 會被 cmd 當成命令，第一行直接報錯。
- 這兩支是 pmis 已在生產驗證的組合，照抄即可。**驗收方式只有一種：實際雙擊，用眼睛確認中文不是亂碼。** 自動化測試驗不到這件事。

## 12. 非目標（本版不做）

明確排除，避免範圍蔓延：

- 登入、帳號、權限分層
- 借期、到期日、逾期、罰款、預約、續借（使用者選「最小：只記借出／歸還」）
- 多館別、多分館
- 對外網開放、行動 App
- 讀者自助借還

## 13. 實作前提與待確認事項

1. **Google Books API key** —— 需到 Google Cloud Console 申請（免費，每日 1000 次）。未取得前系統可運作，只是主力來源停用；填進 `data/config.json` 即生效。
2. **開發機的 PostgreSQL 埠** —— 這台開發機已有 `postgresql-x64-10/16/17` 三個服務在跑，5432 可能已被佔用或密碼不是 `postgres`。**這只影響開發機**：`DATABASE_URL` 走 `data/config.json`，改掉即可，不影響使用者端由 `安裝.bat` 全新安裝的情境。
3. **pg-mem 是否支援 partial unique index** —— 見 §3.6。實作第一步驗證並回報。
4. **`.bat` 中文顯示** —— 見 §11.6。只能雙擊人工驗證，自動化測試驗不到。

# Google Drive 串接說明

InvestAlpha 透過 **Google Drive API v3** 讀取一個放投顧報告的資料夾，把新檔案下載後交給 AI 解析，寫進資料庫。本文件整理串接方式、資料流程、設定、API 與常見問題。

主要程式：

| 檔案 | 角色 |
|---|---|
| `backend/drive_sync.py` | Drive 認證、列檔、下載、逐檔分析與入庫（核心） |
| `backend/analyzer.py` | PDF／圖片 → 結構化報告（呼叫 Anthropic，模型 `claude-haiku-4-5`） |
| `backend/scheduler.py` | 排程同步 `_sync_job`、手動同步 `run_sync_now`、`SyncLog` 寫入 |
| `backend/routers/sync.py` | 同步相關 HTTP API（`/api/sync/*`） |
| `backend/models.py` | `DriveFile`、`Report`、`SyncLog` 資料表 |
| `backend/database.py` | 啟動時清理殘留的「進行中」同步記錄 |

---

## 1. 整體流程

```
Google Drive 資料夾（含子資料夾）
        │  Drive API v3（drive.readonly，服務帳號）
        ▼
list_pdf_files()      列出 PDF / 圖片（可用 createdTime 篩選起始日）
        │
        ▼
sync_drive() 逐檔迴圈
   ├─ 已在 drive_files 表 → 略過（skipped）
   ├─ download_file()  下載到記憶體（BytesIO）
   ├─ analyze_report() / analyze_image_file()   AI 解析
   ├─ 有結果 → 寫 reports；無結果 → 只記 no_report
   ├─ 寫 drive_files（標記已處理）並 commit
   └─ 例外 → rollback、errors+1、記錄檔名與錯誤（不寫 drive_files，下次會重試）
        │
        ▼
SyncLog 記錄本次結果 → notify_sync_done()（Telegram）
```

---

## 2. 認證與權限

- 使用 **服務帳號（Service Account）**，不是使用者 OAuth。
- 權限範圍（scope）：`https://www.googleapis.com/auth/drive.readonly`（唯讀）。
- 服務帳號要能存取資料夾，必須把資料夾**共用給服務帳號的 email**（至少檢視者）。Drive 是看「共用權限」，跟資料夾的擁有者是誰無關：轉移擁有權本身不會影響同步，只要服務帳號仍在共用名單內。
- 金鑰讀取順序（`get_drive_service()`）：
  1. 環境變數 `GOOGLE_CREDENTIALS_JSON`（整份 JSON 內容，**部署在 Render 用這個**）
  2. 否則讀檔案 `GOOGLE_CREDENTIALS_PATH`（預設 `./credentials.json`，本機開發用）
- `credentials.json` 已在 `.gitignore`，不要提交。

### 建立步驟

1. Google Cloud Console 建立專案，啟用 **Google Drive API**。
2. 建立服務帳號，下載 JSON 金鑰。
3. 在 Drive 把存放報告的資料夾共用給該服務帳號的 email（檢視者即可）。
4. 取得資料夾 ID（資料夾網址 `.../folders/<資料夾ID>`）。
5. 設定環境變數（見下節）。

---

## 3. 環境變數

| 變數 | 必填 | 說明 |
|---|---|---|
| `GOOGLE_DRIVE_FOLDER_ID` | 是 | 要同步的資料夾 ID；**可用逗號分隔多個**。未設定時同步會直接拋 `ValueError` |
| `GOOGLE_CREDENTIALS_JSON` | 二擇一 | 服務帳號金鑰 JSON 內容（Render dashboard 貼上，`render.yaml` 設為 `sync: false`） |
| `GOOGLE_CREDENTIALS_PATH` | 二擇一 | 金鑰檔路徑，預設 `./credentials.json` |
| `ANTHROPIC_API_KEY` | 是 | AI 解析用；餘額不足會讓同步中止（見第 7 節） |
| `DATABASE_PATH` | 否 | SQLite 路徑，Render 上為 `/app/data/investreport.db`（持久磁碟） |

> `VITE_GOOGLE_CLIENT_ID` 是網站「Google 登入」用的 OAuth client，與 Drive 同步無關。

---

## 4. 檔案探索（`list_pdf_files`）

- **支援類型**：`application/pdf`、`image/jpeg`、`image/png`、`image/webp`、`image/gif`（`image/jpg` 會正規化成 jpeg）。
- **遞迴子資料夾**，兩階段：
  1. **BFS 收集所有子資料夾 ID**：每個資料夾一次 `files.list`（`pageSize=1000`，`mimeType='application/vnd.google-apps.folder'`），循序執行。
  2. **批次查檔案**：每 50 個資料夾用 `OR` 合併成一個 query（`'<id>' in parents`），再加 `mimeType` 與 `trashed=false` 條件並分頁取回。
- **時間篩選**：傳入 `since`（`YYYY-MM-DD`，自動補成 `T00:00:00`）時加上 `createdTime >= '<since>'`。注意是**檔案在 Drive 的建立時間**，不是報告日期。
- 回傳欄位：`id, name, mimeType, createdTime`。
- 多個根資料夾時結果會以檔案 ID 去重。
- 沒有設定 `supportsAllDrives` / `includeItemsFromAllDrives`，因此**只支援「我的雲端硬碟」資料夾，不支援共用雲端硬碟（Shared Drive）**。若資料夾被搬進共用雲端硬碟，同步會找不到檔案。

### 下載（`download_file`）

`files.get_media` + `MediaIoBaseDownload` 分塊下載，**整份檔案放在記憶體**（`BytesIO`）後回傳 bytes，再交給分析。

---

## 5. 同步邏輯（`sync_drive`）

### 去重與重試語意

以 `drive_files.drive_file_id`（唯一）判斷是否處理過：

| 情況 | 是否寫入 `drive_files` | 下次同步 |
|---|---|---|
| 解析成功 → 寫 `reports` | 是 | 略過 |
| AI 回傳無結果（`no_report`） | **是** | 略過（可用「重新分析」補） |
| 處理時拋例外（下載失敗、API 錯誤、寫庫錯誤…） | **否** | **每次都會重試** |

因此「持續失敗」的檔案會在每次同步重複出現在 `errors` 裡，直到問題解決。

### 檔案解析（`analyzer.py`）

- **PDF**：先用 `pdfplumber` 抽前 20 頁文字，>10 頁的彙整報告改取第 2–6 頁（上限 10,000 字）；≤10 頁取前 12,000 字，送 Claude 解析。抽不到文字（掃描檔）或 pdfplumber 例外時，改用 `pdf2image` 轉前 3 頁圖片（dpi 150）走 Vision。
- **圖片檔**：直接送 Vision。送出前會檢查並縮圖：base64 ≤ 10 MB、長邊 ≤ 1568 px（超過就降畫質／縮尺寸重新編碼成 JPEG）。
- **輸出 schema**：`stock_code / stock_name / recommendation / target_price / analyst / report_date / summary / key_points / mentioned_stocks`。
- **容錯**（模型偶爾不守 schema）：回傳陣列時取第一個物件；`null` 的 `key_points`／`mentioned_stocks` 視為空；字串欄位被回傳成陣列時以頓號合併（`as_str`）。
- 沒有股票代號的視為 `MARKET`（市場新聞），不套用個股評等。
- 報告日期優先用 AI 解析值，失敗則從**檔名**解析（支援西元 8 碼、民國 6–7 碼，`extract_date_from_filename`）。

### 資料表

```
drive_files : id, drive_file_id(UNIQUE), filename, processed_at
reports     : id, drive_file_id, stock_code, stock_name, recommendation, target_price,
              analyst, report_date, summary, key_points(JSON), mentioned_stocks(JSON),
              source_filename, created_at, price_at_report, price_5d/10d/20d_before
sync_logs   : id, started_at, finished_at, trigger(scheduled|manual), processed, skipped,
              errors, no_report, new_reports, status(running|done|error), error_message
```

### 執行中的保護機制

- **取消**：迴圈每檔先檢查 `cancelled()`，被取消會提早回傳。
- **餘額不足**：偵測到錯誤字串含 `credit balance is too low` 立即中止，回傳 `warning`；`SyncLog` 會標成 `error` 並把警告寫進 `error_message`，且仍會發 Telegram 通知。
- **記憶體**：每處理 10 筆主動 `gc.collect()`；排程用單執行緒池（`max_workers=1`），避免多個排程同時跑撐爆 Render Starter（512 MB）。
- **進度**：同步中更新共用的 progress dict（`running / current / processed / skipped / errors / total / no_report`），供 `/api/sync/progress` 與前端進度小工具讀取。

---

## 6. 排程與觸發

| 方式 | 說明 |
|---|---|
| 排程 | `scheduler.py` 的 `_sync_job`，cron `hour="20,1,6,12"`、`minute=0`、時區 `Asia/Taipei`，**實際為每天 01:00／06:00／12:00／20:00**（程式內註解寫 04/09/14/20 已過時，以 cron 設定為準）。排程只同步**最近 30 天**建立的檔案（`since = 今天 − 30 天`）。 |
| 手動 | 後台「全量同步」或 `POST /api/sync`。不帶 `since` 即掃全部檔案（慢）；帶 `since=YYYY-MM-DD` 只掃該日之後。已有同步進行中回 `409`。 |
| 重新分析 | 對「已在 `drive_files` 但沒有對應 `reports`」的檔案重跑 AI（`POST /api/sync/reanalyze?limit=N`，admin；預設 200、上限 500；後台按鈕一次 50）。 |

啟動時（`database.py` → `_cleanup_stale_syncs`）會把殘留 `running` 的記錄改成 `error`、訊息「服務重啟，同步中斷」——部署新版（Render 自動重啟）時若剛好在同步，就會看到這個訊息。已處理完的檔案已 commit，不會遺失，重跑一次即可接續。

---

## 7. 同步 API（前綴 `/api/sync`）

| 方法 | 路徑 | 權限 | 說明 |
|---|---|---|---|
| GET | `/status` | 無 | 最近一次同步結果（記憶體中） |
| GET | `/progress` | 無 | 即時進度 `{running, current, processed, skipped, errors, total}` |
| POST | `` | admin | 觸發同步，query：`since`（選填） |
| POST | `/cancel` | admin | 中止進行中的同步 |
| GET | `/history?limit=20` | 無 | 最近同步記錄（含 `error_message`） |
| GET | `/no-report-count` | admin | 有 `drive_files` 但沒 `reports` 的數量 |
| GET | `/no-report-files` | admin | 上述檔案清單（分頁） |
| GET | `/drive-files` | admin | 雲端檔案明細（狀態／關鍵字／分頁） |
| POST | `/reanalyze` | admin | 重新分析無結果檔案 |
| POST | `/reanalyze-test` | admin | 同步分析 1 個無結果檔案並直接回傳結果（debug） |

`/status`、`/progress`、`/history` 為公開唯讀；會觸發或中止同步、或讀取檔案明細的端點都需要管理員 token（前端 axios 已自動帶 `Authorization: Bearer`）。

---

## 8. 其他用到 Drive 的地方

- 每日草稿的「資料來源」連結：用 `reports.drive_file_id` 組成 `https://drive.google.com/file/d/<fileId>/view` 當作引用報告的連結（`routers/publish.py`）。這是一般的 Drive 檢視連結，點開需要對方本身有該檔案的存取權。

---

## 9. 效能與配額注意

- 列檔是**循序**的：每個子資料夾一次 API 呼叫，資料夾很多時第一階段就要數十秒到數分鐘（實測約 100 個子資料夾 ≈ 1 分鐘）。
- 全量同步會一路比對所有檔案，已處理的快速略過，但新檔案需要逐一下載＋呼叫 AI，耗時與成本隨檔案數線性成長。
- 短時間重複大量呼叫 Drive API 可能被限流（體感會變慢，不一定有明確錯誤）。
- AI 費用在 Anthropic 帳戶，餘額用完會讓每次同步一開始就中止。

---

## 10. 疑難排解

| 症狀 | 可能原因 | 處理 |
|---|---|---|
| 同步記錄「處理 0、錯誤 1」，且一直重複 | Anthropic 餘額不足 | 到 console.anthropic.com 儲值；後台現在會顯示紅色「失敗」與原因 |
| `GOOGLE_DRIVE_FOLDER_ID not set` | 未設資料夾 ID | 設定環境變數 |
| 同步找不到任何檔案 / 403 / 404 | 服務帳號不在共用名單、資料夾被搬進共用雲端硬碟、資料夾 ID 錯誤 | 重新共用給服務帳號；確認資料夾在「我的雲端硬碟」；核對 ID |
| 某幾個檔案每次都報錯 | 失敗檔不會標記已處理，會重試 | 看「完成」列下方琥珀色警示的檔名與錯誤訊息；常見：圖片超過 Anthropic 限制（已自動縮圖）、PDF 格式異常（已自動退回 Vision）、模型回傳格式偏離 schema（已做容錯） |
| 「服務重啟，同步中斷」 | 同步期間服務被重啟（多為部署） | 再跑一次，已處理檔案會略過 |
| 同步很慢／記憶體不足（OOM） | 檔案多、PDF 轉圖吃記憶體、多排程重疊 | 排程已序列化並定期 GC；仍不足時考慮升級 Render 方案 |

### 快速自我檢查（本機）

```bash
cd backend && source venv/bin/activate
python - <<'EOF'
from dotenv import dotenv_values; import os
os.environ.update({k: v for k, v in dotenv_values(".env").items() if v})
from drive_sync import get_drive_service
s = get_drive_service()
fid = os.environ["GOOGLE_DRIVE_FOLDER_ID"].split(",")[0].strip()
print(s.files().get(fileId=fid, fields="id,name,driveId,owners,trashed").execute())
EOF
```

能印出資料夾名稱且沒有 `driveId`，代表服務帳號可存取，且資料夾在「我的雲端硬碟」。

---

## 11. 已知限制

- 不支援共用雲端硬碟（Shared Drive）。
- 檔案下載與子資料夾掃描皆為循序，無併發。
- 排程只看最近 30 天建立的檔案；更早漏掉的需手動「全量同步」或指定 `since`。
- 持續失敗的檔案沒有失敗次數上限，會無限重試（需人工排查）。
- 下載整份檔案進記憶體，超大 PDF 會增加記憶體壓力。

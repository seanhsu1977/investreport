# 台股概念股輪動圖 — Standalone Demo

跟 [`packages/sector-rotation/`](../sector-rotation/README.md) 是同一個功能，
但這裡是**可以真的獨立跑起來**的版本：拿掉了 investreport 主專案的資料庫、
登入系統、排程器，只留下輪動圖需要的最小後端 + 前端。演算法設計、象限定義、
X 軸從絕對金額到 log2 比例偏離的推導過程，請看上一層資料夾的 README，這裡
不重複寫。

跟主專案版本唯一的邏輯差異：`/api/stocks/sector-rotation/ask`（AI 問答）拿掉了
登入驗證，因為這個 demo 沒有使用者系統。

```
sector-rotation-standalone/
├── README.md
├── backend/
│   ├── main.py              最小 FastAPI app（CORS + 掛載 router + /health）
│   ├── sector_rotation.py   輪動圖計算邏輯 + 2 個 API endpoint
│   ├── nstock.py            nstock API 存取（get_daily 等，複製自主專案）
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    ├── index.html / package.json / vite.config.ts / tailwind.config.js / tsconfig.json
    └── src/
        ├── main.tsx              React 進入點
        ├── App.tsx               路由：/ 顯示輪動圖，/stocks/:code 顯示佔位頁
        ├── index.css             Tailwind 基底
        ├── api/client.ts         axios instance + sectorRotation()
        └── pages/
            ├── SectorRotationPage.tsx   主元件（跟主專案完全一樣，未修改）
            └── StockStub.tsx            點擊個股後的佔位頁（主專案的個股頁沒有一起打包）
```

## 快速開始

需要 Python 3.9+ 和 Node 18+。

### 1. 後端

```bash
cd backend
python3 -m venv venv
source venv/bin/activate      # Windows 用 venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env          # 選填：要用 AI 問答功能才需要填 GEMINI_API_KEY
uvicorn main:app --reload --port 8000
```

確認 `http://localhost:8000/health` 回傳 `{"status":"ok"}`。

### 2. 前端

另開一個終端機：

```bash
cd frontend
npm install
npm run dev
```

瀏覽器打開 `http://localhost:5173`，應該會看到泡泡圖。第一次載入會顯示
「計算中」，因為後端要即時去 nstock API 抓 23 個族群、上百支個股的日K
資料再加總，通常需要 30 秒到 2 分鐘，之後有 4 小時快取。

> 前端 `vite.config.ts` 的 proxy 預設打 `http://localhost:8000`；如果你把
> 後端跑在別的 port，記得同步改這裡。

## 跟主專案的差異

| 項目 | 主專案 | 這個 standalone 版 |
|---|---|---|
| 資料庫 | SQLite（存報告、使用者等） | 無，資料只存在記憶體快取 |
| 登入 | Google OAuth + JWT | 無，`/sector-rotation/ask` 拿掉了 `Depends(get_current_user)` |
| 個股頁 `/stocks/:code` | 完整的 K線＋KDJ＋籌碼頁面 | 只有一個佔位頁 |
| 排程器 | APScheduler 背景排程多個工作 | 無，輪動圖資料完全靠 request 觸發＋記憶體快取 |
| 其他頁面（自選股、排行…） | 有 | 無，只有這一個功能 |

## 已知限制

跟主專案版本共通的限制（nstock API 穩定性、白名單族群清單需手動維護、
log2 比例在低成交量族群的可讀性等）記錄在
[`packages/sector-rotation/README.md`](../sector-rotation/README.md#已知限制)，
不重複列。這裡額外要注意：

- 沒有登入系統，`ask` 端點是完全開放的，串流呼叫 Gemini API 會消耗你自己的
  `GEMINI_API_KEY` 額度，不要公開部署這個 demo 除非你知道自己在做什麼
- 沒有排程器預熱快取，每次重啟後端第一個打進來的請求都要重新等一次完整計算

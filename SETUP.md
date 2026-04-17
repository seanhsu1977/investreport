# 投顧報告系統 - 設定說明

## 1. Google Drive 服務帳號設定

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 建立新專案，啟用 **Google Drive API**
3. 建立「服務帳號」(Service Account)，下載 JSON 金鑰
4. 將 JSON 金鑰存為 `backend/credentials.json`
5. 在 Google Drive 中，**將存放 PDF 的資料夾共享給服務帳號的 Email**（只需閱讀權限）
6. 複製該資料夾的 ID（網址列 `/folders/` 後的字串）

## 2. 環境變數

```bash
cp .env.example backend/.env
```

編輯 `backend/.env`：
```
GOOGLE_DRIVE_FOLDER_ID=<資料夾ID>
GOOGLE_CREDENTIALS_PATH=./credentials.json
ANTHROPIC_API_KEY=<你的 Anthropic API Key>
DATABASE_PATH=./investreport.db
```

## 3. 後端啟動

```bash
cd backend
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

API 文件：http://localhost:8000/docs

## 4. 前端啟動

```bash
cd frontend
npm install
npm run dev
```

開啟：http://localhost:5173

## 5. 使用方式

1. 啟動後端後，點選右上角「立即同步」或等待每小時自動同步
2. 同步完成後，在搜尋框輸入股票代碼或名稱
3. 點「+ 加入」加入自選股
4. 首頁顯示每支自選股的最新投資建議
5. 點股票代碼進入個股頁，查看所有歷史報告

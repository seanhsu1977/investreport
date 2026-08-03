"""
輪動圖 standalone demo — 最小 FastAPI 進入點。

跟主專案不同，這裡沒有資料庫、沒有登入系統、沒有排程器，只掛載
sector_rotation.router 這一個功能。跑法見上層資料夾 README.md。
"""
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import sector_rotation

app = FastAPI(title="Sector Rotation Standalone")

# Vite dev server 預設 5173；開發模式下允許跨來源呼叫
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sector_rotation.router)


@app.get("/health")
async def health():
    return {"status": "ok"}

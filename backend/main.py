import logging
import os
from contextlib import asynccontextmanager
from dotenv import load_dotenv

load_dotenv(override=True)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from database import init_db
from scheduler import start_scheduler, stop_scheduler
from routers import stocks, watchlist, sync, chips
from routers import auth, admin, publish

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    start_scheduler()
    from notifier import start_polling, stop_polling
    start_polling()
    yield
    stop_polling()
    stop_scheduler()


app = FastAPI(title="投顧報告系統", lifespan=lifespan)

_origins_env = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000")
origins = [o.strip() for o in _origins_env.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(stocks.router, prefix="/api")
app.include_router(watchlist.router, prefix="/api")
app.include_router(sync.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(admin.router, prefix="/api")
app.include_router(publish.router, prefix="/api")
app.include_router(chips.router, prefix="/api")


@app.get("/healthz")
def health():
    return {"status": "ok"}


# Serve React frontend — must be mounted last so API routes take priority
_static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(_static_dir):
    logging.info("Static dir found at %s — serving React app", _static_dir)

    # Catch-all: serve index.html for any non-API path (SPA client-side routing)
    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        index = os.path.join(_static_dir, "index.html")
        asset = os.path.join(_static_dir, full_path)
        # 有對應實體檔案（JS/CSS/圖片）就直接回傳，否則回傳 index.html
        if full_path and os.path.isfile(asset):
            return FileResponse(asset)
        return FileResponse(index)

    app.mount("/assets", StaticFiles(directory=os.path.join(_static_dir, "assets")), name="assets")
else:
    logging.warning("Static dir NOT found at %s — frontend will not be served", _static_dir)

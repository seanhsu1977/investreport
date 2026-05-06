import asyncio
from typing import Optional
from fastapi import APIRouter, BackgroundTasks, Depends, Query
from sqlalchemy.orm import Session
from scheduler import get_last_sync_result, get_sync_progress, cancel_sync
from database import get_db
from models import SyncLog

router = APIRouter(prefix="/sync", tags=["sync"])


@router.get("/status")
def sync_status():
    """取得最後一次同步狀態"""
    result = get_last_sync_result()
    return result if result else {"status": "never_synced"}


@router.get("/progress")
def sync_progress():
    """取得同步即時進度"""
    return get_sync_progress()


@router.post("")
async def trigger_sync(
    background_tasks: BackgroundTasks,
    since: Optional[str] = Query(None, description="只同步此日期後的檔案，格式 YYYY-MM-DD"),
):
    """手動觸發立即同步（在獨立執行緒背景執行，不阻塞 API）"""
    background_tasks.add_task(_do_sync_async, since)
    return {"status": "sync_started", "since": since}


@router.get("/history")
def sync_history(limit: int = Query(default=20, ge=1, le=100), db: Session = Depends(get_db)):
    """最近 N 筆同步記錄（由新到舊）"""
    rows = (
        db.query(SyncLog)
        .order_by(SyncLog.started_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": r.id,
            "started_at": r.started_at,
            "finished_at": r.finished_at,
            "trigger": r.trigger,
            "processed": r.processed,
            "skipped": r.skipped,
            "errors": r.errors,
            "new_reports": r.new_reports,
            "status": r.status,
            "error_message": r.error_message,
        }
        for r in rows
    ]


@router.post("/cancel")
def cancel_sync_endpoint():
    """中止正在進行的同步"""
    cancel_sync()
    return {"status": "cancelling"}


async def _do_sync_async(since: Optional[str] = None):
    """在執行緒池跑同步，避免 block FastAPI 事件迴圈"""
    await asyncio.to_thread(_do_sync, since)


def _do_sync(since: Optional[str] = None):
    from database import SessionLocal
    from scheduler import run_sync_now as _run
    db = SessionLocal()
    try:
        _run(db, since=since)
    finally:
        db.close()


@router.get("/telegram")
def telegram_setup():
    """查詢 Telegram Chat ID，並發送測試訊息確認設定是否正確"""
    import os
    import httpx

    token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "")

    if not token:
        return {"ok": False, "error": "TELEGRAM_BOT_TOKEN 尚未設定"}

    # 從 getUpdates 找 chat_id
    try:
        resp = httpx.get(f"https://api.telegram.org/bot{token}/getUpdates", timeout=10)
        data = resp.json()
        if not data.get("ok"):
            return {"ok": False, "error": f"Bot Token 無效: {data.get('description')}"}

        results = data.get("result", [])
        found_ids = list({
            str(msg["message"]["chat"]["id"])
            for msg in results
            if "message" in msg and "chat" in msg["message"]
        })
    except Exception as e:
        return {"ok": False, "error": f"無法連線 Telegram: {e}"}

    if not found_ids:
        return {
            "ok": False,
            "error": "找不到任何對話記錄",
            "hint": "請先對你的 Bot 發一則訊息（任意文字），再重新呼叫此 API",
        }

    # 若 .env 已有設定，發測試訊息
    if chat_id:
        from notifier import send_message
        ok = send_message("✅ Telegram 通知設定成功！投顧報告同步完成時會自動通知你。")
        return {"ok": ok, "chat_id": chat_id, "test_sent": True}

    return {
        "ok": True,
        "found_chat_ids": found_ids,
        "hint": f"請將 TELEGRAM_CHAT_ID={found_ids[0]} 填入 .env 後重啟後端",
    }

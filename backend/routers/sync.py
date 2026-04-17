import asyncio
from fastapi import APIRouter, BackgroundTasks
from scheduler import get_last_sync_result, get_sync_progress, cancel_sync

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
async def trigger_sync(background_tasks: BackgroundTasks):
    """手動觸發立即同步（在獨立執行緒背景執行，不阻塞 API）"""
    background_tasks.add_task(_do_sync_async)
    return {"status": "sync_started"}


@router.post("/cancel")
def cancel_sync_endpoint():
    """中止正在進行的同步"""
    cancel_sync()
    return {"status": "cancelling"}


async def _do_sync_async():
    """在執行緒池跑同步，避免 block FastAPI 事件迴圈"""
    await asyncio.to_thread(_do_sync)


def _do_sync():
    from database import SessionLocal
    from scheduler import run_sync_now as _run
    db = SessionLocal()
    try:
        _run(db)
    finally:
        db.close()

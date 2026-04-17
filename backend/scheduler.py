from __future__ import annotations
import logging
from apscheduler.schedulers.background import BackgroundScheduler
from database import SessionLocal
from drive_sync import sync_drive

logger = logging.getLogger(__name__)

_last_sync_result: dict | None = None
_sync_progress: dict = {"running": False}
_sync_cancelled: bool = False
scheduler = BackgroundScheduler()


def _sync_job():
    global _last_sync_result, _sync_progress, _sync_cancelled
    logger.info("Starting scheduled Drive sync...")
    _sync_cancelled = False
    _sync_progress = {"running": True, "current": "", "processed": 0, "skipped": 0, "errors": 0, "total": 0}
    db = SessionLocal()
    try:
        _last_sync_result = sync_drive(db, progress=_sync_progress, cancelled=lambda: _sync_cancelled)
        logger.info(f"Sync completed: {_last_sync_result}")
    except Exception as e:
        logger.error(f"Sync failed: {e}")
        _last_sync_result = {"error": str(e)}
    finally:
        _sync_progress["running"] = False
        db.close()


def start_scheduler():
    scheduler.add_job(_sync_job, "cron", hour=20, minute=0, id="drive_sync")
    scheduler.start()
    logger.info("Scheduler started (daily at 20:00)")


def stop_scheduler():
    scheduler.shutdown()


def get_last_sync_result() -> dict | None:
    return _last_sync_result


def get_sync_progress() -> dict:
    return _sync_progress


def run_sync_now(db) -> dict:
    global _sync_progress, _sync_cancelled
    _sync_cancelled = False
    _sync_progress = {"running": True, "current": "", "processed": 0, "skipped": 0, "errors": 0, "total": 0}
    result = sync_drive(db, progress=_sync_progress, cancelled=lambda: _sync_cancelled)
    _sync_progress["running"] = False
    return result


def cancel_sync():
    global _sync_cancelled
    _sync_cancelled = True

from __future__ import annotations
import json
import logging
from datetime import date, datetime
from apscheduler.schedulers.background import BackgroundScheduler
from database import SessionLocal
from drive_sync import sync_drive
from models import FuturesChip
import taifex

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


def _chips_job():
    """每日台股收盤後抓期交所籌碼面"""
    logger.info("Starting daily chips fetch...")
    db = SessionLocal()
    try:
        today = date.today()
        try:
            snap = taifex.build_chip_snapshot(today.strftime("%Y/%m/%d"))
        except Exception as e:
            logger.warning("Chips fetch for %s failed: %s", today, e)
            snap = None
        if snap:
            iso = today.isoformat()
            existing = db.get(FuturesChip, iso)
            payload = json.dumps(snap, ensure_ascii=False)
            if existing:
                existing.payload = payload
                existing.updated_at = datetime.utcnow()
            else:
                db.add(FuturesChip(date=iso, payload=payload))
            db.commit()
            logger.info("Chips snapshot saved for %s", iso)
        else:
            logger.info("No chips data for %s (likely non-trading day)", today)
    finally:
        db.close()


def start_scheduler():
    scheduler.add_job(_sync_job, "cron", hour=20, minute=0, id="drive_sync")
    # 期交所三大法人 ~15:00 公布；保險點 15:45 (Asia/Taipei) Mon-Fri
    scheduler.add_job(
        _chips_job, "cron",
        day_of_week="mon-fri", hour=15, minute=45, timezone="Asia/Taipei",
        id="chips_fetch",
    )
    scheduler.start()
    logger.info("Scheduler started (drive 20:00, chips 15:45 Mon-Fri)")


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

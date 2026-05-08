from __future__ import annotations
import json
import logging
from datetime import date, datetime, timezone
from apscheduler.schedulers.background import BackgroundScheduler
from database import SessionLocal
from drive_sync import sync_drive
from models import Report, FuturesChip, SyncLog
import taifex

logger = logging.getLogger(__name__)

_last_sync_result: dict | None = None
_sync_progress: dict = {"running": False}
_sync_cancelled: bool = False
scheduler = BackgroundScheduler()


def _fetch_new_reports(db, since: datetime) -> list[dict]:
    rows = db.query(Report).filter(Report.created_at >= since).order_by(Report.created_at).all()
    return [
        {
            "stock_code": r.stock_code,
            "stock_name": r.stock_name,
            "recommendation": r.recommendation,
            "target_price": r.target_price,
            "summary": r.summary,
        }
        for r in rows
    ]


def _save_sync_log(db, log: SyncLog, result: dict | None, error: str | None = None):
    log.finished_at = datetime.utcnow()
    if error:
        log.status = "error"
        log.error_message = error
    else:
        log.status = "done"
        log.processed = result.get("processed", 0)
        log.skipped = result.get("skipped", 0)
        log.errors = result.get("errors", 0)
        log.no_report = result.get("no_report", 0)
    db.commit()


def _sync_job():
    global _last_sync_result, _sync_progress, _sync_cancelled
    if _sync_progress.get("running"):
        logger.warning("Scheduled sync skipped — another sync is already running")
        return
    logger.info("Starting scheduled Drive sync...")
    _sync_cancelled = False
    _sync_progress = {"running": True, "current": "", "processed": 0, "skipped": 0, "errors": 0, "total": 0}
    db = SessionLocal()
    sync_start = datetime.now(timezone.utc).replace(tzinfo=None)
    log = SyncLog(started_at=sync_start, trigger="scheduled", status="running")
    db.add(log)
    db.commit()
    try:
        _last_sync_result = sync_drive(db, progress=_sync_progress, cancelled=lambda: _sync_cancelled)
        logger.info(f"Sync completed: {_last_sync_result}")
        from notifier import notify_sync_done
        new_reports = _fetch_new_reports(db, sync_start)
        log.new_reports = len(new_reports)
        _save_sync_log(db, log, _last_sync_result)
        notify_sync_done(_last_sync_result, new_reports)
    except Exception as e:
        logger.error(f"Sync failed: {e}")
        _last_sync_result = {"error": str(e)}
        _save_sync_log(db, log, None, error=str(e))
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


def _daily_article_job():
    """ETF小百科 ~19:30 發 00981A 操作明細，保險點 19:45 觸發草稿生成"""
    logger.info("Starting daily article generation...")
    try:
        from daily_article import generate_for_date
        aid = generate_for_date()
        logger.info("Daily article generated: id=%s", aid)
    except Exception as e:
        logger.exception("Daily article job failed: %s", e)


def start_scheduler():
    scheduler.add_job(_sync_job, "cron", hour=20, minute=0, id="drive_sync")
    # 期交所三大法人 ~15:00 公布；保險點 15:45 (Asia/Taipei) Mon-Fri
    scheduler.add_job(
        _chips_job, "cron",
        day_of_week="mon-fri", hour=15, minute=45, timezone="Asia/Taipei",
        id="chips_fetch",
    )
    # ETF小百科 ~19:30 發 00981A 明細；保險點 19:45 (Asia/Taipei) Mon-Fri
    scheduler.add_job(
        _daily_article_job, "cron",
        day_of_week="mon-fri", hour=19, minute=45, timezone="Asia/Taipei",
        id="daily_article",
    )
    scheduler.start()
    logger.info("Scheduler started (drive 20:00, chips 15:45, daily_article 19:45 Mon-Fri)")


def stop_scheduler():
    scheduler.shutdown()


def get_last_sync_result() -> dict | None:
    return _last_sync_result


def get_sync_progress() -> dict:
    return _sync_progress


def run_sync_now(db, since: str | None = None) -> dict:
    global _sync_progress, _sync_cancelled
    if _sync_progress.get("running"):
        raise RuntimeError("已有同步在進行中，請等待完成後再試")
    _sync_cancelled = False
    _sync_progress = {"running": True, "current": "", "processed": 0, "skipped": 0, "errors": 0, "total": 0}
    sync_start = datetime.now(timezone.utc).replace(tzinfo=None)
    log = SyncLog(started_at=sync_start, trigger="manual", status="running")
    db.add(log)
    db.commit()
    try:
        result = sync_drive(db, progress=_sync_progress, cancelled=lambda: _sync_cancelled, since=since)
        _sync_progress["running"] = False
        from notifier import notify_sync_done
        new_reports = _fetch_new_reports(db, sync_start)
        log.new_reports = len(new_reports)
        _save_sync_log(db, log, result)
        notify_sync_done(result, new_reports)
        return result
    except Exception as e:
        _sync_progress["running"] = False
        _save_sync_log(db, log, None, error=str(e))
        raise


def cancel_sync():
    global _sync_cancelled
    _sync_cancelled = True

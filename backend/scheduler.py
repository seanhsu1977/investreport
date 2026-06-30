from __future__ import annotations
import json
import logging
from datetime import date, datetime, timedelta, timezone
from apscheduler.schedulers.background import BackgroundScheduler
from database import SessionLocal
from drive_sync import sync_drive
from models import Report, FuturesChip, SyncLog, MarketTechnicalSnapshot
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
    # 只同步最近 30 天的新檔案，避免遞迴掃全部資料夾觸發 Drive API rate limit
    from datetime import timedelta
    since = (sync_start - timedelta(days=30)).strftime("%Y-%m-%d")
    try:
        _last_sync_result = sync_drive(db, progress=_sync_progress, cancelled=lambda: _sync_cancelled, since=since)
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


def _market_technical_job():
    """每日 14:45 收盤後存大盤技術指標快照（加權 + 上櫃）"""
    logger.info("Saving market technical snapshots...")
    db = SessionLocal()
    try:
        from routers.stocks import save_market_technical
        for idx in ("taiex", "twoii"):
            try:
                save_market_technical(index=idx, db=db)
                logger.info("Market technical snapshot saved: %s", idx)
            except Exception as e:
                logger.warning("Market technical snapshot failed for %s: %s", idx, e)
    finally:
        db.close()


def _recommendations_warmup_job():
    """每天 07:00 Asia/Taipei 預算投顧精選快取，使用者開頁面不需等待"""
    import asyncio
    logger.info("Starting recommendations warmup...")
    combos = [
        (30, 1, "all", 20),
        (30, 2, "all", 20),
        (60, 1, "all", 20),
        (60, 2, "all", 20),
        (30, 1, "all", 50),
        (90, 1, "all", 20),
    ]

    async def _run_sequential():
        from routers.stocks import _compute_recommendations_bg
        for d, m, f, l in combos:
            try:
                await _compute_recommendations_bg(f"{d}_{m}_{f}_{l}", d, m, f, l)
            except Exception as e:
                logger.warning("Warmup combo (%d,%d,%s,%d) failed: %s", d, m, f, l, e)

    asyncio.run(_run_sequential())
    logger.info("Recommendations warmup complete")


def _kdj_screen_job(quick: bool = False):
    """KDJ 訊號掃描並寫入快取。
    quick=True：僅掃自選股（手動觸發用，速度快）；False：含 ETF 成份股（排程用）。
    """
    import asyncio
    import json as _json
    from datetime import timezone, timedelta

    logger.info("Starting KDJ screen job (quick=%s)...", quick)
    db = SessionLocal()
    try:
        from models import Watchlist, EtfDailyChange, KdjScreenCache
        from price_analysis import get_signals

        wl_codes = {r.stock_code for r in db.query(Watchlist.stock_code).all()}

        if quick:
            code_list = sorted(wl_codes)
            etf_names: dict = {}
        else:
            etf_rows = (
                db.query(EtfDailyChange.stock_code, EtfDailyChange.stock_name)
                .filter(EtfDailyChange.etf_code.in_(["00981A", "00403A"]))
                .distinct(EtfDailyChange.stock_code).all()
            )
            etf_codes = {r.stock_code for r in etf_rows}
            etf_names = {r.stock_code: r.stock_name for r in etf_rows}
            priority = list(wl_codes) + [c for c in etf_codes if c not in wl_codes]
            code_list = priority[:350]

        name_map: dict = {}
        for code in code_list:
            name_map[code] = etf_names.get(code)
            if not name_map[code]:
                row = (db.query(Report.stock_name).filter(Report.stock_code == code)
                       .order_by(Report.created_at.desc()).first())
                name_map[code] = row[0] if row else None

        semaphore = asyncio.Semaphore(8)

        async def fetch_one(code):
            async with semaphore:
                try:
                    sig = await asyncio.to_thread(get_signals, code)
                except Exception:
                    sig = None
                return code, sig

        async def run_all():
            return await asyncio.gather(*[fetch_one(c) for c in code_list])

        results = asyncio.run(run_all())

        CROSS_SIGNALS = {"低位金叉", "金叉", "低位死叉", "高位死叉", "死叉"}
        J_SIGNALS = {"J回升", "J超賣", "J轉弱", "J超買"}
        SIGNAL_ORDER = {"低位金叉": 0, "金叉": 1, "低位死叉": 2, "死叉": 3, "高位死叉": 4}
        J_SIGNAL_ORDER = {"J回升": 0, "J超賣": 1, "J轉弱": 2, "J超買": 3}

        items = []
        for code, sig in results:
            if not sig:
                continue
            has_kdj = sig.get("kdj_signal") in CROSS_SIGNALS
            has_j = sig.get("j_signal") in J_SIGNALS
            if not has_kdj and not has_j:
                continue
            items.append({
                "code": code,
                "name": name_map.get(code),
                "current_price": sig.get("current_price"),
                "kdj_k": sig.get("kdj_k"),
                "kdj_d": sig.get("kdj_d"),
                "kdj_j": sig.get("kdj_j"),
                "kdj_signal": sig.get("kdj_signal") if has_kdj else None,
                "kdj_cross_days": sig.get("kdj_cross_days"),
                "j_signal": sig.get("j_signal"),
                "j_cross_days": sig.get("j_cross_days"),
                "ma_signal": sig.get("ma_signal"),
                "rsi": sig.get("rsi"),
            })
        items.sort(key=lambda x: (
            J_SIGNAL_ORDER.get(x.get("j_signal"), 9),
            SIGNAL_ORDER.get(x.get("kdj_signal"), 9),
            x.get("j_cross_days") if x.get("j_cross_days") is not None else 99,
            x.get("kdj_cross_days") if x.get("kdj_cross_days") is not None else 99,
            x.get("kdj_k") or 99,
        ))

        # 台北時間
        tpe = timezone(timedelta(hours=8))
        now_tpe = datetime.now(tpe)
        cache_row = KdjScreenCache(
            computed_at=now_tpe.strftime("%Y-%m-%d %H:%M"),
            data_date=now_tpe.strftime("%Y-%m-%d"),
            scanned=len(code_list),
            items_json=_json.dumps(items, ensure_ascii=False),
        )
        db.add(cache_row)
        # 只保留最近 5 筆，避免表格無限增長
        old_rows = (db.query(KdjScreenCache)
                    .order_by(KdjScreenCache.id.desc())
                    .offset(5).all())
        for r in old_rows:
            db.delete(r)
        db.commit()
        logger.info("KDJ screen job done: scanned=%d, hits=%d", len(code_list), len(items))
    except Exception as e:
        logger.exception("KDJ screen job failed: %s", e)
    finally:
        db.close()


def _etf_tracker_job():
    """每週一至五 20:00 同步 00981A + 00403A 當日成份股變化。
    nstock ETF小百科約 19:30 發布，20:00 抓取保險。"""
    logger.info("Starting ETF tracker sync job...")
    db = SessionLocal()
    try:
        from routers.etf_tracker import _sync_one, ETF_CONFIG
        tpe_now = datetime.now(timezone(timedelta(hours=8)))
        date_str = tpe_now.strftime("%Y-%m-%d")
        for etf in ETF_CONFIG:
            try:
                result = _sync_one(etf, date_str, db)
                logger.info("ETF tracker synced %s %s: %s", etf, date_str, result)
            except Exception as e:
                logger.warning("ETF tracker sync failed for %s: %s", etf, e)
    finally:
        db.close()


def start_scheduler():
    # Drive 同步：每天 4 次（台北時間 04:00 / 09:00 / 14:00 / 20:00）
    # 04:00 → 抓凌晨上傳；09:00 → 抓早盤前投顧報告；14:00 → 抓午間；20:00 → 抓盤後
    scheduler.add_job(_sync_job, "cron", hour="20,1,6,12", minute=0, timezone="Asia/Taipei", id="drive_sync")
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
    # ETF 追蹤同步：nstock 約 19:30 發布，20:00 抓取保險 Mon-Fri
    scheduler.add_job(
        _etf_tracker_job, "cron",
        day_of_week="mon-fri", hour=20, minute=0, timezone="Asia/Taipei",
        id="etf_tracker_sync",
    )
    # 大盤技術指標快照：每天 14:45（收盤後）Mon-Fri
    scheduler.add_job(
        _market_technical_job, "cron",
        day_of_week="mon-fri", hour=14, minute=45, timezone="Asia/Taipei",
        id="market_technical",
    )
    # KDJ 選股快取：每天 15:30（收盤後）Mon-Fri
    scheduler.add_job(
        _kdj_screen_job, "cron",
        day_of_week="mon-fri", hour=15, minute=30, timezone="Asia/Taipei",
        id="kdj_screen",
    )
    # 投顧精選預算快取：每天 07:00 Asia/Taipei（含六日，因用戶週末也會看）
    scheduler.add_job(
        _recommendations_warmup_job, "cron",
        hour=7, minute=0, timezone="Asia/Taipei",
        id="rec_warmup",
    )
    scheduler.start()
    logger.info("Scheduler started (drive sync 04:00/09:00/14:00/20:00 Taipei, chips 15:45, market_technical 14:45, daily_article 19:45 Mon-Fri, rec_warmup 07:00 daily)")


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

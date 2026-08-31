import asyncio
from typing import Optional
from fastapi import APIRouter, BackgroundTasks, Depends, Query
from sqlalchemy.orm import Session
from scheduler import get_last_sync_result, get_sync_progress, cancel_sync
from database import get_db
from models import DriveFile, Report, SyncLog
from routers.auth import require_admin

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
    from fastapi import HTTPException
    if get_sync_progress().get("running"):
        raise HTTPException(status_code=409, detail="已有同步在進行中，請等待完成後再試")
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
            "no_report": r.no_report or 0,
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


@router.get("/no-report-count")
def no_report_count(db: Session = Depends(get_db), _=Depends(require_admin)):
    """查詢 DriveFile 中沒有對應 Report 的檔案數量"""
    total = db.query(DriveFile).count()
    with_report = db.query(DriveFile).join(
        Report, DriveFile.drive_file_id == Report.drive_file_id
    ).count()
    return {"total_drive_files": total, "without_report": total - with_report}


@router.get("/no-report-files")
def no_report_files(
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """列出沒有對應 Report 的 DriveFile（分頁）"""
    has_report = db.query(Report.drive_file_id).distinct().subquery()
    q = db.query(DriveFile).filter(DriveFile.drive_file_id.notin_(has_report))
    total = q.count()
    rows = q.order_by(DriveFile.id.desc()).offset(offset).limit(limit).all()
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "files": [
            {
                "drive_file_id": f.drive_file_id,
                "filename": f.filename,
                "modified_at": f.modified_at,
            }
            for f in rows
        ],
    }


@router.get("/drive-files")
def drive_files_list(
    status: str = Query(default="all"),   # all | synced | no_result
    q: str = Query(default=""),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """列出雲端硬碟所有檔案及同步狀態（已分析 / 無結果），可搜尋、篩選、分頁。"""
    from sqlalchemy import func, case, String
    from sqlalchemy.orm import aliased

    # 每個 drive_file_id 對應的第一筆 Report（取最早 id）
    rep_sub = (
        db.query(
            Report.drive_file_id,
            func.min(Report.id).label("min_id"),
        )
        .group_by(Report.drive_file_id)
        .subquery()
    )
    rep = aliased(Report)

    q_base = (
        db.query(DriveFile, rep)
        .outerjoin(rep_sub, DriveFile.drive_file_id == rep_sub.c.drive_file_id)
        .outerjoin(rep, rep.id == rep_sub.c.min_id)
    )

    if status == "synced":
        q_base = q_base.filter(rep_sub.c.min_id.isnot(None))
    elif status == "no_result":
        q_base = q_base.filter(rep_sub.c.min_id.is_(None))

    keyword = q.strip()
    if keyword:
        q_base = q_base.filter(DriveFile.filename.ilike(f"%{keyword}%"))

    total = q_base.count()
    from sqlalchemy import nullslast
    rows = q_base.order_by(nullslast(rep.report_date.desc()), DriveFile.id.desc()).offset(offset).limit(limit).all()

    files = []
    for df, rp in rows:
        files.append({
            "drive_file_id": df.drive_file_id,
            "filename": df.filename,
            "processed_at": df.processed_at,
            "has_report": rp is not None,
            "stock_code": rp.stock_code if rp else None,
            "stock_name": rp.stock_name if rp else None,
            "recommendation": rp.recommendation if rp else None,
            "report_date": rp.report_date if rp else None,
        })

    return {"total": total, "offset": offset, "limit": limit, "files": files}


@router.post("/reanalyze")
async def reanalyze_missing(
    background_tasks: BackgroundTasks,
    limit: int = Query(default=200, ge=1, le=500),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """重新分析沒有 Report 的 DriveFile（每次最多 limit 筆）"""
    # 找出有 DriveFile 但無 Report 的 drive_file_id
    has_report = db.query(Report.drive_file_id).distinct().subquery()
    orphans = (
        db.query(DriveFile)
        .filter(DriveFile.drive_file_id.notin_(has_report))
        .limit(limit)
        .all()
    )
    file_ids = [(f.drive_file_id, f.filename) for f in orphans]
    if not file_ids:
        return {"queued": 0, "message": "沒有需要重新分析的檔案"}

    background_tasks.add_task(_do_reanalyze_async, file_ids)
    return {"queued": len(file_ids), "message": f"已排程重新分析 {len(file_ids)} 個檔案"}


async def _do_reanalyze_async(file_ids: list[tuple[str, str]]):
    await asyncio.to_thread(_do_reanalyze, file_ids)


def _do_reanalyze(file_ids: list[tuple[str, str]]):
    import gc
    import json
    import logging
    from datetime import date
    from database import SessionLocal
    from drive_sync import get_drive_service, download_file, extract_date_from_filename, IMAGE_MIME_TYPES
    from analyzer import analyze_report, analyze_image_file
    from models import Report

    logger = logging.getLogger(__name__)
    db = SessionLocal()
    reanalyzed = 0
    try:
        service = get_drive_service()
        for i, (file_id, filename) in enumerate(file_ids, start=1):
            try:
                file_bytes = download_file(service, file_id)
                mime_type = "application/pdf"
                # Determine mime from filename extension
                if filename.lower().endswith((".jpg", ".jpeg")):
                    mime_type = "image/jpeg"
                elif filename.lower().endswith(".png"):
                    mime_type = "image/png"

                if mime_type in IMAGE_MIME_TYPES:
                    result = analyze_image_file(file_bytes, IMAGE_MIME_TYPES[mime_type], filename=filename)
                else:
                    result = analyze_report(file_bytes, filename=filename)

                if result:
                    report_date = None
                    raw_date = result.get("report_date")
                    if raw_date:
                        try:
                            report_date = date.fromisoformat(str(raw_date)[:10])
                        except (ValueError, TypeError):
                            pass
                    if report_date is None:
                        report_date = extract_date_from_filename(filename)

                    stock_code = result.get("stock_code") or "MARKET"
                    db.add(Report(
                        drive_file_id=file_id,
                        stock_code=stock_code,
                        stock_name=result.get("stock_name"),
                        recommendation=result.get("recommendation") if stock_code != "MARKET" else None,
                        target_price=result.get("target_price"),
                        analyst=result.get("analyst"),
                        report_date=report_date,
                        summary=result.get("summary"),
                        key_points=json.dumps(result.get("key_points") or [], ensure_ascii=False),
                        mentioned_stocks=json.dumps(list(dict.fromkeys(result.get("mentioned_stocks") or [])), ensure_ascii=False),
                        source_filename=filename,
                    ))
                    db.commit()
                    reanalyzed += 1
                    logger.info("Reanalyzed %s → report created", filename)
                else:
                    logger.warning("Reanalyze still no result for %s", filename)
            except Exception as e:
                db.rollback()
                logger.error("Reanalyze error for %s: %s", filename, e)

            if i % 10 == 0:
                gc.collect()
    finally:
        db.close()
    logger.info("Reanalyze done: %d/%d reports created", reanalyzed, len(file_ids))


@router.post("/reanalyze-test")
async def reanalyze_test(
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """同步分析 1 個無結果檔案，直接回傳結果供 debug"""
    from drive_sync import get_drive_service, download_file, extract_date_from_filename, IMAGE_MIME_TYPES
    from analyzer import analyze_report, analyze_image_file
    import traceback

    has_report = db.query(Report.drive_file_id).distinct().subquery()
    orphan = (
        db.query(DriveFile)
        .filter(DriveFile.drive_file_id.notin_(has_report))
        .first()
    )
    if not orphan:
        return {"status": "no_orphans"}

    file_id, filename = orphan.drive_file_id, orphan.filename
    try:
        service = get_drive_service()
        file_bytes = download_file(service, file_id)
        mime_type = "application/pdf"
        if filename.lower().endswith((".jpg", ".jpeg")):
            mime_type = "image/jpeg"
        elif filename.lower().endswith(".png"):
            mime_type = "image/png"

        if mime_type in IMAGE_MIME_TYPES:
            result = analyze_image_file(file_bytes, IMAGE_MIME_TYPES[mime_type], filename=filename)
        else:
            result = analyze_report(file_bytes, filename=filename)

        return {"filename": filename, "result": result, "status": "ok" if result else "no_result"}
    except Exception as e:
        return {"filename": filename, "error": str(e), "traceback": traceback.format_exc(), "status": "error"}


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

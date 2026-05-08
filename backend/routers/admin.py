from __future__ import annotations
import json
import secrets
from typing import List, Optional
from datetime import date, datetime
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func

from database import get_db
from models import User, LoginSession, InviteCode, DriveFile, Report
from routers.auth import require_admin, get_current_user
import stocks_master

router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/stocks/refresh")
def refresh_stock_names(db: Session = Depends(get_db), _=Depends(require_admin)):
    """補抓 reports/watchlist 中尚未在 stocks 主檔的股號中文名（從 nstock）"""
    return stocks_master.seed_stocks(db)


@router.get("/users")
def list_users(db: Session = Depends(get_db), _=Depends(require_admin)):
    users = db.query(User).order_by(User.last_login.desc()).all()
    result = []
    for u in users:
        login_count = db.query(func.count(LoginSession.id)).filter(
            LoginSession.user_id == u.id
        ).scalar()
        result.append({
            "id": u.id,
            "email": u.email,
            "name": u.name,
            "picture": u.picture,
            "is_admin": bool(u.is_admin),
            "created_at": u.created_at,
            "last_login": u.last_login,
            "login_count": login_count,
        })
    return result


@router.get("/users/{user_id}/sessions")
def user_sessions(user_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    sessions = (
        db.query(LoginSession)
        .filter(LoginSession.user_id == user_id)
        .order_by(LoginSession.logged_in_at.desc())
        .limit(50)
        .all()
    )
    return [
        {
            "id": s.id,
            "logged_in_at": s.logged_in_at,
            "ip_address": s.ip_address,
            "user_agent": s.user_agent,
        }
        for s in sessions
    ]


@router.patch("/users/{user_id}/admin")
def set_admin(user_id: int, is_admin: bool, db: Session = Depends(get_db), _=Depends(require_admin)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="使用者不存在")
    user.is_admin = 1 if is_admin else 0
    db.commit()
    return {"ok": True}


# ── 邀請碼管理 ────────────────────────────────────────────────

@router.get("/invite-codes")
def list_invite_codes(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    rows = db.query(InviteCode).order_by(InviteCode.created_at.desc()).all()
    user_ids = {r.used_by for r in rows if r.used_by}
    users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    return [
        {
            "id": r.id,
            "code": r.code,
            "created_at": r.created_at,
            "is_active": bool(r.is_active),
            "used": r.used_by is not None,
            "used_at": r.used_at,
            "used_by_name": users[r.used_by].name if r.used_by and r.used_by in users else None,
        }
        for r in rows
    ]


@router.post("/invite-codes")
def create_invite_code(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    code = secrets.token_urlsafe(8)  # ~11 chars, URL-safe
    invite = InviteCode(code=code, created_by=admin.id)
    db.add(invite)
    db.commit()
    db.refresh(invite)
    return {"id": invite.id, "code": invite.code, "created_at": invite.created_at}


@router.delete("/invite-codes/{invite_id}")
def deactivate_invite_code(invite_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    invite = db.query(InviteCode).filter(InviteCode.id == invite_id).first()
    if not invite:
        raise HTTPException(status_code=404, detail="邀請碼不存在")
    invite.is_active = 0
    db.commit()
    return {"ok": True}


# ── 資料匯出 / 匯入 ────────────────────────────────────────────

@router.get("/export")
def export_data(db: Session = Depends(get_db), _=Depends(require_admin)):
    """匯出所有 DriveFile + Report 為 JSON（供本機→生產環境搬移）"""
    drive_files = db.query(DriveFile).all()
    reports = db.query(Report).all()

    def _dt(v):
        if v is None:
            return None
        if isinstance(v, (datetime, date)):
            return v.isoformat()
        return v

    data = {
        "version": 1,
        "drive_files": [
            {
                "drive_file_id": f.drive_file_id,
                "filename": f.filename,
                "processed_at": _dt(f.processed_at),
            }
            for f in drive_files
        ],
        "reports": [
            {
                "drive_file_id": r.drive_file_id,
                "stock_code": r.stock_code,
                "stock_name": r.stock_name,
                "recommendation": r.recommendation,
                "target_price": r.target_price,
                "analyst": r.analyst,
                "report_date": _dt(r.report_date),
                "summary": r.summary,
                "key_points": r.key_points,
                "mentioned_stocks": r.mentioned_stocks,
                "source_filename": r.source_filename,
                "created_at": _dt(r.created_at),
            }
            for r in reports
        ],
    }
    return JSONResponse(content=data, headers={
        "Content-Disposition": "attachment; filename=investreport_export.json"
    })


class ImportPayload(BaseModel):
    version: int = 1
    drive_files: List[dict] = []
    reports: List[dict] = []


@router.post("/import")
def import_data(payload: ImportPayload, db: Session = Depends(get_db), _=Depends(require_admin)):
    """匯入 DriveFile + Report（drive_file_id 已存在則略過，不覆蓋）"""
    existing_drive = {f.drive_file_id for f in db.query(DriveFile.drive_file_id).all()}
    existing_reports = {r.drive_file_id for r in db.query(Report.drive_file_id).all()}

    df_added = 0
    for f in payload.drive_files:
        fid = f.get("drive_file_id")
        if not fid or fid in existing_drive:
            continue
        db.add(DriveFile(
            drive_file_id=fid,
            filename=f.get("filename") or fid,
        ))
        existing_drive.add(fid)
        df_added += 1

    rpt_added = 0
    for r in payload.reports:
        fid = r.get("drive_file_id")
        if not fid or fid in existing_reports:
            continue
        report_date = None
        if r.get("report_date"):
            try:
                report_date = date.fromisoformat(str(r["report_date"])[:10])
            except (ValueError, TypeError):
                pass
        db.add(Report(
            drive_file_id=fid,
            stock_code=r.get("stock_code") or "MARKET",
            stock_name=r.get("stock_name"),
            recommendation=r.get("recommendation"),
            target_price=r.get("target_price"),
            analyst=r.get("analyst"),
            report_date=report_date,
            summary=r.get("summary"),
            key_points=r.get("key_points"),
            mentioned_stocks=r.get("mentioned_stocks"),
            source_filename=r.get("source_filename"),
        ))
        existing_reports.add(fid)
        rpt_added += 1

    db.commit()
    return {
        "ok": True,
        "drive_files_added": df_added,
        "reports_added": rpt_added,
        "drive_files_skipped": len(payload.drive_files) - df_added,
        "reports_skipped": len(payload.reports) - rpt_added,
    }

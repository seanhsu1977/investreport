from __future__ import annotations
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func

from database import get_db
from models import User, LoginSession
from routers.auth import require_admin

router = APIRouter(prefix="/admin", tags=["admin"])


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
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="使用者不存在")
    user.is_admin = 1 if is_admin else 0
    db.commit()
    return {"ok": True}

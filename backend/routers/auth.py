from __future__ import annotations
import os
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import User, LoginSession

router = APIRouter(prefix="/auth", tags=["auth"])

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
JWT_SECRET = os.getenv("JWT_SECRET", "change-me-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 30


def create_jwt(user_id: int) -> str:
    payload = {
        "sub": str(user_id),
        "exp": datetime.utcnow() + timedelta(days=JWT_EXPIRE_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="未登入")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id = int(payload["sub"])
    except JWTError:
        raise HTTPException(status_code=401, detail="Token 無效")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="使用者不存在")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="需要管理員權限")
    return user


class GoogleLoginRequest(BaseModel):
    credential: str  # Google ID token


class GoogleUserinfoRequest(BaseModel):
    sub: str
    email: str
    name: str = ""
    picture: str = ""


@router.post("/google/userinfo")
def google_login_userinfo(body: GoogleUserinfoRequest, request: Request, db: Session = Depends(get_db)):
    """接收前端從 Google userinfo API 取得的資料，建立/更新使用者"""
    google_id = body.sub
    email = body.email
    name = body.name
    picture = body.picture
    return _upsert_user_and_session(google_id, email, name, picture, request, db)


@router.post("/google")
def google_login(body: GoogleLoginRequest, request: Request, db: Session = Depends(get_db)):
    """驗證 Google ID token，建立/更新使用者，回傳 JWT"""
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=500, detail="GOOGLE_CLIENT_ID 未設定")
    try:
        idinfo = id_token.verify_oauth2_token(
            body.credential,
            google_requests.Request(),
            GOOGLE_CLIENT_ID,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Google token 無效: {e}")

    google_id = idinfo["sub"]
    email = idinfo.get("email", "")
    name = idinfo.get("name", "")
    picture = idinfo.get("picture", "")
    return _upsert_user_and_session(google_id, email, name, picture, request, db)


def _upsert_user_and_session(google_id: str, email: str, name: str, picture: str, request: Request, db: Session):
    user = db.query(User).filter(User.google_id == google_id).first()
    if user:
        user.name = name
        user.picture = picture
        user.last_login = datetime.utcnow()
    else:
        is_first = db.query(User).count() == 0
        user = User(
            google_id=google_id,
            email=email,
            name=name,
            picture=picture,
            is_admin=1 if is_first else 0,
        )
        db.add(user)
        db.flush()

    session = LoginSession(
        user_id=user.id,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", ""),
    )
    db.add(session)
    db.commit()
    db.refresh(user)

    return {
        "token": create_jwt(user.id),
        "user": {
            "id": user.id,
            "email": user.email,
            "name": user.name,
            "picture": user.picture,
            "is_admin": bool(user.is_admin),
        },
    }


@router.get("/me")
def get_me(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "picture": user.picture,
        "is_admin": bool(user.is_admin),
    }

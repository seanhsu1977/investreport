import json
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import Report, Watchlist
from routers.auth import get_current_user, User

router = APIRouter(prefix="/watchlist", tags=["watchlist"])


class WatchlistAdd(BaseModel):
    stock_code: str
    stock_name: Optional[str] = None


@router.get("")
def get_watchlist(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """取得目前使用者的自選股清單"""
    items = (
        db.query(Watchlist)
        .filter(Watchlist.user_id == user.id)
        .order_by(Watchlist.added_at.desc())
        .all()
    )
    result = []
    for item in items:
        latest = (
            db.query(Report)
            .filter(Report.stock_code == item.stock_code)
            .order_by(Report.created_at.desc())
            .first()
        )
        result.append({
            "stock_code": item.stock_code,
            "stock_name": item.stock_name,
            "added_at": item.added_at,
            "latest_report": {
                "id": latest.id,
                "stock_code": latest.stock_code,
                "stock_name": latest.stock_name,
                "recommendation": latest.recommendation,
                "target_price": latest.target_price,
                "analyst": latest.analyst,
                "report_date": latest.report_date,
                "summary": latest.summary,
                "key_points": json.loads(latest.key_points) if latest.key_points else [],
                "created_at": latest.created_at,
                "source_filename": latest.source_filename,
            } if latest else None,
        })
    return result


@router.post("", status_code=201)
def add_to_watchlist(body: WatchlistAdd, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    existing = (
        db.query(Watchlist)
        .filter(Watchlist.user_id == user.id, Watchlist.stock_code == body.stock_code)
        .first()
    )
    if existing:
        raise HTTPException(status_code=409, detail="Stock already in watchlist")

    stock_name = body.stock_name
    if not stock_name:
        report = db.query(Report).filter(Report.stock_code == body.stock_code).first()
        if report:
            stock_name = report.stock_name

    item = Watchlist(user_id=user.id, stock_code=body.stock_code, stock_name=stock_name)
    db.add(item)
    db.commit()
    db.refresh(item)
    return {"stock_code": item.stock_code, "stock_name": item.stock_name, "added_at": item.added_at}


@router.delete("/{stock_code}", status_code=204)
def remove_from_watchlist(stock_code: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = (
        db.query(Watchlist)
        .filter(Watchlist.user_id == user.id, Watchlist.stock_code == stock_code)
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Stock not found in watchlist")
    db.delete(item)
    db.commit()

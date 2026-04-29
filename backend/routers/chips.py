"""期交所籌碼面 API（基於 backend/taifex.py 的 OpenAPI 抓取層）"""
from __future__ import annotations
import json
import logging
from datetime import date, datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

import taifex
from database import get_db
from models import FuturesChip

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/chips", tags=["chips"])


def _attach_change_from_prev(records: list[dict]) -> list[dict]:
    """records 須依日期升冪。對每筆計算與前一筆的散戶多空比變化量。"""
    for i, r in enumerate(records):
        if i == 0:
            continue
        prev = records[i - 1]
        ratio_now = r.get("tmf", {}).get("retail_ratio")
        ratio_prev = prev.get("tmf", {}).get("retail_ratio")
        if ratio_now is not None and ratio_prev is not None:
            r.setdefault("tmf", {})["retail_ratio_change"] = round(ratio_now - ratio_prev, 2)
    return records


def _serialize(rows) -> list[dict]:
    return [json.loads(r.payload) for r in rows]


def _upsert(db: Session, d: date, snap: dict) -> None:
    iso = d.isoformat()
    existing = db.get(FuturesChip, iso)
    payload = json.dumps(snap, ensure_ascii=False)
    if existing:
        existing.payload = payload
        existing.updated_at = datetime.utcnow()
    else:
        db.add(FuturesChip(date=iso, payload=payload))
    db.commit()


def _to_query_date(d: date) -> str:
    return d.strftime("%Y/%m/%d")


@router.get("/latest")
def get_latest(db: Session = Depends(get_db)):
    """最新一筆籌碼面快照（含與前一日的散戶多空比變化）"""
    rows = (
        db.query(FuturesChip)
        .order_by(FuturesChip.date.desc())
        .limit(2)
        .all()
    )
    if not rows:
        raise HTTPException(404, "尚無籌碼面資料")
    records = _serialize(reversed(rows))
    enriched = _attach_change_from_prev(records)
    return enriched[-1]


@router.get("/history")
def get_history(days: int = Query(default=15, ge=1, le=90), db: Session = Depends(get_db)):
    """近 N 個交易日籌碼面記錄（依日期升冪）"""
    rows = (
        db.query(FuturesChip)
        .order_by(FuturesChip.date.desc())
        .limit(days + 1)  # 多取一筆作為計算第一筆 change 的基準
        .all()
    )
    records = _serialize(reversed(rows))
    enriched = _attach_change_from_prev(records)
    if len(enriched) > days:
        enriched = enriched[-days:]
    return enriched


@router.post("/refresh")
def refresh(
    target: Optional[str] = Query(default=None, description="YYYY-MM-DD；省略=今天"),
    db: Session = Depends(get_db),
):
    """手動觸發抓取指定日期（或今天）的籌碼資料"""
    d = datetime.strptime(target, "%Y-%m-%d").date() if target else date.today()
    snap = taifex.build_chip_snapshot(_to_query_date(d))
    if not snap:
        raise HTTPException(404, f"{d} 期交所尚無資料（可能非交易日或尚未公布）")
    _upsert(db, d, snap)
    return {"saved": d.isoformat()}


@router.post("/backfill")
def backfill(
    start: str = Query(..., description="YYYY-MM-DD"),
    end: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    """補抓區間資料（跳過週末，已存在的不覆蓋）"""
    s = datetime.strptime(start, "%Y-%m-%d").date()
    e = datetime.strptime(end, "%Y-%m-%d").date() if end else date.today()
    saved, skipped, missing = [], [], []
    cur = s
    while cur <= e:
        if cur.weekday() < 5:
            iso = cur.isoformat()
            existing = db.get(FuturesChip, iso)
            if existing:
                skipped.append(iso)
            else:
                try:
                    snap = taifex.build_chip_snapshot(_to_query_date(cur))
                except Exception as ex:
                    logger.warning("backfill %s failed: %s", cur, ex)
                    missing.append(iso)
                    cur += timedelta(days=1)
                    continue
                if not snap:
                    missing.append(iso)
                else:
                    _upsert(db, cur, snap)
                    saved.append(iso)
        cur += timedelta(days=1)
    return {"saved": saved, "skipped": skipped, "missing": missing}

"""期交所籌碼面 API（基於 backend/taifex.py 的 OpenAPI 抓取層）"""
from __future__ import annotations
import json
import logging
from datetime import date, datetime, timedelta
from typing import Optional
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy.orm import Session

import chips_store
import taifex
from database import SessionLocal, get_db
from models import FuturesChip, LargeTraderTx, OptionsPcr
from routers.auth import require_admin

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


def _run_options_sync(start: date, end: date) -> None:
    db = SessionLocal()
    try:
        result = chips_store.sync_options_chips(db, start, end)
        logger.info("options backfill %s ~ %s done: %s", start, end, result)
    except Exception:
        logger.exception("options backfill %s ~ %s failed", start, end)
    finally:
        db.close()


@router.post("/options/backfill")
def options_backfill(
    background_tasks: BackgroundTasks,
    start: str = Query(..., description="YYYY-MM-DD"),
    end: Optional[str] = Query(default=None),
    _=Depends(require_admin),
):
    """背景補抓區間的選擇權 Put/Call Ratio 與大額交易人（以月為單位分段，已存在的會更新）。"""
    s = datetime.strptime(start, "%Y-%m-%d").date()
    e = datetime.strptime(end, "%Y-%m-%d").date() if end else date.today()
    if s > e:
        raise HTTPException(400, "start 不能晚於 end")
    background_tasks.add_task(_run_options_sync, s, e)
    return {"status": "started", "start": s.isoformat(), "end": e.isoformat()}


@router.get("/pcr")
def get_pcr(days: int = Query(default=60, ge=1, le=1500), db: Session = Depends(get_db)):
    """選擇權 Put/Call Ratio 最近 days 筆（日期升冪）。"""
    rows = db.query(OptionsPcr).order_by(OptionsPcr.date.desc()).limit(days).all()
    return [
        {
            "date": r.date,
            "put_volume": r.put_volume, "call_volume": r.call_volume, "pcr_volume": r.pcr_volume,
            "put_oi": r.put_oi, "call_oi": r.call_oi, "pcr_oi": r.pcr_oi,
        }
        for r in reversed(rows)
    ]


@router.get("/large-traders")
def get_large_traders(
    days: int = Query(default=60, ge=1, le=1500),
    month: str = Query(default="all", description="all=所有契約(999999)，或指定結算月 YYYYMM（666666=週契約合計）"),
    db: Session = Depends(get_db),
):
    """臺股期貨大額交易人未沖銷部位最近 days 個交易日（日期升冪，每日含 0=全部/1=特定法人 兩筆）。"""
    m = "999999" if month == "all" else month
    dates = [
        d for (d,) in db.query(LargeTraderTx.date)
        .filter(LargeTraderTx.settlement_month == m)
        .distinct().order_by(LargeTraderTx.date.desc()).limit(days).all()
    ]
    if not dates:
        return []
    rows = (
        db.query(LargeTraderTx)
        .filter(LargeTraderTx.settlement_month == m, LargeTraderTx.date.in_(dates))
        .order_by(LargeTraderTx.date.asc(), LargeTraderTx.trader_type.asc())
        .all()
    )
    return [
        {
            "date": r.date, "settlement_month": r.settlement_month, "trader_type": r.trader_type,
            "top5_buy": r.top5_buy, "top5_sell": r.top5_sell,
            "top10_buy": r.top10_buy, "top10_sell": r.top10_sell, "oi_market": r.oi_market,
        }
        for r in rows
    ]


@router.get("/futures-curve")
def futures_curve():
    """臺股期貨各契約月的最新報價（日盤/夜盤/結算價/量/未平倉）與近次月價差商品。只有最新一天。"""
    curve = taifex.get_tx_curve()
    if not curve or not curve["months"]:
        raise HTTPException(404, "期交所尚無臺股期貨行情資料")
    return curve

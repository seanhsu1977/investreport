"""ETF 每日持股變化追蹤 API。

目前支援：00981A（nstock ETF小百科 author_id=60）
"""
from __future__ import annotations
import logging
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import EtfDailyChange
import nstock_etf

logger = logging.getLogger(__name__)
router = APIRouter()
TPE = timezone(timedelta(hours=8))

SUPPORTED_ETFS = {"00981A"}


def _tpe_today() -> str:
    return datetime.now(TPE).date().isoformat()


# ──────────────────────────────────────────────────────────────────────
# 取得已有資料的日期列表
# ──────────────────────────────────────────────────────────────────────

@router.get("/etf-tracker/dates")
def etf_tracker_dates(etf: str = "00981A", db: Session = Depends(get_db)):
    """回傳此 ETF 已有資料的所有日期（降冪）。"""
    rows = (
        db.query(EtfDailyChange.date)
        .filter(EtfDailyChange.etf_code == etf)
        .distinct()
        .order_by(EtfDailyChange.date.desc())
        .all()
    )
    return {"etf_code": etf, "dates": [r[0] for r in rows]}


# ──────────────────────────────────────────────────────────────────────
# 取得指定日期的持股變化（附連續買超天數、新標的旗標）
# ──────────────────────────────────────────────────────────────────────

@router.get("/etf-tracker/daily")
def etf_tracker_daily(
    etf: str = "00981A",
    date: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """回傳指定日期的 ETF 持股變化清單，附帶：
    - consecutive_buy_days：連續買超天數（含今日）
    - is_new：此股票是否第一次出現買超
    """
    if date is None:
        date = _tpe_today()

    today_records = (
        db.query(EtfDailyChange)
        .filter(EtfDailyChange.etf_code == etf, EtfDailyChange.date == date)
        .all()
    )
    if not today_records:
        return {"etf_code": etf, "date": date, "stocks": [], "has_data": False}

    # 取該 ETF 此日期以前（含當天）的所有歷史記錄
    all_hist = (
        db.query(EtfDailyChange)
        .filter(EtfDailyChange.etf_code == etf, EtfDailyChange.date <= date)
        .order_by(EtfDailyChange.date.desc())
        .all()
    )

    # 建立每股的歷史列表（按日期降冪）
    history: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for h in all_hist:
        history[h.stock_code].append((h.date, h.action))

    result = []
    for rec in today_records:
        hist = history.get(rec.stock_code, [])  # 已是日期降冪

        # 連續買超天數（從今日往前數）
        consecutive = 0
        for _, act in hist:
            if act == "buy":
                consecutive += 1
            else:
                break

        # 新標的：此股票在這個 ETF 中，今日之前從未有過 buy 記錄
        had_prev_buy = any(d < date and a == "buy" for d, a in hist)
        is_new = (rec.action == "buy") and (not had_prev_buy)

        result.append({
            "code": rec.stock_code,
            "name": rec.stock_name,
            "shares_delta": rec.shares_delta,
            "action": rec.action,
            "price": rec.price,
            "change_pct": rec.change_pct,
            "consecutive_buy_days": consecutive,
            "is_new": is_new,
        })

    # 排序：買超（連續天數降冪 → 張數降冪）> 賣超（張數升冪）> 持平
    def _sort_key(s: dict):
        if s["action"] == "buy":
            return (0, -s["consecutive_buy_days"], -s["shares_delta"])
        elif s["action"] == "sell":
            return (1, s["shares_delta"], 0)
        else:
            return (2, 0, 0)

    result.sort(key=_sort_key)
    return {"etf_code": etf, "date": date, "stocks": result, "has_data": True}


# ──────────────────────────────────────────────────────────────────────
# 從 nstock 同步指定日期的資料
# ──────────────────────────────────────────────────────────────────────

@router.post("/etf-tracker/sync")
def etf_tracker_sync(
    etf: str = "00981A",
    date: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """從 nstock 抓取指定日期的 ETF 持股變化並存入 DB。"""
    if etf not in SUPPORTED_ETFS:
        raise HTTPException(status_code=400, detail=f"ETF {etf} 尚未支援，目前支援：{SUPPORTED_ETFS}")

    if date is None:
        date = _tpe_today()

    date_nstock = date.replace("-", "/")  # "YYYY-MM-DD" → "YYYY/MM/DD"
    try:
        data = nstock_etf.fetch_today(date_nstock)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"nstock 抓取失敗：{e}")

    if data is None:
        raise HTTPException(status_code=404, detail=f"{date} 尚無操作明細（nstock 尚未發文）")

    upserted = 0
    for stock in data["stocks"]:
        act = stock["action"]
        if act == "buy":
            delta = stock["shares"]
        elif act == "sell":
            delta = -stock["shares"]
        else:
            delta = 0

        existing = (
            db.query(EtfDailyChange)
            .filter_by(etf_code=etf, date=date, stock_code=stock["code"])
            .first()
        )
        if existing:
            existing.shares_delta = delta
            existing.action = act
            existing.stock_name = stock["name"]
            existing.price = stock.get("price")
            existing.change_pct = stock.get("change_pct")
            existing.nstock_article_id = data["article_id"]
        else:
            db.add(EtfDailyChange(
                etf_code=etf,
                date=date,
                stock_code=stock["code"],
                stock_name=stock["name"],
                shares_delta=delta,
                action=act,
                price=stock.get("price"),
                change_pct=stock.get("change_pct"),
                nstock_article_id=data["article_id"],
            ))
        upserted += 1

    db.commit()
    logger.info("ETF %s %s synced: %d stocks (article %d)", etf, date, upserted, data["article_id"])
    return {
        "etf_code": etf,
        "date": date,
        "article_id": data["article_id"],
        "count": upserted,
    }

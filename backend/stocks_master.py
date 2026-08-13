"""股票主檔工具：從 nstock.tw 同步中文股名，提供統一名稱查找。

API 回傳的所有股票顯示名稱都應透過 resolve_name() 取代，避免 reports/watchlist
歷史資料中的英文名 / KY 後綴 / 混合格式干擾。
"""
from __future__ import annotations
import logging
import time
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Report, Stock, Watchlist

logger = logging.getLogger(__name__)

NSTOCK_URL = "https://www.nstock.tw/api/v2/real-time-quotes/data"

# Process-local cache: code -> name (None = unknown / lookup failed)
_NAME_CACHE: dict[str, Optional[str]] = {}
_CACHE_LOADED = False


def _load_cache(db: Optional[Session] = None) -> None:
    """首次呼叫時把整張 stocks 表載入記憶體（讀很頻繁、寫很少）。"""
    global _CACHE_LOADED
    if _CACHE_LOADED:
        return
    own = db is None
    if own:
        db = SessionLocal()
    try:
        for s in db.query(Stock).all():
            _NAME_CACHE[s.code] = s.name
        _CACHE_LOADED = True
    finally:
        if own:
            db.close()


def invalidate_cache() -> None:
    global _CACHE_LOADED
    _NAME_CACHE.clear()
    _CACHE_LOADED = False


def resolve_name(code: Optional[str], fallback: Optional[str] = None) -> Optional[str]:
    """回傳統一中文股名；查無資料時 fallback 到原始 stock_name。"""
    if not code or code == "MARKET":
        return fallback
    if not _CACHE_LOADED:
        _load_cache()
    name = _NAME_CACHE.get(code)
    return name or fallback


def resolve_names_for(db: Session, codes: list[str]) -> dict[str, Optional[str]]:
    """確保這批代號在 stocks 主檔都有名稱，缺的話即時從 nstock 補抓並寫回主檔，
    供選股類排程（KDJ / 盤整突破）掃到主檔尚未收錄的 ETF 成份股代號時使用。
    """
    _load_cache(db)
    missing = [c for c in codes if c and c != "MARKET" and not _NAME_CACHE.get(c)]
    if missing:
        seed_stocks(db, codes=missing)
    return {c: _NAME_CACHE.get(c) for c in codes}


def fetch_name_from_nstock(code: str) -> Optional[str]:
    try:
        with httpx.Client(timeout=8) as client:
            resp = client.get(NSTOCK_URL, params={"stock_id": code})
            resp.raise_for_status()
            data = resp.json().get("data") or []
            if not data:
                return None
            name = data[0].get("股票名稱")
            return name.strip() if isinstance(name, str) and name.strip() else None
    except Exception as e:
        logger.warning("nstock fetch failed for %s: %s", code, e)
        return None


def collect_pending_codes(db: Session) -> list[str]:
    """蒐集所有出現在 reports/watchlist/ETF 成份股但 stocks 表沒紀錄的代號。"""
    from models import EtfDailyChange

    existing = {row[0] for row in db.query(Stock.code).all()}
    codes: set[str] = set()
    for (c,) in db.query(Report.stock_code).distinct():
        if c and c != "MARKET":
            codes.add(c)
    for (c,) in db.query(Watchlist.stock_code).distinct():
        if c:
            codes.add(c)
    for (c,) in db.query(EtfDailyChange.stock_code).distinct():
        if c:
            codes.add(c)
    return sorted(codes - existing)


def seed_stocks(db: Optional[Session] = None, codes: Optional[list[str]] = None,
                throttle_sec: float = 0.05) -> dict:
    """從 nstock 抓中文名灌進 stocks 表。預設只補缺漏的。"""
    own = db is None
    if own:
        db = SessionLocal()
    try:
        if codes is None:
            codes = collect_pending_codes(db)
        added, missed = [], []
        for code in codes:
            name = fetch_name_from_nstock(code)
            if not name:
                missed.append(code)
                continue
            existing = db.get(Stock, code)
            if existing:
                if existing.name != name:
                    existing.name = name
            else:
                db.add(Stock(code=code, name=name))
            added.append(code)
            time.sleep(throttle_sec)
        db.commit()
        invalidate_cache()
        _load_cache(db)
        return {"updated": added, "missing": missed}
    finally:
        if own:
            db.close()

"""nStock API helper — Taiwan market data."""
from __future__ import annotations
import time
from typing import Optional
import httpx

_CACHE: dict[str, tuple] = {}

_BASE_API = "https://api.nstock.tw/v2"
_BASE_WEB = "https://www.nstock.tw/api/v2"
_RT_TTL   = 60      # real-time quotes: 1 min
_DAILY_TTL = 1800   # daily K: 30 min


def _get(url: str, ttl: int) -> Optional[dict]:
    now = time.time()
    if url in _CACHE:
        data, ts = _CACHE[url]
        if now - ts < ttl:
            return data
    try:
        resp = httpx.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        _CACHE[url] = (data, now)
        return data
    except Exception:
        return None


def get_daily(stock_id: str) -> Optional[dict]:
    """日K 資料（包含技術指標），最新在前。
    回傳 dict：{ 股票代號, 股票名稱, 日K: [...] }
    """
    url = f"{_BASE_API}/daily-stock-data/data?stock_id={stock_id}"
    result = _get(url, _DAILY_TTL)
    if not result:
        return None
    raw = result.get("data")
    if isinstance(raw, list) and raw:
        return raw[0]
    if isinstance(raw, dict):
        return raw
    return None


def get_index_realtime(market_type: int) -> list[dict]:
    """即時指數行情。market_type: 1=上市, 2=上櫃, 3=興櫃"""
    url = f"{_BASE_WEB}/real-time-quotes-index/data?type={market_type}"
    result = _get(url, _RT_TTL)
    if not result:
        return []
    return result.get("data", [])


def find_index_quote(code: str, market_type: int) -> Optional[dict]:
    """從即時指數清單中找出特定代號"""
    for item in get_index_realtime(market_type):
        if item.get("股票代號") == code:
            return item
    return None

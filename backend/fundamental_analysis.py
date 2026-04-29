from __future__ import annotations
import time
import httpx
from datetime import datetime, timedelta

_HEADERS = {"User-Agent": "Mozilla/5.0"}

# T86 法人資料：以日期為 key，永久快取（歷史資料不會變）
_T86_CACHE: dict[str, list] = {}
# T86 今日資料：每小時更新一次
_T86_TODAY_TS: float = 0.0

# 月營收：全上市公司一次拉，6 小時 TTL（每月更新一次）
_REV_ALL: list | None = None
_REV_ALL_TS: float = 0.0
_REV_TTL = 3600 * 6


def _tw_now() -> datetime:
    return datetime.utcnow() + timedelta(hours=8)


def _parse_int(s: str) -> int:
    try:
        return int(str(s).replace(",", ""))
    except Exception:
        return 0


def _parse_float(s: str) -> float | None:
    try:
        return round(float(str(s).replace(",", "")), 2)
    except Exception:
        return None


def _fetch_t86(date_str: str) -> list:
    url = (
        f"https://www.twse.com.tw/rwd/zh/fund/T86"
        f"?response=json&date={date_str}&selectType=ALL"
    )
    try:
        with httpx.Client(timeout=10, headers=_HEADERS, follow_redirects=True) as c:
            d = c.get(url).json()
        if d.get("stat") == "OK":
            return d.get("data", [])
    except Exception:
        pass
    return []


def get_institutional(code: str, days: int = 5) -> list[dict] | None:
    """取近 days 個交易日的法人買賣超（上市股票）"""
    global _T86_TODAY_TS

    results: list[dict] = []
    today = _tw_now().strftime("%Y%m%d")
    d = _tw_now()

    for _ in range(20):
        date_str = d.strftime("%Y%m%d")

        # 今日資料每小時重拉；歷史資料永久快取
        is_today = date_str == today
        need_fetch = date_str not in _T86_CACHE or (
            is_today and time.time() - _T86_TODAY_TS > 3600
        )

        if need_fetch:
            rows = _fetch_t86(date_str)
            _T86_CACHE[date_str] = rows
            if is_today:
                _T86_TODAY_TS = time.time()
        else:
            rows = _T86_CACHE[date_str]

        if rows:
            for row in rows:
                if row[0] == code:
                    results.append({
                        "date": f"{date_str[:4]}/{date_str[4:6]}/{date_str[6:]}",
                        "foreign": _parse_int(row[4]),   # 外陸資買賣超
                        "trust":   _parse_int(row[10]),  # 投信買賣超
                        "dealer":  _parse_int(row[11]),  # 自營商買賣超
                        "total":   _parse_int(row[18]),  # 三大法人合計
                    })
                    break

        if len(results) >= days:
            break
        d -= timedelta(days=1)

    return results if results else None


def get_revenue(code: str) -> dict | None:
    """取最新一個月的月營收（上市股票）"""
    global _REV_ALL, _REV_ALL_TS

    now = time.time()
    if _REV_ALL is None or now - _REV_ALL_TS > _REV_TTL:
        try:
            url = "https://openapi.twse.com.tw/v1/opendata/t187ap05_L"
            with httpx.Client(timeout=15, headers=_HEADERS, follow_redirects=True) as c:
                data = c.get(url).json()
            if isinstance(data, list) and data:
                _REV_ALL = data
                _REV_ALL_TS = now
        except Exception:
            pass

    if not _REV_ALL:
        return None

    for item in _REV_ALL:
        if item.get("公司代號") != code:
            continue
        ym = item.get("資料年月", "")  # 民國 e.g. "11503"
        year  = int(ym[:3]) + 1911 if len(ym) >= 3 else 0
        month = int(ym[3:])          if len(ym) >= 5 else 0
        return {
            "year":        year,
            "month":       month,
            "revenue":     _parse_int(item.get("營業收入-當月營收", "0")),
            "mom_pct":     _parse_float(item.get("營業收入-上月比較增減(%)", "")),
            "yoy_pct":     _parse_float(item.get("營業收入-去年同月增減(%)", "")),
            "ytd":         _parse_int(item.get("累計營業收入-當月累計營收", "0")),
            "ytd_yoy_pct": _parse_float(item.get("累計營業收入-前期比較增減(%)", "")),
        }

    return None  # 上櫃或找不到

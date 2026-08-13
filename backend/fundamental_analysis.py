from __future__ import annotations
import time
import httpx
from datetime import datetime, timedelta

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    "Referer": "https://www.twse.com.tw/zh/page/trading/fund/T86.html",
}

# 被 TWSE rate-limit 時的全域標記（避免一直重打）
_T86_BLOCKED_UNTIL: float = 0.0

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
    """抓 TWSE T86 法人買賣超。被 rate-limit 時 5 分鐘內不重打。"""
    global _T86_BLOCKED_UNTIL
    if time.time() < _T86_BLOCKED_UNTIL:
        return []
    url = (
        f"https://www.twse.com.tw/rwd/zh/fund/T86"
        f"?response=json&date={date_str}&selectType=ALL"
    )
    try:
        with httpx.Client(timeout=6, headers=_HEADERS, follow_redirects=True) as c:
            r = c.get(url)
        ctype = r.headers.get("content-type", "")
        if "json" not in ctype:
            # TWSE 擋掉時回 HTML 錯誤頁（雲端 IP 常被封，1 小時內不重打）
            _T86_BLOCKED_UNTIL = time.time() + 3600
            return []
        d = r.json()
        if d.get("stat") == "OK":
            return d.get("data", [])
    except Exception:
        # timeout 也當作被封，1 小時內略過
        _T86_BLOCKED_UNTIL = time.time() + 3600
    return []


def is_t86_blocked() -> bool:
    return time.time() < _T86_BLOCKED_UNTIL


# 個股法人快取：以 stock_id 為 key，1 小時 TTL
_NSTOCK_INST_CACHE: dict[str, tuple[float, list]] = {}
_NSTOCK_INST_TTL = 3600


def _fetch_institutional_nstock(code: str) -> list:
    """從 nStock API 抓個股法人買賣超（已是「張」單位）。"""
    cached = _NSTOCK_INST_CACHE.get(code)
    if cached and time.time() - cached[0] < _NSTOCK_INST_TTL:
        return cached[1]
    url = f"https://api.nstock.tw/v2/three-institutional-investors/data?stock_id={code}"
    try:
        with httpx.Client(timeout=8, headers={"User-Agent": "Mozilla/5.0"}) as c:
            j = c.get(url).json()
        data = j.get("data") or []
        if not data:
            return []
        rows = data[0].get("三大法人") or []
        out: list[dict] = []
        for r in rows:
            ds = r.get("日期", "")
            if len(ds) != 8:
                continue
            foreign = _parse_int(r.get("外資買賣超", 0))
            trust = _parse_int(r.get("投信買賣超", 0))
            dealer = _parse_int(r.get("自營商買賣超", 0))
            out.append({
                "date": f"{ds[:4]}/{ds[4:6]}/{ds[6:]}",
                "foreign": foreign,
                "trust": trust,
                "dealer": dealer,
                "total": foreign + trust + dealer,
            })
        _NSTOCK_INST_CACHE[code] = (time.time(), out)
        return out
    except Exception:
        return []


def get_institutional(code: str, days: int = 5) -> list[dict] | None:
    """取近 days 個交易日的法人買賣超（單位：張）。

    走 nStock API（per-stock，無 rate-limit 問題），TWSE T86 留 fallback。
    """
    rows = _fetch_institutional_nstock(code)
    if rows:
        return rows[:days]

    # Fallback：TWSE T86（IP 沒被擋時）
    global _T86_TODAY_TS
    results: list[dict] = []
    today = _tw_now().strftime("%Y%m%d")
    d = _tw_now()
    for _ in range(20):
        date_str = d.strftime("%Y%m%d")
        is_today = date_str == today
        need_fetch = date_str not in _T86_CACHE or (
            is_today and time.time() - _T86_TODAY_TS > 3600
        )
        if need_fetch:
            t86_rows = _fetch_t86(date_str)
            _T86_CACHE[date_str] = t86_rows
            if is_today:
                _T86_TODAY_TS = time.time()
        else:
            t86_rows = _T86_CACHE[date_str]
        if t86_rows:
            for row in t86_rows:
                if row[0] == code:
                    def col(i: int) -> str:
                        return row[i] if i < len(row) else "0"
                    results.append({
                        "date": f"{date_str[:4]}/{date_str[4:6]}/{date_str[6:]}",
                        "foreign": _parse_int(col(4)) // 1000,
                        "trust":   _parse_int(col(10)) // 1000,
                        "dealer":  _parse_int(col(11)) // 1000,
                        "total":   _parse_int(col(18)) // 1000,
                    })
                    break
        if len(results) >= days:
            break
        d -= timedelta(days=1)
    return results if results else None


def summarize_institutional(rows: list[dict] | None) -> dict:
    """把 get_institutional() 回傳的逐日買賣超，摘要成單一訊號物件（供選股清單顯示用）。
    rows 須為最新在前排序。
    """
    if not rows:
        return {"inst_5d": None, "inst_today": None, "inst_consec_days": None, "inst_consec_sign": None}

    inst_today = rows[0]["total"]
    inst_5d = sum(r["total"] for r in rows[:5])

    consec = 0
    sign = None
    for r in rows:
        s = 1 if r["total"] > 0 else (-1 if r["total"] < 0 else 0)
        if sign is None:
            if s == 0:
                break
            sign = s
            consec = 1
        elif s == sign:
            consec += 1
        else:
            break

    return {
        "inst_5d": inst_5d,
        "inst_today": inst_today,
        "inst_consec_days": consec if sign is not None else None,
        "inst_consec_sign": sign,
    }


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

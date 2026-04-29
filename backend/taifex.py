"""TAIFEX open data helper — Taiwan futures market data."""
from __future__ import annotations
import time
from datetime import date, timedelta
from typing import Optional
import httpx

_TWSE_MI_INDEX_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX"
_TWSE_BFI_URL = "https://www.twse.com.tw/rwd/zh/fund/BFI82U"

# 期交所 CSV 端點（OpenAPI 的 queryDate 對歷史查詢無效，必須改用 CSV）
_INST_CSV_URL = "https://www.taifex.com.tw/cht/3/futContractsDateDown"
_FUT_CSV_URL = "https://www.taifex.com.tw/cht/3/futDataDown"

_CACHE: dict[str, tuple] = {}
_BASE = "https://openapi.taifex.com.tw/v1"
_TTL_TODAY = 1800   # 30 min for today's data
_TTL_HIST  = 86400  # 24h for past dates


def _fetch(url: str, ttl: int = _TTL_TODAY) -> Optional[list]:
    now = time.time()
    if url in _CACHE:
        data, ts = _CACHE[url]
        if now - ts < ttl:
            return data
    try:
        resp = httpx.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        _CACHE[url] = (data, now)
        return data
    except Exception:
        return None


def _date_fmt(d: date) -> str:
    return d.strftime("%Y/%m/%d")


def _is_today(date_str: str) -> bool:
    return date_str.replace("-", "/") == _date_fmt(date.today())


def recent_trading_dates(n: int = 10) -> list[str]:
    """Return last n weekday dates as YYYY/MM/DD strings, newest first."""
    result = []
    d = date.today()
    while len(result) < n:
        if d.weekday() < 5:
            result.append(_date_fmt(d))
        d -= timedelta(days=1)
    return result


def _get_institutional_raw(query_date: str) -> Optional[list]:
    url = f"{_BASE}/MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate?queryDate={query_date}"
    ttl = _TTL_TODAY if _is_today(query_date) else _TTL_HIST
    return _fetch(url, ttl)


def _get_market_raw(query_date: str) -> Optional[list]:
    url = f"{_BASE}/DailyMarketReportFut?queryDate={query_date}"
    ttl = _TTL_TODAY if _is_today(query_date) else _TTL_HIST
    return _fetch(url, ttl)


def get_institutional_tx(query_date: str) -> Optional[dict]:
    """三大法人台指期未平倉 for a given date."""
    data = _get_institutional_raw(query_date)
    if not data:
        return None

    name_map = {"外資及陸資": "foreign", "投信": "trust", "自營商": "dealer"}
    result: dict = {}
    for item in data:
        if item.get("ContractCode") == "臺股期貨":
            key = name_map.get(item.get("Item", ""), item.get("Item", ""))
            result[key] = {
                "long":   int(item.get("OpenInterest(Long)", 0) or 0),
                "short":  int(item.get("OpenInterest(Short)", 0) or 0),
                "net":    int(item.get("OpenInterest(Net)", 0) or 0),
                "change": int(item.get("TradingVolume(Net)", 0) or 0),
            }
    return result if result else None


def get_retail_xmt(query_date: str) -> Optional[dict]:
    """微型臺指散戶多空比。
    Total market OI (one-sided) = TMF contract sum.
    Retail = Total - Institutional.
    Ratio = (retail_long - retail_short) / total_oi * 100
    """
    inst_data = _get_institutional_raw(query_date)
    mkt_data  = _get_market_raw(query_date)
    if not inst_data or not mkt_data:
        return None

    # Institutional 微型臺指 OI (sum all three types)
    inst_long = inst_short = 0
    for item in inst_data:
        if item.get("ContractCode") == "微型臺指期貨":
            inst_long  += int(item.get("OpenInterest(Long)", 0) or 0)
            inst_short += int(item.get("OpenInterest(Short)", 0) or 0)

    # Total market one-sided OI for TMF (sum all expiry months except all-month rows)
    def _safe_int(v) -> int:
        try:
            return int(v or 0)
        except (ValueError, TypeError):
            return 0

    total_oi = sum(
        _safe_int(d.get("OpenInterest"))
        for d in mkt_data
        if d.get("Contract") == "TMF"
        and d.get("ContractMonth(Week)", "") not in ("", "999912")
    )
    if total_oi == 0:
        return None

    retail_long  = total_oi - inst_long
    retail_short = total_oi - inst_short
    ratio = round((retail_long - retail_short) / total_oi * 100, 2)

    return {
        "retail_long":  retail_long,
        "retail_short": retail_short,
        "total_oi":     total_oi,
        "ratio":        ratio,
    }


def get_tmf_institutional(query_date: str) -> Optional[dict]:
    """微型臺指三大法人 OI 拆分（每家身份別獨立）。"""
    data = _get_institutional_raw(query_date)
    if not data:
        return None
    name_map = {"外資及陸資": "foreign", "投信": "trust", "自營商": "dealer"}
    result: dict = {}
    for item in data:
        if item.get("ContractCode") == "微型臺指期貨":
            key = name_map.get(item.get("Item", ""), item.get("Item", ""))
            result[key] = {
                "long_oi":   int(item.get("OpenInterest(Long)", 0) or 0),
                "short_oi":  int(item.get("OpenInterest(Short)", 0) or 0),
                "net_oi":    int(item.get("OpenInterest(Net)", 0) or 0),
                "net_change": int(item.get("TradingVolume(Net)", 0) or 0),
            }
    return result if result else None


def get_tmf_close(query_date: str) -> Optional[dict]:
    """微型臺指近月一般盤收盤。"""
    data = _get_market_raw(query_date)
    if not data:
        return None

    def _safe_float(v) -> Optional[float]:
        try:
            return float(v) if v not in (None, "", "-") else None
        except (ValueError, TypeError):
            return None

    candidates = [
        d for d in data
        if d.get("Contract") == "TMF"
        and d.get("TradingSession") == "一般"
        and d.get("ContractMonth(Week)", "") not in ("", "999912")
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda d: d.get("ContractMonth(Week)", ""))
    near = candidates[0]
    pct_str = (near.get("%", "") or "").replace("%", "").strip()
    return {
        "close": _safe_float(near.get("Last")),
        "change": _safe_float(near.get("Change")),
        "change_pct": _safe_float(pct_str),
    }


def get_taiex(query_date: str) -> Optional[dict]:
    """從 TWSE MI_INDEX 取得指定日期加權指數收盤（即時，支援歷史日期）。"""
    yyyymmdd = query_date.replace("/", "").replace("-", "")
    url = f"{_TWSE_MI_INDEX_URL}?date={yyyymmdd}&type=IND&response=json"
    cache_key = f"twse_mi:{yyyymmdd}"
    now = time.time()
    if cache_key in _CACHE:
        cached, ts = _CACHE[cache_key]
        if now - ts < _TTL_HIST:
            payload = cached
        else:
            payload = None
    else:
        payload = None
    if payload is None:
        try:
            resp = httpx.get(url, timeout=15)
            resp.raise_for_status()
            payload = resp.json()
            if payload.get("stat") != "OK":
                return None
            _CACHE[cache_key] = (payload, now)
        except Exception:
            return None

    def _parse_num(s: str) -> Optional[float]:
        try:
            return float(s.replace(",", "").strip())
        except (ValueError, AttributeError):
            return None

    for table in payload.get("tables", []):
        if "價格指數(臺灣證券交易所)" not in str(table.get("title", "")):
            continue
        for row in table.get("data", []):
            if not row or "發行量加權股價指數" not in row[0]:
                continue
            close = _parse_num(row[1])
            sign_html = row[2] or ""
            sign = -1 if "-" in sign_html else 1
            pts = _parse_num(row[3])
            pct = _parse_num(row[4])
            if close is None or pts is None:
                return None
            change = sign * abs(pts)
            return {"close": close, "change": change, "change_pct": pct}
    return None


def _fetch_csv(url: str, payload: dict) -> Optional[str]:
    """POST 期交所 CSV 端點，Big5 解碼。失敗回 None。"""
    try:
        resp = httpx.post(url, data=payload, timeout=30)
        resp.raise_for_status()
        return resp.content.decode("big5", errors="replace")
    except Exception:
        return None


_CSV_INST_NAMES = {
    "臺股期貨": "TXF",
    "微型臺指期貨": "TMF",
}
_CSV_IDENTITY_KEYS = {
    "自營商": "dealer",
    "投信": "trust",
    "外資及陸資": "foreign",
}


def _parse_inst_csv(text: str) -> dict:
    """解析三大法人區分各契約 CSV，回傳 {contract_code: {identity: {...}}}"""
    result: dict = {code: {} for code in set(_CSV_INST_NAMES.values())}
    for line in text.splitlines()[1:]:
        cols = [c.strip() for c in line.split(",")]
        if len(cols) < 15:
            continue
        contract_name, identity = cols[1], cols[2]
        if contract_name not in _CSV_INST_NAMES or identity not in _CSV_IDENTITY_KEYS:
            continue
        try:
            result[_CSV_INST_NAMES[contract_name]][_CSV_IDENTITY_KEYS[identity]] = {
                "long_oi": int(cols[9]),
                "short_oi": int(cols[11]),
                "net_oi": int(cols[13]),
                "net_change": int(cols[7]),
            }
        except (ValueError, IndexError):
            continue
    return result


def _parse_market_csv(text: str) -> tuple[int, Optional[float], Optional[float], Optional[float]]:
    """解析每日行情 CSV，加總非價差「一般」盤未沖銷契約數，並抓近月收盤。
    回傳 (total_oi, close, change, change_pct)
    """
    total_oi = 0
    close = change = change_pct = None
    for line in text.splitlines()[1:]:
        cols = [c.strip() for c in line.split(",")]
        if len(cols) < 18 or cols[0].startswith("交易"):
            continue
        expiry, session = cols[2], cols[17]
        if "/" in expiry or session != "一般":
            continue
        try:
            total_oi += int(cols[11])
        except ValueError:
            continue
        if close is None:
            try:
                close = float(cols[6])
                change = float(cols[7])
                pct = cols[8].replace("%", "").strip()
                change_pct = float(pct) if pct and pct != "-" else None
            except ValueError:
                pass
    return total_oi, close, change, change_pct


def get_inst_spot(query_date: str) -> Optional[dict]:
    """三大法人集中市場買賣超（單位：億 NTD，正=買超）。

    自營商 = 自行買賣 + 避險合併；外資 = 外資及陸資 + 外資自營商。
    """
    yyyymmdd = query_date.replace("/", "").replace("-", "")
    url = f"{_TWSE_BFI_URL}?dayDate={yyyymmdd}&type=day&response=json"
    cache_key = f"twse_bfi:{yyyymmdd}"
    now = time.time()
    if cache_key in _CACHE:
        cached, ts = _CACHE[cache_key]
        if now - ts < _TTL_HIST:
            payload = cached
        else:
            payload = None
    else:
        payload = None
    if payload is None:
        try:
            resp = httpx.get(url, timeout=15)
            resp.raise_for_status()
            payload = resp.json()
            if payload.get("stat") != "OK":
                return None
            _CACHE[cache_key] = (payload, now)
        except Exception:
            return None

    def _parse_amt(v: str) -> int:
        try:
            return int(v.replace(",", ""))
        except (ValueError, AttributeError):
            return 0

    def _to_yi(amt: int) -> float:
        return round(amt / 1e8, 2)

    dealer_self = dealer_hedge = trust = foreign_main = foreign_dealer = 0
    for row in payload.get("data", []):
        if not row or len(row) < 4:
            continue
        name = row[0]
        net = _parse_amt(row[3])
        if name.startswith("自營商(自行買賣)"):
            dealer_self = net
        elif name.startswith("自營商(避險)"):
            dealer_hedge = net
        elif name.startswith("投信"):
            trust = net
        elif name.startswith("外資自營商"):
            foreign_dealer = net
        elif name.startswith("外資及陸資"):
            foreign_main = net
    return {
        "dealer": _to_yi(dealer_self + dealer_hedge),
        "trust": _to_yi(trust),
        "foreign": _to_yi(foreign_main + foreign_dealer),
        "total": _to_yi(dealer_self + dealer_hedge + trust + foreign_main + foreign_dealer),
    }


def build_chip_snapshot(query_date: str) -> Optional[dict]:
    """整合單日 chips 快照（以 CSV 為主，可正確查歷史）。

    OpenAPI 的 queryDate 對歷史日期無效（永遠回最新一筆），故改用期交所 CSV 端點。
    回傳 None 表示資料不足（非交易日 / 尚未公布）。
    """
    inst_text = _fetch_csv(_INST_CSV_URL, {
        "queryStartDate": query_date,
        "queryEndDate": query_date,
        "commodityId": "",
    })
    if not inst_text:
        return None
    inst = _parse_inst_csv(inst_text)
    txf, tmf_inst = inst.get("TXF", {}), inst.get("TMF", {})
    if not txf:
        return None

    market_text = _fetch_csv(_FUT_CSV_URL, {
        "down_type": "1",
        "commodity_id": "TMF",
        "commodity_id2": "",
        "queryStartDate": query_date,
        "queryEndDate": query_date,
    })
    total_oi = tmf_close = tmf_change = tmf_change_pct = None
    if market_text:
        total_oi, tmf_close, tmf_change, tmf_change_pct = _parse_market_csv(market_text)
    if not total_oi:
        return None

    inst_long = sum(v.get("long_oi", 0) for v in tmf_inst.values())
    inst_short = sum(v.get("short_oi", 0) for v in tmf_inst.values())
    retail_long = total_oi - inst_long
    retail_short = total_oi - inst_short
    retail_net = retail_long - retail_short
    retail_ratio = round(retail_net / total_oi * 100, 2) if total_oi else 0.0

    taiex = get_taiex(query_date)
    spot = get_inst_spot(query_date)
    iso = query_date.replace("/", "-")
    return {
        "date": iso,
        "taiex": ({"date": iso, **taiex} if taiex else None),
        "spot": spot,
        "txf": {
            "foreign": txf.get("foreign"),
            "trust": txf.get("trust"),
            "dealer": txf.get("dealer"),
        },
        "tmf": {
            "total_oi": total_oi,
            "close": tmf_close,
            "change": tmf_change,
            "change_pct": tmf_change_pct,
            "foreign": tmf_inst.get("foreign"),
            "trust": tmf_inst.get("trust"),
            "dealer": tmf_inst.get("dealer"),
            "retail_long": retail_long,
            "retail_short": retail_short,
            "retail_net": retail_net,
            "retail_ratio": retail_ratio,
        },
    }


def get_futures_summary(query_date: Optional[str] = None) -> Optional[dict]:
    """Complete summary for the futures page, including 10-day history."""
    if query_date is None:
        query_date = _date_fmt(date.today())

    institutional = get_institutional_tx(query_date)
    retail        = get_retail_xmt(query_date)

    if not institutional:
        return None

    # Build 10-day history for direction grids
    hist_dates = recent_trading_dates(11)   # extra buffer
    history: list[dict] = []
    for d in hist_dates:
        inst = get_institutional_tx(d)
        ret  = get_retail_xmt(d)
        if inst:
            history.append({
                "date":    d,
                "foreign": "多" if inst.get("foreign", {}).get("net", 0) > 0 else "空",
                "trust":   "多" if inst.get("trust",   {}).get("net", 0) > 0 else "空",
                "dealer":  "多" if inst.get("dealer",  {}).get("net", 0) > 0 else "空",
                "retail":  "多" if (ret or {}).get("ratio", 0) > 0 else "空" if ret else None,
            })
    history = history[:10]

    # Compute retail streak (consecutive same direction, latest first)
    streak_dir = streak_days = 0
    if history and history[0].get("retail"):
        streak_dir = history[0]["retail"]
        streak_days = 0
        for h in history:
            if h.get("retail") == streak_dir:
                streak_days += 1
            else:
                break

    return {
        "date":          query_date,
        "institutional": institutional,
        "retail":        {
            **(retail or {}),
            "streak_dir":  streak_dir,
            "streak_days": streak_days,
        },
        "history": history,
    }

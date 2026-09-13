"""護城河評分：用 nStock 未公開文件的財報類 API 組出「獲利持續性 + 毛利率趨勢 +
同業相對地位」三個面向的分數。這些 API（eps/basic-info/stock-list）不是文件化的
公開介面，是猜測既有 nStock 端點命名規則試出來的，格式若 nStock 調整可能失效。
"""
from __future__ import annotations
import logging
import time

import httpx

logger = logging.getLogger(__name__)

_HEADERS = {"User-Agent": "Mozilla/5.0"}
_API_BASE = "https://api.nstock.tw/v2"

# 財報類資料一天更新一次就夠，用長 TTL 減少對 nStock 的請求量
_CACHE_TTL = 24 * 3600
_STOCK_LIST_TTL = 24 * 3600

_eps_cache: dict[str, tuple[list[dict], float]] = {}
_basic_cache: dict[str, tuple[dict | None, float]] = {}
_stock_list_cache: tuple[list[dict], float] | None = None


def _parse_float(v) -> float | None:
    if v is None:
        return None
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def _fetch_json(url: str) -> dict | None:
    try:
        with httpx.Client(timeout=8, headers=_HEADERS) as c:
            resp = c.get(url)
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        logger.warning("moat_analysis fetch failed for %s: %s", url, e)
        return None


def get_quarterly_financials(code: str) -> list[dict]:
    """近 10 年（約 40 季）逐季 ROE/ROA/毛利率/營業利益率/淨利率/營收，最新在前。"""
    cached = _eps_cache.get(code)
    if cached and time.time() - cached[1] < _CACHE_TTL:
        return cached[0]

    data = _fetch_json(f"{_API_BASE}/eps/data?stock_id={code}")
    rows: list[dict] = []
    try:
        raw = data["data"][0]["季度EPS"]
        for r in raw:
            rows.append({
                "period": r.get("年季"),
                "roe": _parse_float(r.get("稅後權益報酬率(%)")),
                "roa": _parse_float(r.get("稅後資產報酬率(%)")),
                "gross_margin": _parse_float(r.get("單季毛利率(％)")),
                "operating_margin": _parse_float(r.get("單季營業利益率(％)")),
                "net_margin": _parse_float(r.get("單季稅後淨利率(％)")),
                "revenue": _parse_float(r.get("季營收(億)")),
                "revenue_yoy": _parse_float(r.get("單季年成長(％)")),
            })
    except (KeyError, IndexError, TypeError):
        rows = []

    _eps_cache[code] = (rows, time.time())
    return rows


def get_basic_info(code: str) -> dict | None:
    """產業分類、市值、估值、ROE/ROA(近四季)、負債比等基本面快照。"""
    cached = _basic_cache.get(code)
    if cached and time.time() - cached[1] < _CACHE_TTL:
        return cached[0]

    data = _fetch_json(f"{_API_BASE}/basic-info/data?stock_id={code}")
    result: dict | None = None
    try:
        row = data["data"][0]
        latest_q = row.get("近一季") or {}
        result = {
            "industry": row.get("產業名稱"),
            "market_cap": _parse_float(row.get("總市值(億)")),
            "pe": _parse_float(row.get("本益比(近四季)")),
            "pb": _parse_float(row.get("股價淨值比")),
            "roe_ttm": _parse_float(row.get("ROE(近四季)")),
            "roa_ttm": _parse_float(row.get("ROA(近四季)")),
            "dividend_yield": _parse_float(row.get("現金股利殖利率(%)")),
            "debt_ratio": _parse_float(latest_q.get("負債比例(％)")),
        }
    except (KeyError, IndexError, TypeError):
        result = None

    _basic_cache[code] = (result, time.time())
    return result


def _get_stock_list() -> list[dict]:
    global _stock_list_cache
    if _stock_list_cache and time.time() - _stock_list_cache[1] < _STOCK_LIST_TTL:
        return _stock_list_cache[0]
    data = _fetch_json(f"{_API_BASE}/stock-list/data")
    rows = (data or {}).get("data") or []
    _stock_list_cache = (rows, time.time())
    return rows


def get_industry_peers(code: str, industry: str, limit: int = 20) -> list[str]:
    """同產業其他代號（不含自己），最多 limit 檔（避免同業家數過多時逐一查基本面太慢）。"""
    rows = _get_stock_list()
    peers = [
        r["股票代號"] for r in rows
        if r.get("產業名稱") == industry and r.get("股票代號") != code
    ]
    return peers[:limit]


def _stability_score(values: list[float]) -> float:
    """0~1，用變異係數（標準差/平均）的倒數概念：越穩定分數越高。"""
    if not values:
        return 0.0
    n = len(values)
    mean = sum(values) / n
    if mean <= 0:
        return 0.0
    variance = sum((v - mean) ** 2 for v in values) / n
    cv = (variance ** 0.5) / mean
    return max(0.0, 1 - min(cv, 1.0))


def compute_moat_score(
    quarterly: list[dict],
    basic: dict | None,
    peer_basics: list[dict | None],
) -> dict:
    """
    quarterly: get_quarterly_financials() 結果，最新在前
    basic: get_basic_info() 結果
    peer_basics: 同業每家的 get_basic_info() 結果（可能含 None）

    三個面向合計 0~100：
    A. 獲利能力持續性（0~40）：近 12 季 ROE 水準 + 穩定度
    B. 毛利率水準與趨勢（0~30）：近 4 季毛利率水準 + 相對 3 年前是否持平/上升
    C. 同業相對地位（0~30）：ROE(近四季) 在同業樣本中的百分位
    """
    recent12 = quarterly[:12]
    roe_vals = [q["roe"] for q in recent12 if q["roe"] is not None]

    gm_recent_vals = [q["gross_margin"] for q in quarterly[:4] if q["gross_margin"] is not None]
    gm_baseline_vals = [q["gross_margin"] for q in quarterly[12:16] if q["gross_margin"] is not None]
    avg_gm_recent = sum(gm_recent_vals) / len(gm_recent_vals) if gm_recent_vals else None
    avg_gm_baseline = sum(gm_baseline_vals) / len(gm_baseline_vals) if gm_baseline_vals else None

    # A. 獲利能力持續性
    avg_roe = sum(roe_vals) / len(roe_vals) if roe_vals else 0.0
    roe_level_score = max(0.0, min(1.0, avg_roe / 20)) * 25   # ROE 20% 視為滿分基準
    roe_stability_score = _stability_score(roe_vals) * 15
    profitability_score = roe_level_score + roe_stability_score

    # B. 毛利率水準與趨勢
    gm_level_score = max(0.0, min(1.0, (avg_gm_recent or 0) / 40)) * 18  # 毛利率 40% 視為高水準基準
    if avg_gm_recent is not None and avg_gm_baseline is not None and avg_gm_baseline > 0:
        gm_change_pct = (avg_gm_recent - avg_gm_baseline) / avg_gm_baseline
        # 毛利率 3 年來持平或上升拿高分，下滑超過 10% 拿 0 分
        gm_trend_score = max(0.0, min(1.0, (gm_change_pct + 0.1) / 0.2)) * 12
    else:
        gm_trend_score = 6.0  # 資料不足（如新上市不到 3 年）給中間值
    margin_score = gm_level_score + gm_trend_score

    # C. 同業相對地位
    peer_roes = [p["roe_ttm"] for p in peer_basics if p and p.get("roe_ttm") is not None]
    target_roe = basic.get("roe_ttm") if basic else None
    percentile: float | None = None
    if target_roe is not None and peer_roes:
        better_or_equal = sum(1 for r in peer_roes if r <= target_roe)
        percentile = better_or_equal / len(peer_roes)
        industry_score = percentile * 30
    else:
        industry_score = 15.0  # 資料不足給中間值

    total = round(profitability_score + margin_score + industry_score)

    return {
        "score": max(0, min(100, total)),
        "breakdown": {
            "profitability": round(profitability_score, 1),
            "margin": round(margin_score, 1),
            "industry_relative": round(industry_score, 1),
        },
        "avg_roe_12q": round(avg_roe, 1) if roe_vals else None,
        "avg_gross_margin_recent": round(avg_gm_recent, 1) if avg_gm_recent is not None else None,
        "avg_gross_margin_3y_ago": round(avg_gm_baseline, 1) if avg_gm_baseline is not None else None,
        "industry_percentile": round(percentile * 100) if percentile is not None else None,
        "peer_sample_size": len(peer_roes),
    }

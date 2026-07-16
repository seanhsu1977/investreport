from __future__ import annotations
import asyncio
import json
import os
import time
import httpx
from datetime import date, datetime, timedelta
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from google import genai
from google.genai import types as genai_types
import nstock as ns

_SAFETY_OFF = [
    genai_types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_NONE"),
    genai_types.SafetySetting(category="HARM_CATEGORY_HARASSMENT",         threshold="BLOCK_NONE"),
    genai_types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH",        threshold="BLOCK_NONE"),
    genai_types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT",  threshold="BLOCK_NONE"),
]

from database import get_db
from models import Report, StockRecommendationReason, TxfCandle, User
from stocks_master import resolve_name
from routers.auth import require_admin, get_current_user

router = APIRouter(prefix="/stocks", tags=["stocks"])

# ── Concept Stock Rotation ───────────────────────────────────────────────────
# 資料來源：nstock 概念股清單 (StockChip)，各股成交金額加總計算動能
_SECTOR_CHIP_CACHE: dict[str, tuple[dict, float]] = {}
_SECTOR_CHIP_TTL = 4 * 3600
_NSTOCK_STRATEGY = "https://api.nstock.tw/strategy/"

# ── Server-side in-memory cache for recommendations（TTL 10 分鐘）
_rec_cache: dict[str, tuple[dict, float]] = {}
_REC_CACHE_TTL = 10 * 60
_REC_DB_CACHE_TTL = 12 * 3600  # DB 快取 12 小時
_computing_keys: set[str] = set()  # 正在背景計算中的 key，防重複觸發

# 全域 semaphore：限制跨任務的並發，避免 512MB OOM
# 在第一次使用時初始化（需在 event loop 內建立）
_SEM_SIGNAL: asyncio.Semaphore | None = None
_SEM_INST: asyncio.Semaphore | None = None

_MAX_CANDIDATES = 25  # 每次最多處理支數，保護記憶體


def _get_sems() -> tuple[asyncio.Semaphore, asyncio.Semaphore]:
    global _SEM_SIGNAL, _SEM_INST
    if _SEM_SIGNAL is None:
        _SEM_SIGNAL = asyncio.Semaphore(3)
    if _SEM_INST is None:
        _SEM_INST = asyncio.Semaphore(3)
    return _SEM_SIGNAL, _SEM_INST


def _serialize_report(r: Report, include_mentioned: bool = False) -> dict:
    d = {
        "id": r.id,
        "stock_code": r.stock_code,
        "stock_name": resolve_name(r.stock_code, r.stock_name),
        "recommendation": r.recommendation,
        "target_price": r.target_price,
        "analyst": r.analyst,
        "report_date": r.report_date,
        "summary": r.summary,
        "key_points": json.loads(r.key_points) if r.key_points else [],
        "created_at": r.created_at,
        "source_filename": r.source_filename,
        "price_at_report": r.price_at_report,
        "price_5d_before": r.price_5d_before,
        "price_10d_before": r.price_10d_before,
        "price_20d_before": r.price_20d_before,
    }
    if include_mentioned:
        d["mentioned_stocks"] = json.loads(r.mentioned_stocks) if r.mentioned_stocks else []
    return d


def _fill_prices_at_report(stock_code: str, reports: list, db) -> None:
    """懶惰填充報告日及報告前 5/10/20 日的歷史收盤價。"""
    missing = [
        r for r in reports
        if r.report_date is not None and r.stock_code != "MARKET"
        and (r.price_at_report is None or r.price_5d_before is None
             or r.price_10d_before is None or r.price_20d_before is None)
    ]
    if not missing:
        return
    try:
        import yfinance as yf
        from datetime import timedelta
        min_date = min(r.report_date for r in missing)
        # 往前多拉 35 天以覆蓋 20 個交易日前的價格
        for suffix in [".TW", ".TWO"]:
            ticker = yf.Ticker(f"{stock_code}{suffix}")
            hist = ticker.history(start=min_date - timedelta(days=35))
            if not hist.empty:
                break
        else:
            return
        hist_dates = [d.date() for d in hist.index]
        hist_closes = list(hist["Close"])

        def _price_on_or_before(target_date):
            cs = [(d, c) for d, c in zip(hist_dates, hist_closes) if d <= target_date]
            return round(cs[-1][1], 2) if cs else None

        for r in missing:
            if r.price_at_report is None:
                r.price_at_report = _price_on_or_before(r.report_date)
            if r.price_5d_before is None:
                r.price_5d_before = _price_on_or_before(r.report_date - timedelta(days=5))
            if r.price_10d_before is None:
                r.price_10d_before = _price_on_or_before(r.report_date - timedelta(days=10))
            if r.price_20d_before is None:
                r.price_20d_before = _price_on_or_before(r.report_date - timedelta(days=20))
        db.commit()
    except Exception:
        pass


def _fill_all_prices_bg() -> None:
    """背景批次填充所有報告的歷史價格（一次性工具，不重複填已有資料）。"""
    from database import SessionLocal
    db = SessionLocal()
    try:
        from sqlalchemy import or_
        codes = [
            row[0] for row in
            db.query(Report.stock_code).filter(
                Report.stock_code != "MARKET",
                Report.report_date.isnot(None),
                or_(
                    Report.price_at_report.is_(None),
                    Report.price_5d_before.is_(None),
                    Report.price_10d_before.is_(None),
                    Report.price_20d_before.is_(None),
                )
            ).distinct().all()
        ]
        for code in codes:
            reports = db.query(Report).filter(
                Report.stock_code == code,
                Report.report_date.isnot(None),
            ).all()
            _fill_prices_at_report(code, reports, db)
    finally:
        db.close()


@router.get("")
def list_stocks(db: Session = Depends(get_db)):
    """列出所有有報告的個股（排除 MARKET），含最新推薦與報告數量"""
    rows = (
        db.query(
            Report.stock_code,
            Report.stock_name,
            func.count(Report.id).label("report_count"),
            func.max(Report.created_at).label("latest_at"),
        )
        .filter(Report.stock_code != "MARKET")
        .group_by(Report.stock_code)
        .order_by(func.max(Report.created_at).desc())
        .all()
    )

    result = []
    for row in rows:
        latest = (
            db.query(Report)
            .filter(Report.stock_code == row.stock_code)
            .order_by(Report.created_at.desc())
            .first()
        )
        result.append({
            "stock_code": row.stock_code,
            "stock_name": resolve_name(row.stock_code, row.stock_name),
            "report_count": row.report_count,
            "latest_at": row.latest_at,
            "latest_recommendation": latest.recommendation if latest else None,
            "latest_target_price": latest.target_price if latest else None,
        })

    return result


@router.get("/upside-ranking")
async def get_upside_ranking(
    days: int = Query(default=90, ge=1, le=365),
    db: Session = Depends(get_db),
):
    """依目標價 vs 現價差異排行（並行抓取即時股價，取前 50 筆）"""
    # 報告日期下限（用 report_date 優先，null 時用 created_at）
    since = datetime.utcnow() - timedelta(days=days)
    since_str = since.strftime("%Y-%m-%d")

    # 1. 查每支個股最新一筆有目標價的報告（限制在指定期間內）
    # subquery: 每 stock_code 最大的 report_date（null 時用 created_at）
    subq = (
        db.query(
            Report.stock_code,
            func.max(
                func.coalesce(Report.report_date, func.date(Report.created_at))
            ).label("max_date"),
        )
        .filter(
            Report.stock_code != "MARKET",
            Report.target_price.isnot(None),
            func.coalesce(Report.report_date, func.date(Report.created_at)) >= since_str,
        )
        .group_by(Report.stock_code)
        .subquery()
    )

    rows = (
        db.query(Report)
        .join(
            subq,
            (Report.stock_code == subq.c.stock_code)
            & (
                func.coalesce(Report.report_date, func.date(Report.created_at))
                == subq.c.max_date
            ),
        )
        .filter(Report.target_price.isnot(None))
        .all()
    )

    # 若同一個股有多筆符合 max_date，取 id 最大的那筆
    latest_map: dict[str, Report] = {}
    for r in rows:
        if r.stock_code not in latest_map or r.id > latest_map[r.stock_code].id:
            latest_map[r.stock_code] = r

    reports = list(latest_map.values())
    codes = [r.stock_code for r in reports]

    # 2. 並行抓取所有個股現價（用同步 httpx + asyncio.to_thread，semaphore 限制並發）
    semaphore = asyncio.Semaphore(10)

    def _fetch_price_sync(code: str) -> tuple[str, dict | None]:
        url = f"https://www.nstock.tw/api/v2/real-time-quotes/data?stock_id={code}"
        try:
            with httpx.Client(timeout=5) as client:
                resp = client.get(url)
                data = resp.json().get("data", [])
                if not data:
                    return code, None
                row = data[0]
                price = float(row.get("當盤成交價") or 0) or None
                volume = int(float(row.get("累積成交量") or 0)) or None
                return code, {"price": price, "volume": volume}
        except Exception:
            return code, None

    async def fetch_price(code: str) -> tuple[str, dict | None]:
        async with semaphore:
            return await asyncio.to_thread(_fetch_price_sync, code)

    price_results = await asyncio.gather(*[fetch_price(c) for c in codes])
    price_map: dict[str, dict | None] = dict(price_results)

    # 2.5 查各股在期間內的報告總數
    from sqlalchemy import func as sqlfunc
    count_rows = (
        db.query(Report.stock_code, sqlfunc.count(Report.id).label("cnt"))
        .filter(
            Report.stock_code != "MARKET",
            Report.target_price.isnot(None),
            sqlfunc.coalesce(Report.report_date, sqlfunc.date(Report.created_at)) >= since_str,
        )
        .group_by(Report.stock_code)
        .all()
    )
    count_map: dict[str, int] = {row.stock_code: row.cnt for row in count_rows}

    # 3. 計算 upside_pct 並篩選有效值
    ranking = []
    for r in reports:
        info = price_map.get(r.stock_code) or {}
        current_price = info.get("price")
        if current_price and current_price > 0 and r.target_price:
            upside_pct = (r.target_price / current_price - 1) * 100
            ranking.append({
                "stock_code": r.stock_code,
                "stock_name": r.stock_name,
                "target_price": r.target_price,
                "current_price": current_price,
                "volume": info.get("volume"),
                "upside_pct": round(upside_pct, 1),
                "recommendation": r.recommendation,
                "analyst": r.analyst,
                "report_date": r.report_date,
                "report_count": count_map.get(r.stock_code, 1),
            })

    # 4. 排序並取前 50 筆
    ranking.sort(key=lambda x: x["upside_pct"], reverse=True)
    return ranking[:50]


# ────────────────────────────────────────────────────────────
# 投顧精選（Recommendations）：規則式綜合評分
# ────────────────────────────────────────────────────────────

_REC_SCORE = {
    "買進": 3, "Buy": 3, "強力買進": 3, "Strong Buy": 3,
    "增持": 2, "Overweight": 2, "Outperform": 2, "Add": 2,
    "持有": 1, "Hold": 1, "中立": 0, "Neutral": 0, "Equal-Weight": 0,
    "減持": -1, "Underweight": -1, "Reduce": -1,
    "賣出": -2, "Sell": -2, "Underperform": -2,
}


def _compute_score(item: dict) -> tuple[float, dict]:
    """分析師訊號評分 (0–100)，用於排行。upside + 共識 + 報告新鮮度。"""
    # Upside (cap +50%)：最高 40
    up = item.get("upside_pct")
    s_upside = max(0.0, min(40.0, (min(up, 50) * 0.8) if up is not None else 0.0))

    # 投顧共識：報告數 (cap 5) × 4 + rec_avg × 4。最高 40
    rep_cnt = min(item.get("report_count", 0), 5)
    rec_avg = item.get("rec_avg") or 0
    s_consensus = max(0.0, min(40.0, rep_cnt * 4.0 + rec_avg * 4.0))

    # 報告新鮮度：最新報告距今天數，180 天歸零。最高 20
    latest_date = item.get("latest_report_date")
    s_fresh = 0.0
    if latest_date:
        if isinstance(latest_date, str):
            try:
                from datetime import date as _date
                latest_date = _date.fromisoformat(latest_date)
            except Exception:
                latest_date = None
        if latest_date:
            days_old = (date.today() - latest_date).days
            s_fresh = max(0.0, 20.0 * (1 - days_old / 180))

    total = round(min(100.0, s_upside + s_consensus + s_fresh), 1)
    breakdown = {
        "upside": round(s_upside, 1),
        "consensus": round(s_consensus, 1),
        "freshness": round(s_fresh, 1),
    }
    return total, breakdown


def _compute_market_score(item: dict) -> tuple[float, dict]:
    """市場即時訊號評分 (0–100)，僅展示不排序。籌碼 + 技術面。"""
    inst = item.get("inst_5d_net") or 0
    s_inst = max(0.0, min(50.0, inst / 1000.0))

    s_tech = 0.0
    if item.get("ma_signal") == "多頭排列":
        s_tech += 25.0
    if item.get("volume_signal") == "量增":
        s_tech += 25.0

    total = round(s_inst + s_tech, 1)
    breakdown = {
        "institutional": round(s_inst, 1),
        "technical": round(s_tech, 1),
    }
    return total, breakdown


async def _compute_candidates(days: int, min_reports: int, rec_filter: str, db) -> list[dict]:
    """從 DB 查詢候選股，回傳 candidates list（純 CPU，無 IO）。"""
    cutoff = datetime.utcnow() - timedelta(days=days)
    rows = (
        db.query(Report)
        .filter(
            Report.stock_code != "MARKET",
            Report.target_price.isnot(None),
            Report.created_at >= cutoff,
        )
        .all()
    )
    by_stock: dict[str, list[Report]] = {}
    for r in rows:
        by_stock.setdefault(r.stock_code, []).append(r)

    candidates: list[dict] = []
    for code, reports in by_stock.items():
        if len(reports) < min_reports:
            continue
        latest = max(reports, key=lambda r: (r.report_date or date.min, r.id))
        rec_scores = [_REC_SCORE.get(r.recommendation, 0) for r in reports if r.recommendation]
        rec_avg = sum(rec_scores) / len(rec_scores) if rec_scores else 0
        if rec_filter == "buy_only" and rec_avg < 1.5:
            continue
        candidates.append({
            "code": code,
            "name": resolve_name(code, latest.stock_name),
            "target_price": latest.target_price,
            "latest_recommendation": latest.recommendation,
            "latest_analyst": latest.analyst,
            "latest_report_date": latest.report_date,
            "latest_report_price": latest.price_at_report,
            "report_count": len(reports),
            "rec_avg": round(rec_avg, 2),
            "rec_max_score": max(rec_scores) if rec_scores else 0,
        })
    return candidates


async def _fetch_all_market_data(candidates: list[dict]) -> tuple[dict, dict, dict]:
    """並行抓所有候選股的價格、技術訊號、法人籌碼。回傳三個 map。"""
    sem_price = asyncio.Semaphore(8)
    sem_signal, sem_inst = _get_sems()  # 全域 semaphore，跨任務限制並發

    def _fetch_price_sync(code: str):
        url = f"https://www.nstock.tw/api/v2/real-time-quotes/data?stock_id={code}"
        try:
            with httpx.Client(timeout=5) as client:
                data = client.get(url).json().get("data", [])
            if not data:
                return code, None
            row = data[0]
            _chg = float(row.get("漲跌幅") or 0)
            return code, {
                "price": float(row.get("當盤成交價") or 0) or None,
                # 台股漲跌停 ±10%；nstock 在開盤前會回傳 -100 作為佔位，需過濾
                "change_pct": _chg if _chg and abs(_chg) <= 20 else None,
                "volume": int(float(row.get("累積成交量") or 0)) or None,
            }
        except Exception:
            return code, None

    async def fetch_price(code):
        async with sem_price:
            try:
                return await asyncio.to_thread(_fetch_price_sync, code)
            except Exception:
                return code, None

    async def fetch_signal(code):
        from price_analysis import get_signals
        async with sem_signal:
            try:
                return code, await asyncio.wait_for(
                    asyncio.to_thread(get_signals, code), timeout=8
                )
            except Exception:
                return code, None

    async def fetch_inst(code):
        from fundamental_analysis import get_institutional
        async with sem_inst:
            try:
                return code, await asyncio.wait_for(
                    asyncio.to_thread(get_institutional, code, 5), timeout=10
                )
            except Exception:
                return code, None

    codes = [c["code"] for c in candidates]
    prices, signals, insts = await asyncio.gather(
        asyncio.gather(*[fetch_price(c) for c in codes]),
        asyncio.gather(*[fetch_signal(c) for c in codes]),
        asyncio.gather(*[fetch_inst(c) for c in codes]),
    )
    return dict(prices), dict(signals), dict(insts)


def _build_result(candidates: list[dict], price_map: dict, signal_map: dict, inst_map: dict, limit: int) -> dict:
    """合併市場資料、算分、排序，回傳最終 result dict。"""
    items: list[dict] = []
    for c in candidates:
        code = c["code"]
        p = price_map.get(code)
        c["current_price"] = p.get("price") if p else None
        c["change_pct"] = p.get("change_pct") if p else None
        c["volume"] = p.get("volume") if p else None

        if c["current_price"] and c["target_price"]:
            c["upside_pct"] = round((c["target_price"] / c["current_price"] - 1) * 100, 1)
        else:
            c["upside_pct"] = None

        rp = c.get("latest_report_price")
        if rp and c["current_price"]:
            c["gain_since_report"] = round((c["current_price"] / rp - 1) * 100, 1)
        else:
            c["gain_since_report"] = None

        sig = signal_map.get(code)
        c["ma_signal"] = sig.get("ma_signal") if sig else None
        c["volume_signal"] = sig.get("volume_signal") if sig else None
        c["rsi"] = sig.get("rsi") if sig else None

        inst_rows = inst_map.get(code) or []
        c["inst_5d_net"] = int(sum((d.get("total") or 0) for d in inst_rows))
        c["score"], c["score_breakdown"] = _compute_score(c)
        c["market_score"], c["market_breakdown"] = _compute_market_score(c)
        items.append(c)

    items.sort(key=lambda x: x["score"], reverse=True)
    return {
        "items": items[:limit],
        "warnings": [],
        "computed_at": datetime.utcnow().isoformat(),
    }


async def _compute_recommendations_bg(
    cache_key: str, days: int, min_reports: int, rec_filter: str, limit: int
):
    """背景計算投顧精選，完成後寫入記憶體與 DB 快取。"""
    import logging as _log
    import time as _time
    from database import SessionLocal
    from models import RecommendationCache
    _logger = _log.getLogger(__name__)

    if cache_key in _computing_keys:
        return
    _computing_keys.add(cache_key)
    _logger.info("Background compute started for %s", cache_key)
    db = SessionLocal()
    try:
        candidates = await _compute_candidates(days, min_reports, rec_filter, db)
        if not candidates:
            result: dict = {"items": [], "warnings": [], "computed_at": datetime.utcnow().isoformat()}
        else:
            # 記憶體保護：限制最多處理 _MAX_CANDIDATES 支，優先取共識分高的
            if len(candidates) > _MAX_CANDIDATES:
                candidates.sort(key=lambda c: c["rec_avg"] * c["report_count"], reverse=True)
                candidates = candidates[:_MAX_CANDIDATES]
            price_map, signal_map, inst_map = await _fetch_all_market_data(candidates)
            result = _build_result(candidates, price_map, signal_map, inst_map, limit)

        _rec_cache[cache_key] = (result, _time.time())
        payload_str = json.dumps(result, ensure_ascii=False, default=str)
        existing = db.get(RecommendationCache, cache_key)
        if existing:
            existing.payload = payload_str
            existing.computed_at = datetime.utcnow()
        else:
            db.add(RecommendationCache(cache_key=cache_key, payload=payload_str, computed_at=datetime.utcnow()))
        db.commit()
        _logger.info("Background compute done for %s (%d items)", cache_key, len(result.get("items", [])))
    except Exception as e:
        _logger.warning("Background compute failed for %s: %s", cache_key, e)
        db.rollback()
    finally:
        _computing_keys.discard(cache_key)
        db.close()


@router.get("/recommendations")
async def get_recommendations(
    days: int = Query(default=30, ge=1, le=180),
    min_reports: int = Query(default=1, ge=1, le=10),
    rec_filter: str = Query(default="all"),   # "all" | "buy_only"
    limit: int = Query(default=20, ge=1, le=50),
    force: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    """投顧精選排行：永遠從快取立即回傳，背景非同步更新。force=true 強制背景重算。"""
    import logging as _log
    import time as _time
    from models import RecommendationCache
    _logger = _log.getLogger(__name__)
    cache_key = f"v3_{days}_{min_reports}_{rec_filter}_{limit}"

    # 1. in-memory cache（最快，10 分鐘 TTL）；force=True 時跳過
    if not force:
        cached = _rec_cache.get(cache_key)
        if cached and (_time.time() - cached[1]) < _REC_CACHE_TTL:
            return cached[0]

    # 2. DB cache（跨重啟持久）— 不論過不過期都先回傳，過期或 force 則背景更新
    db_row = db.get(RecommendationCache, cache_key)
    if db_row:
        result = json.loads(db_row.payload)
        _rec_cache[cache_key] = (result, _time.time())
        age = (datetime.utcnow() - db_row.computed_at).total_seconds()
        if (force or age >= _REC_DB_CACHE_TTL) and cache_key not in _computing_keys:
            _logger.info("Triggering background recompute for %s (force=%s, age=%.0fs)", cache_key, force, age)
            asyncio.create_task(_compute_recommendations_bg(cache_key, days, min_reports, rec_filter, limit))
        return result

    # 3. 完全沒有快取：立即回空，背景計算
    if cache_key not in _computing_keys:
        _logger.info("No cache for %s, triggering background compute", cache_key)
        asyncio.create_task(_compute_recommendations_bg(cache_key, days, min_reports, rec_filter, limit))
    return {"items": [], "warnings": ["正在計算中，請稍後重新整理"], "computed_at": datetime.utcnow().isoformat()}


_REASON_SYSTEM = """你是資深投資編輯。根據提供的投顧報告 + 量價/籌碼/基本面資料，為一檔個股寫一段「為什麼值得關注」的推薦理由。

要求：
- 約 150–200 字，純文字、一段內寫完
- 結構：投顧觀點（評等共識 / 目標價 / 主要邏輯）→ 量價技術面驗證 → 籌碼或基本面確認 → 結尾觀察重點
- 用陳述語氣（「呈現」「反映」「具」），不要第一人稱、不要「建議買進」「適合介入」這類詞
- 數據必須出自 context，不可編造數字
- 不用 Markdown 粗體
- 結尾埋一個觀察重點（例如「下個月營收能否延續 YoY 雙位數成長為關鍵」）
"""


@router.get("/{stock_code}/recommendation-reason")
def get_cached_recommendation_reason(
    stock_code: str,
    db: Session = Depends(get_db),
):
    """回傳已快取的推薦理由（含生成時間）；無快取時回傳 404。"""
    row = db.get(StockRecommendationReason, stock_code)
    if not row:
        raise HTTPException(404, "no cached reason")
    return {
        "stock_code": stock_code,
        "content": row.content,
        "generated_at": row.generated_at.isoformat() + "Z",  # UTC, 確保前端正確解析
    }


@router.post("/{stock_code}/recommendation-reason")
async def stream_recommendation_reason(
    stock_code: str,
    db: Session = Depends(get_db),
):
    """LLM streaming 生成個股推薦理由（~150-200 字）。SSE 格式。生成完後暫存至 DB。"""
    cutoff = datetime.utcnow() - timedelta(days=90)
    reports = (
        db.query(Report)
        .filter(
            Report.stock_code == stock_code,
            Report.created_at >= cutoff,
        )
        .order_by(Report.report_date.desc().nullslast(), Report.created_at.desc())
        .limit(8)
        .all()
    )
    if not reports:
        raise HTTPException(404, f"{stock_code} 近 90 天無投顧報告")

    name = resolve_name(stock_code, reports[0].stock_name)

    # 同步抓現價、訊號、籌碼、月營收（並行）
    def _fetch_price_sync(code: str):
        url = f"https://www.nstock.tw/api/v2/real-time-quotes/data?stock_id={code}"
        try:
            with httpx.Client(timeout=5) as client:
                data = client.get(url).json().get("data", [])
            if not data:
                return None
            row = data[0]
            return {
                "price": float(row.get("當盤成交價") or 0) or None,
                "change_pct": float(row.get("漲跌幅") or 0) or None,
                "volume": int(float(row.get("累積成交量") or 0)) or None,
            }
        except Exception:
            return None

    from price_analysis import get_signals
    from fundamental_analysis import get_institutional, get_revenue

    async def safe(fn, *args):
        try:
            return await asyncio.to_thread(fn, *args)
        except Exception:
            return None

    price, signals, inst, revenue = await asyncio.gather(
        asyncio.to_thread(_fetch_price_sync, stock_code),
        safe(get_signals, stock_code),
        safe(get_institutional, stock_code, 5),
        safe(get_revenue, stock_code),
    )

    rec_scores = [_REC_SCORE.get(r.recommendation, 0) for r in reports if r.recommendation]
    targets = [r.target_price for r in reports if r.target_price]
    rep_summary = []
    for r in reports[:5]:
        rep_summary.append({
            "date": str(r.report_date or (r.created_at.date() if r.created_at else "")),
            "analyst": r.analyst,
            "rec": r.recommendation,
            "target_price": r.target_price,
            "summary": (r.summary or "")[:200],
            "key_points": (json.loads(r.key_points)[:3] if r.key_points else []),
        })

    inst_5d_net = int(sum((d.get("total") or 0) for d in (inst or [])))

    context = {
        "code": stock_code,
        "name": name,
        "report_count_90d": len(reports),
        "rec_avg": round(sum(rec_scores) / len(rec_scores), 2) if rec_scores else 0,
        "target_price_range": [min(targets), max(targets)] if targets else None,
        "current_price": price.get("price") if price else None,
        "today_change_pct": price.get("change_pct") if price else None,
        "ma_signal": (signals or {}).get("ma_signal"),
        "volume_signal": (signals or {}).get("volume_signal"),
        "rsi": (signals or {}).get("rsi"),
        "support": (signals or {}).get("support"),
        "resistance": (signals or {}).get("resistance"),
        "inst_5d_net_lots": inst_5d_net,
        "inst_recent": (inst or [])[:5],
        "revenue": revenue,
        "reports": rep_summary,
    }

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(503, "GEMINI_API_KEY not set")

    user_msg = (
        f"請為 {stock_code} {name} 寫一段推薦理由。\n\n"
        f"Context:\n{json.dumps(context, ensure_ascii=False, indent=2, default=str)}"
    )

    # 取得一個可在 generator 內使用的 DB session（非 FastAPI DI）
    from database import SessionLocal

    def generate():
        client = genai.Client(api_key=api_key)
        model = os.environ.get("RECOMMENDATION_MODEL", "gemini-2.5-flash")
        config = genai_types.GenerateContentConfig(
            system_instruction=_REASON_SYSTEM,
            max_output_tokens=1024,
            thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
            safety_settings=_SAFETY_OFF,
        )
        max_retries = 3
        for attempt in range(max_retries):
            sent_any = False
            full_text: list[str] = []
            try:
                for chunk in client.models.generate_content_stream(
                    model=model, contents=user_msg, config=config,
                ):
                    if chunk.text:
                        sent_any = True
                        full_text.append(chunk.text)
                        yield f"data: {json.dumps({'text': chunk.text}, ensure_ascii=False)}\n\n"
                # 生成成功 → 暫存至 DB
                if full_text:
                    content = "".join(full_text)
                    _db = SessionLocal()
                    try:
                        row = _db.get(StockRecommendationReason, stock_code)
                        now = datetime.utcnow()
                        if row:
                            row.content = content
                            row.generated_at = now
                        else:
                            _db.add(StockRecommendationReason(
                                stock_code=stock_code,
                                content=content,
                                generated_at=now,
                            ))
                        _db.commit()
                    except Exception:
                        _db.rollback()
                    finally:
                        _db.close()
                yield "data: [DONE]\n\n"
                return
            except Exception as e:
                msg = str(e)
                # 只有尚未輸出任何內容時才重試，避免重複文字
                if not sent_any and attempt < max_retries - 1 and (
                    "503" in msg or "429" in msg or "UNAVAILABLE" in msg or "quota" in msg.lower()
                ):
                    wait = 2 ** attempt * 3  # 3s, 6s
                    time.sleep(wait)
                    continue
                if "503" in msg or "UNAVAILABLE" in msg:
                    friendly = "AI 模型目前需求量大，請稍後再試"
                elif "429" in msg or "quota" in msg.lower():
                    friendly = "AI 配額暫時用盡，請稍後再試"
                else:
                    friendly = "生成失敗，請稍後再試"
                yield f"data: {json.dumps({'error': friendly}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
                return

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/txf-kline")
async def get_txf_kline(db: Session = Depends(get_db)):
    """台指期（TX 近月）日K（一般+盤後全盤）+ MA + KDJ(89,9,12)。
    使用期交所 CSV 端點，每次抓一個月區間，首次呼叫約 9 個請求建庫。
    """
    import taifex as tf
    import pandas as pd
    import calendar as _cal
    from datetime import datetime, timedelta

    _FUT_CSV = "https://www.taifex.com.tw/cht/3/futDataDown"

    def to_yyyymmdd(d: str) -> str:
        return d.replace("/", "")

    def parse_float(s: str):
        try:
            return float(s.replace(",", "").strip())
        except (ValueError, AttributeError):
            return None

    def parse_int(s: str):
        try:
            return int(s.replace(",", "").strip())
        except (ValueError, AttributeError):
            return 0

    def fetch_month_csv(start: str, end: str) -> dict:
        """抓一段區間的 TX CSV，回傳 {date_yyyymmdd: candle_dict}（全盤合併）"""
        txt = tf._fetch_csv(_FUT_CSV, {
            "down_type": "1",
            "commodity_id": "TX",
            "commodity_id2": "",
            "queryStartDate": start,
            "queryEndDate": end,
        })
        if not txt:
            return {}

        # 按日期×到期月份收集 一般 與 盤後
        from collections import defaultdict
        day_data: dict = defaultdict(lambda: defaultdict(dict))
        for line in txt.splitlines()[1:]:
            cols = [c.strip() for c in line.split(",")]
            if len(cols) < 10 or not cols[0]:
                continue
            date_raw = cols[0]
            expiry   = cols[2].strip()
            session  = cols[17].strip() if len(cols) > 17 else ""
            if session not in ("一般", "盤後"):
                continue
            o = parse_float(cols[3]); h = parse_float(cols[4])
            l = parse_float(cols[5]); c = parse_float(cols[6])
            v = parse_int(cols[9])
            if not o or not c:
                continue
            date_key = date_raw.replace("/", "")
            day_data[date_key][expiry][session] = {"o": o, "h": h, "l": l, "c": c, "v": v}

        # 正確全盤定義（與多數看盤軟體一致）：
        #   日期 D 的全盤 K 棒 = 前一日盤後（夜盤）+ 當日一般盤
        #   開盤 = 前一日盤後開盤   收盤 = 當日一般盤收盤
        #   高低 = 兩段合併最高/最低

        sorted_dates = sorted(day_data.keys())  # 舊→新

        def best_expiry_for(date_key: str, session: str):
            """取當日最大成交量的到期月份"""
            expiries = day_data.get(date_key, {})
            best, best_v = None, -1
            for exp, sessions in expiries.items():
                v = sessions.get(session, {}).get("v", 0)
                if v > best_v:
                    best_v = v; best = exp
            return best

        result = {}
        for i, date_key in enumerate(sorted_dates):
            # 當日一般盤
            exp_n = best_expiry_for(date_key, "一般")
            if not exp_n:
                continue
            normal = day_data[date_key][exp_n].get("一般", {})
            if not normal:
                continue

            # 前一日盤後（若有）
            after = {}
            if i > 0:
                prev_key = sorted_dates[i - 1]
                exp_a = best_expiry_for(prev_key, "盤後")
                if exp_a:
                    after = day_data[prev_key][exp_a].get("盤後", {})

            o  = after["o"] if after.get("o") else normal["o"]
            h  = max(normal["h"], after["h"]) if after.get("h") else normal["h"]
            ll = min(normal["l"], after["l"]) if after.get("l") else normal["l"]
            c  = normal["c"]
            v  = normal["v"] + after.get("v", 0)
            result[date_key] = {"date": date_key, "open": o, "high": h, "low": ll, "close": c, "volume": v}
        return result

    # ── 1. 偵測並清除錯誤資料（price range < 200 代表全部是同一天資料）──
    all_rows = db.query(TxfCandle).order_by(TxfCandle.date.asc()).all()
    if len(all_rows) >= 10:
        closes = [r.close for r in all_rows[:30]]
        price_range = max(closes) - min(closes)
        if price_range < 200:   # 正常 260 天 TX 應有數千點範圍
            db.query(TxfCandle).delete()
            db.commit()
            all_rows = []

    # ── 2. 找出需要補的月份區間 ──
    existing = {r.date for r in all_rows}
    trading_dates = tf.recent_trading_dates(260)  # YYYY/MM/DD 最新在前
    missing = [d for d in trading_dates if to_yyyymmdd(d) not in existing]

    if missing:
        # 分組成月份區間（每個月一個請求）
        from itertools import groupby
        def month_key(d: str) -> str:
            return d[:7]  # "YYYY/MM"
        for month, group in groupby(missing, key=month_key):
            dates = list(group)
            start, end = dates[-1], dates[0]  # group 內最新在前，所以最舊=末
            candles = await asyncio.to_thread(fetch_month_csv, start, end)
            if candles:
                for date_key, c in candles.items():
                    if date_key not in existing:
                        db.merge(TxfCandle(**c))
                        existing.add(date_key)
                db.commit()
            del candles

    # ── 4. 讀取 DB 中最近 252 根日K ──
    rows = (
        db.query(TxfCandle)
        .order_by(TxfCandle.date.asc())
        .all()
    )
    rows = rows[-252:]
    if not rows:
        return {
            "candles": [], "ma5": [], "ma10": [], "ma20": [], "ma60": [],
            "kdj_k": [], "kdj_d": [], "kdj_j": [],
            "kdj_k10_price": None, "kdj_k20_price": None,
            "kdj_k80_price": None, "kdj_k90_price": None,
            "kdj_range_low": None, "kdj_range_high": None,
            "kdj_cur_k": None, "kdj_cur_d": None, "kdj_cur_j": None,
        }

    def bar_ts(date_str: str) -> int:
        d = datetime.strptime(date_str, "%Y%m%d")
        return _cal.timegm(d.timetuple())

    candles = [{"time": bar_ts(r.date), "open": r.open, "high": r.high,
                "low": r.low, "close": r.close,
                "volume": r.volume or 0} for r in rows]
    ts_list = [c["time"] for c in candles]
    closes  = pd.Series([r.close  for r in rows])
    highs   = pd.Series([r.high   for r in rows])
    lows    = pd.Series([r.low    for r in rows])

    def ma_series(window):
        s = closes.rolling(window).mean()
        return [{"time": ts_list[i], "value": round(float(v), 0)}
                for i, v in enumerate(s) if pd.notna(v)]

    # KDJ(89,9,12)
    RSV_N, K_W, D_W = 89, 1/9, 1/12
    low_min  = lows.rolling(RSV_N).min()
    high_max = highs.rolling(RSV_N).max()
    denom    = high_max - low_min
    rsv_raw  = ((closes - low_min) / denom * 100).where(denom > 0)

    k_vals, d_vals, j_vals = [], [], []
    k_prev, d_prev = 50.0, 50.0
    for r in rsv_raw:
        if pd.isna(r):
            k_vals.append(None); d_vals.append(None); j_vals.append(None)
        else:
            k = k_prev * (1 - K_W) + r * K_W
            d = d_prev * (1 - D_W) + k * D_W
            j_vals.append(round(3 * k - 2 * d, 2))
            k_vals.append(round(k, 2)); d_vals.append(round(d, 2))
            k_prev, d_prev = k, d

    def kdj_series(vals):
        return [{"time": ts_list[i]} if v is None else {"time": ts_list[i], "value": v}
                for i, v in enumerate(vals)]

    range_low  = float(low_min.iloc[-1])  if pd.notna(low_min.iloc[-1])  else float(lows.min())
    range_high = float(high_max.iloc[-1]) if pd.notna(high_max.iloc[-1]) else float(highs.max())
    rng = range_high - range_low

    return {
        "candles": candles,
        "ma5": ma_series(5), "ma10": ma_series(10),
        "ma20": ma_series(20), "ma60": ma_series(60),
        "kdj_k": kdj_series(k_vals), "kdj_d": kdj_series(d_vals), "kdj_j": kdj_series(j_vals),
        "kdj_k10_price":  round(range_low + 0.10 * rng, 0),
        "kdj_k20_price":  round(range_low + 0.20 * rng, 0),
        "kdj_k80_price":  round(range_low + 0.80 * rng, 0),
        "kdj_k90_price":  round(range_low + 0.90 * rng, 0),
        "kdj_range_low":  round(range_low, 0),
        "kdj_range_high": round(range_high, 0),
        "kdj_cur_k": next((v for v in reversed(k_vals) if v is not None), None),
        "kdj_cur_d": next((v for v in reversed(d_vals) if v is not None), None),
        "kdj_cur_j": next((v for v in reversed(j_vals) if v is not None), None),
    }


@router.get("/market-technical/history")
def get_market_technical_history(
    index: str = Query(default="taiex"),
    days: int  = Query(default=30, ge=1, le=365),
    db: Session = Depends(get_db),
):
    """大盤技術指標歷史快照（復盤用）"""
    from models import MarketTechnicalSnapshot
    rows = (
        db.query(MarketTechnicalSnapshot)
        .filter(MarketTechnicalSnapshot.index_key == index)
        .order_by(MarketTechnicalSnapshot.date.desc())
        .limit(days)
        .all()
    )
    return [{"date": r.date, **json.loads(r.payload)} for r in rows]


@router.post("/market-technical/save")
def save_market_technical(
    index: str = Query(default="taiex"),
    db: Session = Depends(get_db),
):
    """儲存今日大盤技術指標快照（可手動觸發或由排程呼叫）"""
    from models import MarketTechnicalSnapshot
    import nstock as ns
    import pandas as pd
    from price_analysis import _compute_tower, _find_levels, _make_suggestion

    _INDEX_MAP = {
        "taiex": {"nstock_id": "TWII", "market_type": "TWS"},
        "twoii": {"nstock_id": "TWO",  "market_type": "TWO"},
    }
    meta = _INDEX_MAP.get(index)
    if not meta:
        raise HTTPException(400, "unknown index")

    nid, mtype = meta["nstock_id"], meta["market_type"]
    daily = ns.get_daily(nid)
    if not daily or not daily.get("日K"):
        raise HTTPException(503, "nstock data unavailable")

    bars = daily["日K"][:60]
    closes = pd.Series([float(b["收盤價"]) for b in reversed(bars)])
    highs  = pd.Series([float(b["最高價"]) for b in reversed(bars)])
    lows   = pd.Series([float(b["最低價"]) for b in reversed(bars)])
    volumes= pd.Series([float(b.get("成交量", 0)) for b in reversed(bars)])

    cur = float(closes.iloc[-1])
    ma5  = round(float(closes.iloc[-5:].mean()), 2)
    ma20 = round(float(bars[0].get("SD20") or closes.iloc[-20:].mean()), 2)
    ma_signal = ("多頭排列" if ma5 > ma20 * 1.005 else "空頭排列" if ma5 < ma20 * 0.995 else "均線糾結")

    delta = closes.diff()
    gain  = delta.clip(lower=0).rolling(14).mean()
    loss  = (-delta.clip(upper=0)).rolling(14).mean()
    rs    = gain / loss.replace(0, float("nan"))
    rsi   = round(float(100 - 100 / (1 + rs.iloc[-1])), 1) if pd.notna(rs.iloc[-1]) else None
    rsi_signal = ("超買" if rsi and rsi >= 70 else "超賣" if rsi and rsi <= 30 else "正常")

    bb_mid = closes.rolling(20).mean(); bb_std = closes.rolling(20).std()
    bb_u = round(float((bb_mid + 2*bb_std).iloc[-1]), 2) if pd.notna(bb_std.iloc[-1]) else None
    bb_l = round(float((bb_mid - 2*bb_std).iloc[-1]), 2) if pd.notna(bb_std.iloc[-1]) else None
    pct_b = round((cur - bb_l) / (bb_u - bb_l), 3) if bb_u and bb_l and (bb_u - bb_l) > 0 else None
    bb_sig = (None if pct_b is None else
              "突破上軌" if pct_b > 1.0 else "近上軌" if pct_b >= 0.8 else
              "跌破下軌" if pct_b < 0.0 else "近下軌" if pct_b <= 0.2 else "帶內整理")

    vol1  = float(volumes.iloc[-1])
    vol20 = float(volumes[volumes > 0].iloc[-20:].mean()) if (volumes > 0).sum() >= 5 else 0
    vsig  = (None if vol1 == 0 else "量增" if vol20 > 0 and vol1 > vol20 * 1.2
             else "量縮" if vol20 > 0 and vol1 < vol20 * 0.8 else "量持平")

    tower  = _compute_tower(closes, highs, lows)
    levels = _find_levels(closes, highs, lows, cur, volumes)
    suggestion = _make_suggestion(ma_signal, vsig, rsi, None, bb_sig)

    payload = {
        "current": round(cur, 2), "ma5": ma5, "ma20": ma20,
        "ma_signal": ma_signal, "volume_signal": vsig,
        "rsi": rsi, "rsi_signal": rsi_signal,
        "bb_upper": bb_u, "bb_lower": bb_l, "bb_pct_b": pct_b, "bb_signal": bb_sig,
        "tower": tower, "resistance": levels["resistance"], "support": levels["support"],
        "suggestion": suggestion,
    }

    from datetime import timezone, timedelta
    today = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
    existing = db.query(MarketTechnicalSnapshot).filter_by(date=today, index_key=index).first()
    if existing:
        existing.payload = json.dumps(payload, ensure_ascii=False)
        existing.saved_at = datetime.utcnow()
    else:
        db.add(MarketTechnicalSnapshot(date=today, index_key=index,
                                       payload=json.dumps(payload, ensure_ascii=False)))
    db.commit()
    return {"date": today, "index": index, "saved": True}


@router.get("/market-overview")
async def get_market_overview_api():
    """大盤加權 / 上櫃指數即時資料與技術訊號"""
    from price_analysis import get_market_overview
    return await asyncio.to_thread(get_market_overview)


@router.get("/market-kline")
def get_market_kline(index: str = Query(default="taiex")):
    """大盤指數日K + MA5/10/20/60 + 自訂KDJ（RSV=9, 權重1/12, 89日區間）。
    index: taiex | twoii
    """
    import nstock as ns
    import pandas as pd
    import calendar as _cal
    from datetime import datetime, timezone, timedelta

    nid_map = {"taiex": "IX0001", "twoii": "IX0043"}
    market_type_map = {"taiex": 1, "twoii": 2}
    nid = nid_map.get(index, "IX0001")
    market_type = market_type_map.get(index, 1)

    daily = ns.get_daily(nid)
    if not daily or not daily.get("日K"):
        return {
            "candles": [], "ma5": [], "ma10": [], "ma20": [], "ma60": [],
            "kdj_k": [], "kdj_d": [], "kdj_j": [],
            "kdj_k10_price": None, "kdj_k20_price": None, "kdj_k80_price": None, "kdj_k90_price": None,
            "kdj_range_low": None, "kdj_range_high": None,
            "kdj_cur_k": None, "kdj_cur_d": None, "kdj_cur_j": None,
        }

    bars = list(reversed(daily["日K"]))   # 最新在前 → 反轉為舊→新
    # 取近 1 年（約 252 個交易日）
    bars = bars[-252:]

    def bar_ts(b: dict) -> int:
        d = datetime.strptime(str(b["交易日"]), "%Y%m%d")
        return _cal.timegm(d.timetuple())

    # 補入今日盤中棒：若 get_daily 快取尚未含今日，從即時報價補充
    tpe_today = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
    latest_bar_date = datetime.strptime(str(bars[-1]["交易日"]), "%Y%m%d").strftime("%Y-%m-%d")
    if latest_bar_date < tpe_today:
        rt = ns.find_index_quote(nid, market_type)
        if rt and rt.get("最近交易日期") == tpe_today:
            try:
                bars.append({
                    "交易日": tpe_today.replace("-", ""),
                    "開盤價": rt["開盤價"],
                    "最高價": rt["最高價"],
                    "最低價": rt["最低價"],
                    "收盤價": rt["當盤成交價"],
                    "成交量": 0,   # 盤中不顯示量棒（單位與歷史不同）
                })
            except (KeyError, TypeError):
                pass

    candles = [
        {
            "time":   bar_ts(b),
            "open":   round(float(b["開盤價"]), 2),
            "high":   round(float(b["最高價"]), 2),
            "low":    round(float(b["最低價"]), 2),
            "close":  round(float(b["收盤價"]), 2),
            "volume": int(b["成交量"]) if b.get("成交量") else 0,
        }
        for b in bars
    ]

    closes = pd.Series([float(b["收盤價"]) for b in bars])
    highs  = pd.Series([float(b["最高價"]) for b in bars])
    lows   = pd.Series([float(b["最低價"]) for b in bars])
    ts_list = [bar_ts(b) for b in bars]

    def ma_series(window):
        s = closes.rolling(window).mean()
        return [{"time": ts_list[i], "value": round(float(v), 2)}
                for i, v in enumerate(s) if pd.notna(v)]

    # ── KDJ(89,9,12)：RSV=89天、K權重1/9、D權重1/12 ──
    RSV_N = 89   # RSV 回看天數（同時也是 K=20/K=80 估算區間）
    K_W   = 1/9  # K 平滑權重 (M1=9)
    D_W   = 1/12 # D 平滑權重 (M2=12)

    low_min  = lows.rolling(RSV_N).min()
    high_max = highs.rolling(RSV_N).max()
    denom    = high_max - low_min
    rsv_raw  = ((closes - low_min) / denom * 100).where(denom > 0)

    k_vals, d_vals, j_vals = [], [], []
    k_prev, d_prev = 50.0, 50.0
    for r in rsv_raw:
        if pd.isna(r):
            k_vals.append(None); d_vals.append(None); j_vals.append(None)
        else:
            k = k_prev * (1 - K_W) + r * K_W
            d = d_prev * (1 - D_W) + k * D_W
            j_vals.append(round(3 * k - 2 * d, 2))
            k_vals.append(round(k, 2))
            d_vals.append(round(d, 2))
            k_prev, d_prev = k, d

    def kdj_series(vals):
        # 包含暖機期的空白點（僅 time），確保與 K 線圖 bar 數一致，logical range 同步才能對齊
        return [{"time": ts_list[i]} if v is None else {"time": ts_list[i], "value": v}
                for i, v in enumerate(vals)]

    range_low  = float(low_min.iloc[-1]) if pd.notna(low_min.iloc[-1]) else float(lows.min())
    range_high = float(high_max.iloc[-1]) if pd.notna(high_max.iloc[-1]) else float(highs.max())
    rng = range_high - range_low
    k10_price  = round(range_low + 0.10 * rng, 2)
    k20_price  = round(range_low + 0.20 * rng, 2)
    k80_price  = round(range_low + 0.80 * rng, 2)
    k90_price  = round(range_low + 0.90 * rng, 2)

    last_k = next((v for v in reversed(k_vals) if v is not None), None)
    last_d = next((v for v in reversed(d_vals) if v is not None), None)
    last_j = next((v for v in reversed(j_vals) if v is not None), None)

    # ── 技術分析摘要（直接從已有資料計算，不需再呼叫 market_overview）──
    try:
        from price_analysis import _compute_tower, _find_levels, _make_suggestion
        _ma5_val  = float(closes.iloc[-5:].mean())
        _ma20_val = float(closes.rolling(20).mean().iloc[-1]) if len(closes) >= 20 else float(closes.mean())
        _ma_signal = ("多頭排列" if _ma5_val > _ma20_val * 1.005
                      else "空頭排列" if _ma5_val < _ma20_val * 0.995
                      else "均線糾結")

        # RSI(14)
        _delta = closes.diff()
        _gain  = _delta.clip(lower=0).rolling(14).mean()
        _loss  = (-_delta.clip(upper=0)).rolling(14).mean()
        _rs    = _gain / _loss.replace(0, float("nan"))
        _rsi_val = round(float(100 - 100 / (1 + _rs.iloc[-1])), 1) if pd.notna(_rs.iloc[-1]) else None
        _rsi_signal = ("超買" if _rsi_val and _rsi_val >= 70 else "超賣" if _rsi_val and _rsi_val <= 30 else "正常")

        # 布林通道(20)
        _bb_mid   = closes.rolling(20).mean()
        _bb_std   = closes.rolling(20).std()
        _bb_upper = round(float((_bb_mid + 2 * _bb_std).iloc[-1]), 2) if pd.notna(_bb_std.iloc[-1]) else None
        _bb_lower = round(float((_bb_mid - 2 * _bb_std).iloc[-1]), 2) if pd.notna(_bb_std.iloc[-1]) else None
        _cur = float(closes.iloc[-1])
        if _bb_upper and _bb_lower and (_bb_upper - _bb_lower) > 0:
            _pct_b = round((_cur - _bb_lower) / (_bb_upper - _bb_lower), 3)
            _bb_sig = ("突破上軌" if _pct_b > 1.0 else "近上軌" if _pct_b >= 0.8
                       else "跌破下軌" if _pct_b < 0.0 else "近下軌" if _pct_b <= 0.2
                       else "帶內整理")
        else:
            _pct_b, _bb_sig = None, None

        # 成交量訊號
        _vols = pd.Series([c.get("volume", 0) for c in candles])
        _vol1  = float(_vols.iloc[-1])
        _vol20 = float(_vols[_vols > 0].iloc[-20:].mean()) if (_vols > 0).sum() >= 5 else 0
        _vsig  = (None if _vol1 == 0 else "量增" if _vol20 > 0 and _vol1 > _vol20 * 1.2
                  else "量縮" if _vol20 > 0 and _vol1 < _vol20 * 0.8 else "量持平")

        _tower = _compute_tower(closes, highs, lows)
        _levels = _find_levels(closes, highs, lows, _cur,
                               pd.Series([float(b.get("成交量", 0)) for b in bars]))
        _change_pct = round((_cur - float(bars[-2]["收盤價"])) / float(bars[-2]["收盤價"]) * 100, 2) if len(bars) >= 2 else 0.0
        _suggestion = _make_suggestion(_ma_signal, _vsig, _rsi_val, _change_pct, _bb_sig, change_pct_today=_change_pct)

        technical = {
            "current": round(_cur, 2),
            "ma5":  round(_ma5_val, 2),
            "ma20": round(_ma20_val, 2),
            "ma_signal":     _ma_signal,
            "volume_signal": _vsig,
            "rsi":           _rsi_val,
            "rsi_signal":    _rsi_signal,
            "bb_upper":      _bb_upper,
            "bb_lower":      _bb_lower,
            "bb_pct_b":      _pct_b,
            "bb_signal":     _bb_sig,
            "tower":         _tower,
            "resistance":    _levels["resistance"],
            "support":       _levels["support"],
            "suggestion":    _suggestion,
        }
    except Exception:
        technical = None

    return {
        "candles": candles,
        "ma5":  ma_series(5),
        "ma10": ma_series(10),
        "ma20": ma_series(20),
        "ma60": ma_series(60),
        "kdj_k": kdj_series(k_vals),
        "kdj_d": kdj_series(d_vals),
        "kdj_j": kdj_series(j_vals),
        "kdj_k10_price":  k10_price,
        "kdj_k20_price":  k20_price,
        "kdj_k80_price":  k80_price,
        "kdj_k90_price":  k90_price,
        "kdj_range_low":  round(range_low, 2),
        "kdj_range_high": round(range_high, 2),
        "kdj_cur_k": last_k,
        "kdj_cur_d": last_d,
        "kdj_cur_j": last_j,
        "technical": technical,
    }


@router.get("/batch-prices")
async def get_batch_prices(codes: str = Query(..., description="逗號分隔的股票代碼")):
    """批次取得多支股票的即時股價（nstock.tw）"""
    code_list = [c.strip() for c in codes.split(",") if c.strip()][:30]
    semaphore = asyncio.Semaphore(10)

    def _fetch(code: str):
        url = f"https://www.nstock.tw/api/v2/real-time-quotes/data?stock_id={code}"
        try:
            with httpx.Client(timeout=5) as client:
                data = client.get(url).json().get("data", [])
                if not data:
                    return code, None
                row = data[0]
                price = float(row.get("當盤成交價") or 0) or None
                change = float(row.get("漲跌") or 0) or None
                change_pct = float(row.get("漲跌幅") or 0) or None
                return code, {"price": price, "change": change, "change_pct": change_pct}
        except Exception:
            return code, None

    async def fetch_one(code: str):
        async with semaphore:
            return await asyncio.to_thread(_fetch, code)

    results = await asyncio.gather(*[fetch_one(c) for c in code_list])
    return {code: data for code, data in results if data is not None}


@router.get("/batch-signals")
async def get_batch_signals(codes: str = Query(..., description="逗號分隔的股票代碼")):
    """批次取得多支股票的價量訊號（yfinance，1小時快取）"""
    from price_analysis import get_signals

    code_list = [c.strip() for c in codes.split(",") if c.strip()][:20]

    semaphore = asyncio.Semaphore(5)

    async def fetch_one(code: str):
        async with semaphore:
            result = await asyncio.to_thread(get_signals, code)
            return code, result

    results = await asyncio.gather(*[fetch_one(c) for c in code_list])
    return {code: data for code, data in results if data is not None}


@router.get("/batch-fundamentals")
async def get_batch_fundamentals(codes: str = Query(..., description="逗號分隔的股票代碼")):
    """批次取得月營收與法人買賣超摘要（上市股票）"""
    from fundamental_analysis import get_revenue, get_institutional

    code_list = [c.strip() for c in codes.split(",") if c.strip()][:20]
    semaphore = asyncio.Semaphore(5)

    async def fetch_one(code: str):
        async with semaphore:
            rev, inst = await asyncio.gather(
                asyncio.to_thread(get_revenue, code),
                asyncio.to_thread(get_institutional, code, 1),  # 只要今日
            )
            return code, {"revenue": rev, "inst_latest": inst[0] if inst else None}

    results = await asyncio.gather(*[fetch_one(c) for c in code_list])
    return {code: data for code, data in results}


@router.get("/{stock_code}/fundamentals")
async def get_stock_fundamentals(stock_code: str):
    """取得個股月營收與近5日法人買賣超"""
    from fundamental_analysis import get_revenue, get_institutional
    rev, inst = await asyncio.gather(
        asyncio.to_thread(get_revenue, stock_code),
        asyncio.to_thread(get_institutional, stock_code, 5),
    )
    return {"revenue": rev, "institutional": inst}


@router.get("/{stock_code}/price")
def get_stock_price(stock_code: str):
    """從 nstock.tw 取得即時股價"""
    try:
        url = f"https://www.nstock.tw/api/v2/real-time-quotes/data?stock_id={stock_code}"
        with httpx.Client(timeout=5) as client:
            resp = client.get(url)
            resp.raise_for_status()
            data = resp.json().get("data", [])
            if not data:
                return {"price": None, "change": None, "change_pct": None}
            row = data[0]
            return {
                "price": float(row.get("當盤成交價") or 0) or None,
                "change": float(row.get("漲跌") or 0) or None,
                "change_pct": float(row.get("漲跌幅") or 0) or None,
                "date": row.get("最近交易日期"),
            }
    except Exception:
        return {"price": None, "change": None, "change_pct": None}


@router.get("/search")
def search_reports(q: str = Query(default=""), db: Session = Depends(get_db)):
    """關鍵字搜尋報告與新聞，同時回傳沒有報告的個股結果"""
    keyword = q.strip()
    if not keyword:
        return {"stock_reports": [], "market_news": [], "direct_stocks": []}
    from sqlalchemy import or_, nullslast
    from models import Stock, Watchlist, EtfDailyChange
    pattern = f"%{keyword}%"
    reports = (
        db.query(Report)
        .filter(
            or_(
                Report.summary.like(pattern),
                Report.key_points.like(pattern),
                Report.stock_code.like(pattern),
                Report.stock_name.like(pattern),
                Report.analyst.like(pattern),
                Report.source_filename.like(pattern),
            )
        )
        .order_by(nullslast(Report.report_date.desc()), Report.created_at.desc())
        .limit(50)
        .all()
    )
    stock_reports = [_serialize_report(r) for r in reports if r.stock_code != "MARKET"]
    market_news = [_serialize_report(r, include_mentioned=True) for r in reports if r.stock_code == "MARKET"]

    # 找出有報告的股票代號，避免重複
    reported_codes = {r["stock_code"] for r in stock_reports}

    # 從 stocks / watchlist / etf_daily_changes 找符合但無報告的個股
    seen: dict[str, str] = {}  # code -> name
    for row in db.query(Stock.code, Stock.name).filter(
        or_(Stock.code.like(pattern), Stock.name.like(pattern))
    ).limit(20).all():
        if row.code not in reported_codes:
            seen[row.code] = row.name

    for row in db.query(Watchlist.stock_code, Watchlist.stock_name).filter(
        or_(Watchlist.stock_code.like(pattern), Watchlist.stock_name.like(pattern))
    ).limit(20).all():
        if row.stock_code not in reported_codes and row.stock_code not in seen:
            seen[row.stock_code] = row.stock_name or row.stock_code

    for row in db.query(EtfDailyChange.stock_code, EtfDailyChange.stock_name).filter(
        or_(EtfDailyChange.stock_code.like(pattern), EtfDailyChange.stock_name.like(pattern))
    ).distinct(EtfDailyChange.stock_code).limit(20).all():
        if row.stock_code not in reported_codes and row.stock_code not in seen:
            seen[row.stock_code] = row.stock_name or row.stock_code

    # 若關鍵字像股票代號（4-6 位英數）且什麼都沒找到，嘗試 nstock 即時查詢
    import re as _re
    if _re.fullmatch(r"[0-9A-Za-z]{4,6}", keyword) and keyword not in reported_codes and keyword not in seen:
        try:
            url = f"https://www.nstock.tw/api/v2/real-time-quotes/data?stock_id={keyword}"
            with httpx.Client(timeout=4) as client:
                data = client.get(url).json().get("data", [])
            if data:
                ns_name = data[0].get("股票名稱") or data[0].get("名稱") or None
                if ns_name:
                    seen[keyword] = ns_name
        except Exception:
            pass

    direct_stocks = sorted(
        [{"code": code, "name": name} for code, name in seen.items()],
        key=lambda x: x["code"],
    )
    return {"stock_reports": stock_reports, "market_news": market_news, "direct_stocks": direct_stocks}


@router.get("/recent")
def get_recent_reports(days: int = Query(default=3, ge=1, le=30), db: Session = Depends(get_db)):
    """取得近 N 天的報告，分為個股報告與市場新聞"""
    since = datetime.utcnow() - timedelta(days=days)
    from sqlalchemy import case, nullslast
    reports = (
        db.query(Report)
        .filter(Report.created_at >= since)
        .order_by(nullslast(Report.report_date.desc()), Report.created_at.desc())
        .all()
    )
    stock_reports = [_serialize_report(r) for r in reports if r.stock_code != "MARKET"]
    market_news = [_serialize_report(r, include_mentioned=True) for r in reports if r.stock_code == "MARKET"]
    return {"stock_reports": stock_reports, "market_news": market_news}


@router.get("/kdj-screen")
def kdj_screen(db: Session = Depends(get_db)):
    """讀取 KDJ(89,9,12) 選股快取（由排程每日收盤後更新）。"""
    from models import KdjScreenCache
    import json as _json

    row = db.query(KdjScreenCache).order_by(KdjScreenCache.id.desc()).first()
    if not row:
        return {"items": [], "total": 0, "scanned": 0, "computed_at": None, "data_date": None}
    items = _json.loads(row.items_json)
    return {
        "items": items,
        "total": len(items),
        "scanned": row.scanned,
        "computed_at": row.computed_at,
        "data_date": row.data_date,
    }


@router.post("/kdj-screen/refresh")
def kdj_screen_refresh(background_tasks: BackgroundTasks):
    """手動觸發 KDJ 選股重新掃描（僅掃自選股，背景執行，完成後快取更新）。"""
    from scheduler import _kdj_screen_job
    background_tasks.add_task(_kdj_screen_job, True)
    return {"status": "started"}


@router.get("/{stock_code}/kline")
def get_stock_kline(stock_code: str, period: str = Query(default="1y")):
    """Return daily OHLCV + MA5/10/20/60 + KDJ(RSV=9, K/D weight=1/12, range=89d)."""
    import yfinance as yf
    import pandas as pd
    import calendar as _cal

    ticker = yf.Ticker(f"{stock_code}.TW")
    df = ticker.history(period=period, interval="1d", auto_adjust=True)
    if df.empty:
        ticker = yf.Ticker(f"{stock_code}.TWO")
        df = ticker.history(period=period, interval="1d", auto_adjust=True)
    if df.empty:
        return {
            "candles": [], "ma5": [], "ma10": [], "ma20": [], "ma60": [],
            "kdj_k": [], "kdj_d": [], "kdj_j": [],
            "kdj_k10_price": None, "kdj_k20_price": None, "kdj_k80_price": None, "kdj_k90_price": None,
            "kdj_range_low": None, "kdj_range_high": None,
            "kdj_cur_k": None, "kdj_cur_d": None, "kdj_cur_j": None,
        }

    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    df.index = pd.to_datetime(df.index).tz_localize(None)

    def to_ts(dt):
        return _cal.timegm(dt.timetuple())

    candles = [
        {"time": to_ts(idx), "open": round(row.Open, 2), "high": round(row.High, 2),
         "low": round(row.Low, 2), "close": round(row.Close, 2),
         "volume": int(row.Volume) if pd.notna(row.Volume) else 0}
        for idx, row in df.iterrows()
    ]

    def ma_series(window):
        s = df["Close"].rolling(window).mean()
        return [{"time": to_ts(idx), "value": round(float(val), 2)}
                for idx, val in s.items() if pd.notna(val)]

    # ── KDJ(89,9,12)：RSV=89天、K權重1/9、D權重1/12 ──
    RSV_N = 89   # RSV 回看天數（同時也是 K=20/K=80 估算區間）
    K_W   = 1/9  # K 平滑權重 (M1=9)
    D_W   = 1/12 # D 平滑權重 (M2=12)

    low_min  = df["Low"].rolling(RSV_N).min()
    high_max = df["High"].rolling(RSV_N).max()
    denom    = high_max - low_min
    rsv_raw  = ((df["Close"] - low_min) / denom * 100).where(denom > 0)

    k_vals, d_vals, j_vals = [], [], []
    k_prev, d_prev = 50.0, 50.0
    for r in rsv_raw:
        if pd.isna(r):
            k_vals.append(None); d_vals.append(None); j_vals.append(None)
        else:
            k = k_prev * (1 - K_W) + r * K_W
            d = d_prev * (1 - D_W) + k * D_W
            j = 3 * k - 2 * d
            k_vals.append(round(k, 2))
            d_vals.append(round(d, 2))
            j_vals.append(round(j, 2))
            k_prev, d_prev = k, d

    def kdj_series(vals):
        return [{"time": to_ts(idx)} if v is None else {"time": to_ts(idx), "value": v}
                for idx, v in zip(df.index, vals)]

    # K=10/20/80/90 估算價：用 RSV 同週期的 89 天區間
    range_low  = float(low_min.iloc[-1])  if pd.notna(low_min.iloc[-1])  else float(df["Low"].min())
    range_high = float(high_max.iloc[-1]) if pd.notna(high_max.iloc[-1]) else float(df["High"].max())
    rng = range_high - range_low
    k10_price  = round(range_low + 0.10 * rng, 2)
    k20_price  = round(range_low + 0.20 * rng, 2)
    k80_price  = round(range_low + 0.80 * rng, 2)
    k90_price  = round(range_low + 0.90 * rng, 2)

    # 最新 KDJ 值
    last_k = next((v for v in reversed(k_vals) if v is not None), None)
    last_d = next((v for v in reversed(d_vals) if v is not None), None)
    last_j = next((v for v in reversed(j_vals) if v is not None), None)

    return {
        "candles": candles,
        "ma5":  ma_series(5),
        "ma10": ma_series(10),
        "ma20": ma_series(20),
        "ma60": ma_series(60),
        "kdj_k": kdj_series(k_vals),
        "kdj_d": kdj_series(d_vals),
        "kdj_j": kdj_series(j_vals),
        "kdj_k10_price":   k10_price,
        "kdj_k20_price":   k20_price,
        "kdj_k80_price":   k80_price,
        "kdj_k90_price":   k90_price,
        "kdj_range_low":   round(range_low, 2),
        "kdj_range_high":  round(range_high, 2),
        "kdj_cur_k": last_k,
        "kdj_cur_d": last_d,
        "kdj_cur_j": last_j,
    }


@router.get("/{stock_code}/tower-debug")
def tower_debug(stock_code: str):
    """顯示寶塔線計算的原始資料，供除錯用"""
    import yfinance as yf
    import pandas as pd
    ticker = yf.Ticker(f"{stock_code}.TW")
    hist = ticker.history(period="3mo", interval="1d", auto_adjust=True)
    if hist.empty:
        ticker = yf.Ticker(f"{stock_code}.TWO")
        hist = ticker.history(period="3mo", interval="1d", auto_adjust=True)
    if hist.empty:
        raise HTTPException(404, "no data")

    opens  = hist["Open"]
    closes = hist["Close"]
    highs  = hist["High"]
    lows   = hist["Low"]
    n = 4  # 窗口大小（含今日），與前 n-1 天比對
    rows = []
    prices = closes.tolist()
    op = opens.tolist()
    hi = highs.tolist()
    lo = lows.tolist()
    dates = [str(d.date()) for d in hist.index]
    last_brick_color = 0
    for i in range(n - 1, len(prices)):
        c = prices[i]
        max_prev_high = max(hi[i - j] for j in range(1, n))   # 前 n-1 天
        min_prev_low  = min(lo[i - j] for j in range(1, n))   # 前 n-1 天
        if c > max_prev_high:
            last_brick_color = 1
        elif c < min_prev_low:
            last_brick_color = -1
        rows.append({
            "date": dates[i],
            "open": round(op[i], 2),
            "high": round(hi[i], 2),
            "low":  round(lo[i], 2),
            "close": round(c, 2),
            "max_prev_high": round(max_prev_high, 2),
            "min_prev_low": round(min_prev_low, 2),
            "brick": "陽" if last_brick_color == 1 else ("陰" if last_brick_color == -1 else "—"),
        })
    return {"rows": rows[-20:]}  # 最近20天


@router.get("/{stock_code}/reports")
def get_stock_reports(stock_code: str, db: Session = Depends(get_db)):
    """取得某個股的所有報告 + 提及該股的市場新聞"""
    # 個股專屬報告
    from sqlalchemy import nullslast
    reports = (
        db.query(Report)
        .filter(Report.stock_code == stock_code)
        .order_by(nullslast(Report.report_date.desc()), Report.created_at.desc())
        .all()
    )

    # 市場新聞中有提及此股票的：
    # 條件一：AI 識別的 mentioned_stocks 含有此代號
    # 條件二：summary 或 key_points 文字中也出現此代號（避免僅在清單末尾被帶到）
    from sqlalchemy import or_
    news = (
        db.query(Report)
        .filter(
            Report.stock_code == "MARKET",
            Report.mentioned_stocks.like(f'%"{stock_code}"%'),
            or_(
                Report.summary.like(f"%{stock_code}%"),
                Report.key_points.like(f"%{stock_code}%"),
            ),
        )
        .order_by(Report.created_at.desc())
        .limit(10)
        .all()
    )

    _fill_prices_at_report(stock_code, reports, db)
    return {
        "reports": [_serialize_report(r) for r in reports],
        "related_news": [_serialize_report(r, include_mentioned=True) for r in news],
    }


@router.post("/admin/fill-all-prices")
async def fill_all_prices(
    background_tasks: BackgroundTasks,
    _=Depends(require_admin),
):
    """一次性批次填充所有報告的歷史價格（需 admin）"""
    background_tasks.add_task(_fill_all_prices_bg)
    return {"status": "started", "message": "背景批次填充已啟動，約需數分鐘"}


_CONCEPT_MAX_STOCKS  = 30   # 排除股票數超過此值的 ETF 型概念
_CONCEPT_STOCKS_CAP  = 6    # 每個概念最多取幾支代表股
_sector_computing    = False # 防止重複觸發背景計算

# 自訂族群清單：決定顯示順序與名稱，nstock 名稱做正規化比對
_CUSTOM_SECTOR_ORDER: list[str] = [
    # 核心科技與 AI
    "AI 伺服器", "AI 電力散熱", "高速傳輸晶片", "高速 PCB/CCL", "ASIC/IP",
    "矽光子/CPO", "AI PC/邊緣運算", "機器人", "AI 穿戴", "車用電子",
    # 半導體與材料
    "先進製程", "先進封裝", "半導體材料", "半導體先進材料", "IC 測試",
    "記憶體", "矽晶圓", "成熟製程",
    # 網通與太空
    "太空衛星", "5G/6G 網通", "光通訊", "被動元件", "車載鏡頭",
    # 綠能與政策
    "重電電網", "AI電力", "綠能儲能", "國防軍工", "無人機", "資安安控",
    # 傳產與基建
    "貨櫃航運", "散裝航運", "航空旅遊", "塑化", "鋼鐵建材", "汽車 AM", "營建資產",
    # 生技金融與修復題材
    "新藥 CDMO", "醫材醫美", "金控金融", "戰後重建",
]

def _sector_match_index(nstock_name: str) -> int:
    """回傳 nstock 名稱在自訂清單中的 index；無匹配回傳 len（排到最後）"""
    n = nstock_name.replace(" ", "").lower()
    for i, custom in enumerate(_CUSTOM_SECTOR_ORDER):
        c = custom.replace(" ", "").lower()
        if n == c or n in c or c in n:
            return i
    return len(_CUSTOM_SECTOR_ORDER)

def _sector_display_name(nstock_name: str) -> str:
    """用自訂名稱取代 nstock 原始名稱；無匹配則保留原名"""
    n = nstock_name.replace(" ", "").lower()
    for custom in _CUSTOM_SECTOR_ORDER:
        c = custom.replace(" ", "").lower()
        if n == c or n in c or c in n:
            return custom
    return nstock_name


async def _compute_sector_rotation() -> None:
    """背景計算：nstock 概念股日K 成交金額加總，結果存入 _SECTOR_CHIP_CACHE"""
    global _sector_computing
    _sector_computing = True
    try:
        # Step 1: 取概念股＋產業清單（掃全部 group，去重後比對自訂清單）
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{_NSTOCK_STRATEGY}?agent=StockChip")
            resp.raise_for_status()
            raw_groups = resp.json()

        seen_keys: set[str] = set()
        concept_keys: list[tuple[str, str]] = []
        for group in raw_groups:
            for sg in group.get("subGroup", []):
                for cond in sg.get("condition", []):
                    k = cond.get("key", "")
                    n = cond.get("name", k)
                    if k and k not in seen_keys:
                        seen_keys.add(k)
                        concept_keys.append((k, n))

        # 依自訂清單排序，過濾掉不在清單中的族群
        concept_keys.sort(key=lambda kn: _sector_match_index(kn[1]))
        concept_keys = [kn for kn in concept_keys if _sector_match_index(kn[1]) < len(_CUSTOM_SECTOR_ORDER)]
        if not concept_keys:
            return

        # Step 2: 並發抓各概念 stock_ids，篩掉超過股數上限的（ETF型）
        async def _get_stocks(key: str, name: str) -> tuple[str, str, list[str]]:
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.post(_NSTOCK_STRATEGY, json={"strategies": [{"key": key, "options": []}]})
                r.raise_for_status()
                ids = r.json().get("data", {}).get("stock_ids", [])
                return key, name, ids

        raw_results = await asyncio.gather(
            *[_get_stocks(k, n) for k, n in concept_keys],
            return_exceptions=True,
        )

        concept_map: dict[str, list[str]] = {}
        for item in raw_results:
            if isinstance(item, Exception):
                continue
            _k, name, ids = item
            if 2 <= len(ids) <= _CONCEPT_MAX_STOCKS:
                display = _sector_display_name(name)
                concept_map[display] = ids[:_CONCEPT_STOCKS_CAP]

        if not concept_map:
            return

        # Step 3: 並發抓所有不重複個股日K（semaphore 限制並發）
        all_codes = list({code for ids in concept_map.values() for code in ids})
        sem = asyncio.Semaphore(8)

        async def _fetch_one(code: str):
            async with sem:
                daily = await asyncio.to_thread(ns.get_daily, code)
            return code, daily

        stock_results = await asyncio.gather(
            *[_fetch_one(c) for c in all_codes],
            return_exceptions=True,
        )

        # 只保留最近 22 根 K 棒 + 股票名稱，釋放其餘記憶體
        stock_daily: dict[str, dict] = {}  # code → {name, bars}
        latest_date = ""
        for item in stock_results:
            if isinstance(item, Exception):
                continue
            code, daily = item
            if daily and daily.get("日K"):
                bars = daily["日K"][:22]
                stock_daily[code] = {
                    "name": daily.get("股票名稱", code),
                    "bars": bars,
                }
                if not latest_date and bars:
                    latest_date = str(bars[0].get("交易日", ""))

        def _stock_metrics(bars: list) -> tuple[float, float, float, float]:
            """回傳 (x20, x5, rt_amt, y)，成交金額單位：元"""
            series = []
            for b in reversed(bars):
                amt = float(b.get("成交金額", 0))
                if amt == 0:
                    amt = float(b.get("成交量", 0)) * float(b.get("收盤價", 0)) * 1000
                series.append(amt)
            if len(series) < 10:
                return 0, 0, 0, 0
            x20 = sum(series[-20:])
            x5  = sum(series[-5:])
            rt  = series[-1]
            y   = x5 / 5 - x20 / 20
            return x20, x5, rt, y

        # Step 4: 各概念股成交金額加總 → 動能；同時計算每支個股指標
        bubbles = []
        for name, ids in concept_map.items():
            x20_total = 0.0
            x5_total  = 0.0
            rt_total  = 0.0
            stock_items = []

            for code in ids:
                if code not in stock_daily:
                    continue
                info = stock_daily[code]
                x20, x5, rt, y = _stock_metrics(info["bars"])
                if x20 <= 0:
                    continue
                x20_total += x20
                x5_total  += x5
                rt_total  += rt
                stock_items.append({
                    "code":    code,
                    "name":    info["name"],
                    "x":       round(x20 / 1e8, 1),   # 億元
                    "y":       round(y   / 1e7, 1),   # 千萬元/日
                    "size":    round(x20 / 1e8, 1),
                    "amt_5d":  round(x5  / 1e8, 1),
                    "amt_20d": round(x20 / 1e8, 1),
                    "rt_amt":  round(rt  / 1e8, 1),
                })

            if not stock_items or x20_total <= 0:
                continue

            y_concept = x5_total / 5 - x20_total / 20

            bubbles.append({
                "name":    name,
                "x":       round(x20_total / 1e9, 1),
                "y":       round(y_concept  / 1e8, 1),
                "size":    round(x20_total / 1e9, 1),
                "amt_5d":  round(x5_total  / 1e9, 1),
                "amt_20d": round(x20_total / 1e9, 1),
                "rt_amt":  round(rt_total  / 1e8, 1),
                "stocks":  sorted(stock_items, key=lambda s: s["size"], reverse=True),
            })

        bubbles.sort(key=lambda b: b["size"], reverse=True)

        result = {
            "bubbles":      bubbles,
            "trading_days": 20,
            "latest_date":  latest_date,
            "computing":    False,
            "computed_at":  datetime.utcnow().isoformat(),
        }
        _SECTOR_CHIP_CACHE["sector_rotation"] = (result, time.time())

    except Exception:
        pass
    finally:
        _sector_computing = False


@router.get("/sector-rotation/debug-concepts")
async def sector_rotation_debug_concepts():
    """列出 nstock 所有族群 key/name，以及是否有比對到自訂清單"""
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(f"{_NSTOCK_STRATEGY}?agent=StockChip")
        resp.raise_for_status()
        raw_groups = resp.json()

    seen_keys: set[str] = set()
    rows = []
    for group in raw_groups:
        g_name = group.get("groupName", "")
        for sg in group.get("subGroup", []):
            sg_name = sg.get("name", "")
            for cond in sg.get("condition", []):
                k = cond.get("key", "")
                n = cond.get("name", k)
                if k and k not in seen_keys:
                    seen_keys.add(k)
                    idx = _sector_match_index(n)
                    matched = idx < len(_CUSTOM_SECTOR_ORDER)
                    rows.append({
                        "group": g_name, "subGroup": sg_name,
                        "key": k, "nstock_name": n,
                        "matched": matched,
                        "display_name": _sector_display_name(n) if matched else None,
                        "order_index": idx if matched else None,
                    })

    matched   = [r for r in rows if r["matched"]]
    unmatched = [r for r in rows if not r["matched"]]
    custom_missing = [
        c for c in _CUSTOM_SECTOR_ORDER
        if not any(r["display_name"] == c for r in matched)
    ]
    return {
        "matched_count": len(matched),
        "unmatched_nstock_count": len(unmatched),
        "custom_missing": custom_missing,
        "matched": sorted(matched, key=lambda r: r["order_index"]),
        "unmatched_nstock": unmatched,
    }


@router.get("/sector-rotation")
async def sector_rotation():
    """概念股輪動泡泡圖（背景計算，前端輪詢）"""
    global _sector_computing
    now = time.time()

    # 有快取且未過期 → 立刻回傳
    if "sector_rotation" in _SECTOR_CHIP_CACHE:
        data, ts = _SECTOR_CHIP_CACHE["sector_rotation"]
        if now - ts < _SECTOR_CHIP_TTL:
            return data

    # 觸發背景計算（若尚未在計算中）
    if not _sector_computing:
        asyncio.create_task(_compute_sector_rotation())

    # 回傳「計算中」狀態，前端輪詢
    return {
        "bubbles":      [],
        "trading_days": 20,
        "latest_date":  "",
        "computing":    True,
        "computed_at":  datetime.utcnow().isoformat(),
    }


class SectorAskBody(BaseModel):
    question: str

@router.post("/sector-rotation/ask")
async def sector_rotation_ask(
    body: SectorAskBody,
    user: User = Depends(get_current_user),
):
    question = body.question.strip()
    if not question:
        raise HTTPException(400, "question required")

    if "sector_rotation" not in _SECTOR_CHIP_CACHE:
        raise HTTPException(503, "資料尚未準備好，請稍後再試")

    data, _ = _SECTOR_CHIP_CACHE["sector_rotation"]
    bubbles = data.get("bubbles", [])
    latest_date = data.get("latest_date", "")

    Q_MAP = {(True, True): "主力", (False, False): "退潮", (False, True): "觀望", (True, False): "輪動"}

    ctx_lines = [f"資料日期：{latest_date}，共 {len(bubbles)} 個概念股\n"]
    for b in sorted(bubbles, key=lambda x: x["amt_20d"], reverse=True):
        ql = Q_MAP[(b["x"] >= 0, b["y"] >= 0)]
        stocks_str = "、".join(
            f"{s['code']}{s['name']}(加速{s['y']:+.0f})"
            for s in (b.get("stocks") or [])[:6]
        )
        ctx_lines.append(
            f"【{b['name']}】{ql} | 20日:{b['amt_20d']}十億 | 今日:{b['rt_amt']}億 | 加速度:{b['y']:+.1f} | 成分:{stocks_str}"
        )
    context = "\n".join(ctx_lines)

    system_prompt = (
        "你是台股概念股輪動分析師。根據下方當日籌碼資料用繁體中文回答問題，150字以內，直接回答不需開場白。"
        "象限定義：主力=資金多且加速流入；輪動=資金多但動能轉弱；觀望=資金少但開始加速；退潮=資金少且動能衰退。"
        "加速度為正表示近5日均量高於20日均量。"
    )

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(503, "GEMINI_API_KEY not set")

    async def generate():
        try:
            client = genai.Client(api_key=api_key)
            for chunk in client.models.generate_content_stream(
                model="gemini-2.5-flash",
                contents=[f"籌碼資料：\n{context}\n\n問題：{question}"],
                config=genai_types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    max_output_tokens=400,
                    thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
                    safety_settings=_SAFETY_OFF,
                ),
            ):
                if chunk.text:
                    yield f"data: {json.dumps({'text': chunk.text}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")

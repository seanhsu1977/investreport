from __future__ import annotations
import asyncio
import json
import os
import time
import httpx
from datetime import date, datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from google import genai
from google.genai import types as genai_types

_SAFETY_OFF = [
    genai_types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_NONE"),
    genai_types.SafetySetting(category="HARM_CATEGORY_HARASSMENT",         threshold="BLOCK_NONE"),
    genai_types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH",        threshold="BLOCK_NONE"),
    genai_types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT",  threshold="BLOCK_NONE"),
]

from database import get_db
from models import Report, StockRecommendationReason, TxfCandle
from stocks_master import resolve_name

router = APIRouter(prefix="/stocks", tags=["stocks"])

# Server-side in-memory cache for recommendations（TTL 10 分鐘）
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
    }
    if include_mentioned:
        d["mentioned_stocks"] = json.loads(r.mentioned_stocks) if r.mentioned_stocks else []
    return d


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
    """根據各維度算總分 (0–100)。回傳 (score, breakdown)。"""
    # Upside (cap +50%)：最高 30
    up = item.get("upside_pct")
    s_upside = max(0.0, min(30.0, (max(min(up, 50), -20) if up is not None else 0) * 0.6))

    # 投顧共識：報告數 (cap 5) × 3.5  +  rec_avg × 5。最高 ~35
    rep_cnt = min(item.get("report_count", 0), 5)
    rec_avg = item.get("rec_avg") or 0
    s_consensus = max(0.0, min(35.0, rep_cnt * 3.5 + rec_avg * 5))

    # 籌碼：法人 5 日淨買超（張）正向加分。每千張 1 分，最高 15
    inst = item.get("inst_5d_net") or 0
    s_inst = max(0.0, min(15.0, inst / 1000.0))

    # 技術：多頭排列 +10、量增 +10
    s_tech = 0.0
    if item.get("ma_signal") == "多頭排列":
        s_tech += 10.0
    if item.get("volume_signal") == "量增":
        s_tech += 10.0

    total = round(min(100.0, s_upside + s_consensus + s_inst + s_tech), 1)
    breakdown = {
        "upside": round(s_upside, 1),
        "consensus": round(s_consensus, 1),
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
            return code, {
                "price": float(row.get("當盤成交價") or 0) or None,
                "change_pct": float(row.get("漲跌幅") or 0) or None,
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

        sig = signal_map.get(code)
        c["ma_signal"] = sig.get("ma_signal") if sig else None
        c["volume_signal"] = sig.get("volume_signal") if sig else None
        c["rsi"] = sig.get("rsi") if sig else None

        inst_rows = inst_map.get(code) or []
        c["inst_5d_net"] = int(sum((d.get("total") or 0) for d in inst_rows))
        c["score"], c["score_breakdown"] = _compute_score(c)
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
    db: Session = Depends(get_db),
):
    """投顧精選排行：永遠從快取立即回傳，背景非同步更新。"""
    import logging as _log
    import time as _time
    from models import RecommendationCache
    _logger = _log.getLogger(__name__)
    cache_key = f"{days}_{min_reports}_{rec_filter}_{limit}"

    # 1. in-memory cache（最快，10 分鐘 TTL）
    cached = _rec_cache.get(cache_key)
    if cached and (_time.time() - cached[1]) < _REC_CACHE_TTL:
        return cached[0]

    # 2. DB cache（跨重啟持久）— 不論過不過期都先回傳，過期則背景更新
    db_row = db.get(RecommendationCache, cache_key)
    if db_row:
        result = json.loads(db_row.payload)
        _rec_cache[cache_key] = (result, _time.time())
        age = (datetime.utcnow() - db_row.computed_at).total_seconds()
        if age >= _REC_DB_CACHE_TTL and cache_key not in _computing_keys:
            _logger.info("DB cache stale (%.0fs), triggering background recompute for %s", age, cache_key)
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
                yield f"data: {json.dumps({'error': msg}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
                return

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/txf-kline")
async def get_txf_kline(db: Session = Depends(get_db)):
    """台指期（TX 近月）日K + MA + KDJ(89,9,12)。首次呼叫會並行抓取歷史資料存 DB。"""
    import taifex as tf
    import pandas as pd
    import calendar as _cal
    from datetime import datetime

    # ── 1. 取得需要的交易日清單（最多 260 天）──
    trading_dates = tf.recent_trading_dates(260)  # YYYY/MM/DD 最新在前

    # ── 2. 確認哪些日期 DB 還沒有 ──
    existing = {r.date for r in db.query(TxfCandle.date).all()}
    # 將 YYYY/MM/DD 轉成 YYYYMMDD 比對
    def to_yyyymmdd(d: str) -> str:
        return d.replace("/", "")
    missing = [d for d in trading_dates if to_yyyymmdd(d) not in existing]

    # ── 3. 並行抓取缺失的日期（semaphore 控制 15 並發）──
    if missing:
        sem = asyncio.Semaphore(15)
        _BASE_URL = "https://openapi.taifex.com.tw/v1/DailyMarketReportFut"

        async def fetch_one(query_date: str):
            async with sem:
                url = f"{_BASE_URL}?queryDate={query_date}"
                try:
                    async with httpx.AsyncClient(timeout=10) as client:
                        resp = await client.get(url)
                        resp.raise_for_status()
                        rows = resp.json()
                        # 取近月合約（成交量最大的一般盤 TX）
                        tx_rows = [r for r in rows
                                   if r.get("Contract") == "TX"
                                   and r.get("TradingSession") == "一般"
                                   and r.get("Open") not in (None, "", "0")]
                        if not tx_rows:
                            return None
                        near = max(tx_rows, key=lambda r: int(r.get("Volume", 0) or 0))
                        return {
                            "date":   to_yyyymmdd(query_date),
                            "open":   float(near["Open"]),
                            "high":   float(near["High"]),
                            "low":    float(near["Low"]),
                            "close":  float(near["Last"]),
                            "volume": int(near.get("Volume") or 0),
                        }
                except Exception:
                    return None

        results = await asyncio.gather(*[fetch_one(d) for d in missing])
        new_candles = [r for r in results if r]
        if new_candles:
            for c in new_candles:
                if c["date"] not in existing:
                    db.merge(TxfCandle(**c))
            db.commit()

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
                "low": r.low, "close": r.close} for r in rows]
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
    from datetime import datetime

    nid_map = {"taiex": "IX0001", "twoii": "IX0043"}
    nid = nid_map.get(index, "IX0001")

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

    candles = [
        {
            "time":  bar_ts(b),
            "open":  round(float(b["開盤價"]), 2),
            "high":  round(float(b["最高價"]), 2),
            "low":   round(float(b["最低價"]), 2),
            "close": round(float(b["收盤價"]), 2),
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
    """關鍵字搜尋報告與新聞"""
    keyword = q.strip()
    if not keyword:
        return {"stock_reports": [], "market_news": []}
    from sqlalchemy import or_, nullslast
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
    return {"stock_reports": stock_reports, "market_news": market_news}


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
         "low": round(row.Low, 2), "close": round(row.Close, 2)}
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

    return {
        "reports": [_serialize_report(r) for r in reports],
        "related_news": [_serialize_report(r, include_mentioned=True) for r in news],
    }

from __future__ import annotations
import asyncio
import json
import os
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
from models import Report
from stocks_master import resolve_name

router = APIRouter(prefix="/stocks", tags=["stocks"])

# Server-side cache for recommendations（TTL 10 分鐘）
_rec_cache: dict[str, tuple[dict, float]] = {}
_REC_CACHE_TTL = 10 * 60


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


@router.get("/recommendations")
async def get_recommendations(
    days: int = Query(default=30, ge=1, le=180),
    min_reports: int = Query(default=1, ge=1, le=10),
    rec_filter: str = Query(default="all"),   # "all" | "buy_only"
    limit: int = Query(default=20, ge=1, le=50),
    db: Session = Depends(get_db),
):
    """投顧精選排行：依共識度 + 籌碼 + 量價綜合評分。"""
    import time
    cache_key = f"{days}_{min_reports}_{rec_filter}_{limit}"
    cached = _rec_cache.get(cache_key)
    if cached and (time.time() - cached[1]) < _REC_CACHE_TTL:
        return cached[0]

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

    # group by stock_code
    by_stock: dict[str, list[Report]] = {}
    for r in rows:
        by_stock.setdefault(r.stock_code, []).append(r)

    # 過濾報告數
    candidates: list[dict] = []
    for code, reports in by_stock.items():
        if len(reports) < min_reports:
            continue
        # 取最新一篇當代表（含目標價、最新評等、analyst）
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

    if not candidates:
        return {"items": [], "warnings": [], "computed_at": datetime.utcnow().isoformat()}

    # 並行抓現價、訊號、籌碼
    semaphore = asyncio.Semaphore(8)

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
        async with semaphore:
            try:
                return await asyncio.to_thread(_fetch_price_sync, code)
            except Exception:
                return code, None

    async def fetch_signal(code):
        from price_analysis import get_signals
        async with semaphore:
            try:
                return code, await asyncio.to_thread(get_signals, code)
            except Exception:
                return code, None

    async def fetch_inst(code):
        from fundamental_analysis import get_institutional
        async with semaphore:
            try:
                return code, await asyncio.to_thread(get_institutional, code, 5)
            except Exception:
                return code, None

    codes = [c["code"] for c in candidates]
    prices, signals, insts = await asyncio.gather(
        asyncio.gather(*[fetch_price(c) for c in codes]),
        asyncio.gather(*[fetch_signal(c) for c in codes]),
        asyncio.gather(*[fetch_inst(c) for c in codes]),
    )
    price_map = dict(prices)
    signal_map = dict(signals)
    inst_map = dict(insts)

    # 補資料 + 算分
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
        if sig:
            c["ma_signal"] = sig.get("ma_signal")
            c["volume_signal"] = sig.get("volume_signal")
            c["rsi"] = sig.get("rsi")
        else:
            c["ma_signal"] = None
            c["volume_signal"] = None
            c["rsi"] = None

        inst_rows = inst_map.get(code) or []
        c["inst_5d_net"] = int(sum((d.get("total") or 0) for d in inst_rows))

        c["score"], c["score_breakdown"] = _compute_score(c)
        items.append(c)

    items.sort(key=lambda x: x["score"], reverse=True)

    warnings: list[str] = []
    try:
        from fundamental_analysis import is_t86_blocked
        if is_t86_blocked():
            warnings.append("TWSE T86 暫時無法存取（被 rate-limit），籌碼面分數本次未列入計算。")
    except Exception:
        pass

    result = {
        "items": items[:limit],
        "warnings": warnings,
        "computed_at": datetime.utcnow().isoformat(),
    }
    import time
    _rec_cache[cache_key] = (result, time.time())
    return result


_REASON_SYSTEM = """你是資深投資編輯。根據提供的投顧報告 + 量價/籌碼/基本面資料，為一檔個股寫一段「為什麼值得關注」的推薦理由。

要求：
- 約 150–200 字，純文字、一段內寫完
- 結構：投顧觀點（評等共識 / 目標價 / 主要邏輯）→ 量價技術面驗證 → 籌碼或基本面確認 → 結尾觀察重點
- 用陳述語氣（「呈現」「反映」「具」），不要第一人稱、不要「建議買進」「適合介入」這類詞
- 數據必須出自 context，不可編造數字
- 不用 Markdown 粗體
- 結尾埋一個觀察重點（例如「下個月營收能否延續 YoY 雙位數成長為關鍵」）
"""


@router.post("/{stock_code}/recommendation-reason")
async def stream_recommendation_reason(
    stock_code: str,
    db: Session = Depends(get_db),
):
    """LLM streaming 生成個股推薦理由（~150-200 字）。SSE 格式。"""
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

    def generate():
        try:
            client = genai.Client(api_key=api_key)
            for chunk in client.models.generate_content_stream(
                model=os.environ.get("RECOMMENDATION_MODEL", "gemini-2.5-flash"),
                contents=user_msg,
                config=genai_types.GenerateContentConfig(
                    system_instruction=_REASON_SYSTEM,
                    max_output_tokens=600,
                    safety_settings=_SAFETY_OFF,
                ),
            ):
                if chunk.text:
                    yield f"data: {json.dumps({'text': chunk.text}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/market-overview")
async def get_market_overview_api():
    """大盤加權 / 上櫃指數即時資料與技術訊號"""
    from price_analysis import get_market_overview
    return await asyncio.to_thread(get_market_overview)


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

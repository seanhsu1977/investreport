from __future__ import annotations
import asyncio
import json
import httpx
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
from models import Report
from stocks_master import resolve_name

router = APIRouter(prefix="/stocks", tags=["stocks"])


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

    def _fetch_price_sync(code: str) -> tuple[str, float | None]:
        url = f"https://www.nstock.tw/api/v2/real-time-quotes/data?stock_id={code}"
        try:
            with httpx.Client(timeout=5) as client:
                resp = client.get(url)
                data = resp.json().get("data", [])
                if not data:
                    return code, None
                price = float(data[0].get("當盤成交價") or 0) or None
                return code, price
        except Exception:
            return code, None

    async def fetch_price(code: str) -> tuple[str, float | None]:
        async with semaphore:
            return await asyncio.to_thread(_fetch_price_sync, code)

    price_results = await asyncio.gather(*[fetch_price(c) for c in codes])
    price_map: dict[str, float | None] = dict(price_results)

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
        current_price = price_map.get(r.stock_code)
        if current_price and current_price > 0 and r.target_price:
            upside_pct = (r.target_price / current_price - 1) * 100
            ranking.append({
                "stock_code": r.stock_code,
                "stock_name": r.stock_name,
                "target_price": r.target_price,
                "current_price": current_price,
                "upside_pct": round(upside_pct, 1),
                "recommendation": r.recommendation,
                "analyst": r.analyst,
                "report_date": r.report_date,
                "report_count": count_map.get(r.stock_code, 1),
            })

    # 4. 排序並取前 50 筆
    ranking.sort(key=lambda x: x["upside_pct"], reverse=True)
    return ranking[:50]


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

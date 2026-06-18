import json
import os
import re
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from sqlalchemy import func, nullslast
from sqlalchemy.orm import Session
from google import genai
from google.genai import types as genai_types

from database import get_db
from models import Report, Watchlist, WatchlistGroup
from routers.auth import get_current_user, User
from stocks_master import resolve_name

router = APIRouter(prefix="/watchlist", tags=["watchlist"])


class WatchlistAdd(BaseModel):
    stock_code: str
    stock_name: Optional[str] = None


@router.get("")
def get_watchlist(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """取得目前使用者的自選股清單"""
    items = (
        db.query(Watchlist)
        .filter(Watchlist.user_id == user.id)
        .order_by(Watchlist.added_at.desc())
        .all()
    )
    result = []
    for item in items:
        latest = (
            db.query(Report)
            .filter(Report.stock_code == item.stock_code)
            .order_by(
                nullslast(Report.report_date.desc()),
                Report.created_at.desc(),
            )
            .first()
        )
        canonical = resolve_name(item.stock_code, item.stock_name)
        result.append({
            "stock_code": item.stock_code,
            "stock_name": canonical,
            "group_id": item.group_id,
            "added_at": item.added_at,
            "latest_report": {
                "id": latest.id,
                "stock_code": latest.stock_code,
                "stock_name": resolve_name(latest.stock_code, latest.stock_name),
                "recommendation": latest.recommendation,
                "target_price": latest.target_price,
                "analyst": latest.analyst,
                "report_date": latest.report_date,
                "summary": latest.summary,
                "key_points": json.loads(latest.key_points) if latest.key_points else [],
                "created_at": latest.created_at,
                "source_filename": latest.source_filename,
            } if latest else None,
        })
    return result


@router.post("", status_code=201)
def add_to_watchlist(body: WatchlistAdd, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    existing = (
        db.query(Watchlist)
        .filter(Watchlist.user_id == user.id, Watchlist.stock_code == body.stock_code)
        .first()
    )
    if existing:
        raise HTTPException(status_code=409, detail="Stock already in watchlist")

    stock_name = body.stock_name
    if not stock_name:
        report = db.query(Report).filter(Report.stock_code == body.stock_code).first()
        if report:
            stock_name = report.stock_name
    stock_name = resolve_name(body.stock_code, stock_name)

    item = Watchlist(user_id=user.id, stock_code=body.stock_code, stock_name=stock_name)
    db.add(item)
    db.commit()
    db.refresh(item)
    return {"stock_code": item.stock_code, "stock_name": item.stock_name, "added_at": item.added_at}


@router.post("/parse-image")
async def parse_watchlist_image(
    file: UploadFile = File(...),
    _: User = Depends(get_current_user),
):
    """上傳截圖，用 Gemini Vision 解析出股票代號與名稱清單。"""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(503, "GEMINI_API_KEY not set")

    data = await file.read()
    mime = file.content_type or "image/png"

    client = genai.Client(api_key=api_key)
    resp = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[
            genai_types.Part.from_bytes(data=data, mime_type=mime),
            "請從這張截圖中找出所有台股股票代號和對應的股票名稱。"
            "台股代號格式為4~5位數字、或數字後接英文字母（例如 2330、00937B、00679B、006208）。"
            "只回傳 JSON 陣列，格式：[{\"code\":\"2330\",\"name\":\"台積電\"}, ...]。"
            "若同一檔出現多次只列一次。若找不到任何股票回傳空陣列 []。",
        ],
        config=genai_types.GenerateContentConfig(
            max_output_tokens=1024,
            safety_settings=[
                genai_types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_NONE"),
            ],
        ),
    )
    text = resp.text.strip()
    # 優先從 code block 內抓 JSON
    m = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", text, re.DOTALL)
    if m:
        text = m.group(1)
    else:
        # 退而求其次：找第一個 [ ... ] 陣列
        m2 = re.search(r"(\[.*\])", text, re.DOTALL)
        if m2:
            text = m2.group(1)
    try:
        stocks = json.loads(text)
    except Exception:
        raise HTTPException(422, f"Gemini 回傳無法解析：{text[:200]}")

    # 補 resolve_name
    result = []
    for s in stocks:
        code = str(s.get("code", "")).strip()
        name = s.get("name") or resolve_name(code) or None
        if code:
            result.append({"code": code, "name": name})
    return {"stocks": result}


# ── 分組 CRUD ──────────────────────────────────────────────

class GroupCreate(BaseModel):
    name: str

class GroupRename(BaseModel):
    name: str

class GroupAssign(BaseModel):
    group_id: Optional[int] = None


@router.get("/groups")
def list_groups(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    groups = (
        db.query(WatchlistGroup)
        .filter(WatchlistGroup.user_id == user.id)
        .order_by(WatchlistGroup.sort_order, WatchlistGroup.created_at)
        .all()
    )
    return [{"id": g.id, "name": g.name, "sort_order": g.sort_order} for g in groups]


@router.post("/groups", status_code=201)
def create_group(body: GroupCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    g = WatchlistGroup(user_id=user.id, name=body.name.strip())
    db.add(g)
    db.commit()
    db.refresh(g)
    return {"id": g.id, "name": g.name, "sort_order": g.sort_order}


@router.patch("/groups/{group_id}")
def rename_group(group_id: int, body: GroupRename, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    g = db.query(WatchlistGroup).filter(WatchlistGroup.id == group_id, WatchlistGroup.user_id == user.id).first()
    if not g:
        raise HTTPException(404, "找不到此分組")
    g.name = body.name.strip()
    db.commit()
    return {"id": g.id, "name": g.name}


@router.delete("/groups/{group_id}", status_code=204)
def delete_group(group_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    g = db.query(WatchlistGroup).filter(WatchlistGroup.id == group_id, WatchlistGroup.user_id == user.id).first()
    if not g:
        raise HTTPException(404, "找不到此分組")
    # 移除所有成員的分組指定
    db.query(Watchlist).filter(Watchlist.user_id == user.id, Watchlist.group_id == group_id).update({"group_id": None})
    db.delete(g)
    db.commit()


@router.patch("/{stock_code}/group")
def assign_group(stock_code: str, body: GroupAssign, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = db.query(Watchlist).filter(Watchlist.user_id == user.id, Watchlist.stock_code == stock_code).first()
    if not item:
        raise HTTPException(404, "Stock not found in watchlist")
    if body.group_id is not None:
        g = db.query(WatchlistGroup).filter(WatchlistGroup.id == body.group_id, WatchlistGroup.user_id == user.id).first()
        if not g:
            raise HTTPException(404, "找不到此分組")
    item.group_id = body.group_id
    db.commit()
    return {"stock_code": stock_code, "group_id": item.group_id}


class StockRename(BaseModel):
    stock_name: str


@router.patch("/{stock_code}/name")
def rename_stock(stock_code: str, body: StockRename, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = db.query(Watchlist).filter(Watchlist.user_id == user.id, Watchlist.stock_code == stock_code).first()
    if not item:
        raise HTTPException(404, "Stock not found in watchlist")
    item.stock_name = body.stock_name.strip()
    db.commit()
    return {"stock_code": stock_code, "stock_name": item.stock_name}


@router.delete("/{stock_code}", status_code=204)
def remove_from_watchlist(stock_code: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = (
        db.query(Watchlist)
        .filter(Watchlist.user_id == user.id, Watchlist.stock_code == stock_code)
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Stock not found in watchlist")
    db.delete(item)
    db.commit()

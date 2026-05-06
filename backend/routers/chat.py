from __future__ import annotations
import json
import os
import re
from typing import List
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import or_
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

router = APIRouter(prefix="/chat", tags=["chat"])

SYSTEM_PROMPT = """你是一位台股投資分析助理，熟悉各大投顧的研究報告。
根據系統提供的報告資料，以口語方式回答用戶的投資相關問題。
回答要簡潔清楚，避免過度複雜的術語。
若有引用具體報告，請標明股票代號與分析師。
若問題超出現有報告範圍，誠實說明並給出一般性看法。
不要替用戶做最終投資決策，而是客觀呈現分析師觀點供參考。"""


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: List[Message] = []


def _get_context(message: str, db: Session) -> str:
    codes = re.findall(r'(?<!\d)\d{4}(?!\d)', message)
    reports: list[Report] = []

    if codes:
        for code in codes[:3]:
            rows = (
                db.query(Report)
                .filter(Report.stock_code == code)
                .order_by(Report.created_at.desc())
                .limit(3)
                .all()
            )
            reports.extend(rows)

    if not reports:
        keywords = [w for w in re.split(r'[\s，。？！、]+', message) if len(w) >= 2][:4]
        for kw in keywords:
            rows = (
                db.query(Report)
                .filter(or_(
                    Report.summary.like(f"%{kw}%"),
                    Report.stock_name.like(f"%{kw}%"),
                    Report.key_points.like(f"%{kw}%"),
                ))
                .order_by(Report.created_at.desc())
                .limit(3)
                .all()
            )
            reports.extend(rows)

    seen: set[int] = set()
    unique: list[Report] = []
    for r in reports:
        if r.id not in seen:
            seen.add(r.id)
            unique.append(r)

    if not unique:
        return ""

    parts = []
    for r in unique[:5]:
        kp = json.loads(r.key_points) if r.key_points else []
        date = str(r.report_date or r.created_at.date())
        line = f"[{r.stock_code} {r.stock_name or ''} | {r.recommendation or '—'} | 目標價 {r.target_price or '—'} | {r.analyst or '—'} | {date}]"
        if r.summary:
            line += f"\n摘要：{r.summary[:300]}"
        if kp:
            line += "\n重點：" + "；".join(kp[:3])
        parts.append(line)

    return "\n\n".join(parts)


@router.post("/stream")
def chat_stream(body: ChatRequest, db: Session = Depends(get_db)):
    context = _get_context(body.message, db)
    system = SYSTEM_PROMPT
    if context:
        system += f"\n\n以下是資料庫中的相關報告，請參考：\n{context}"

    messages = [{"role": m.role, "content": m.content} for m in body.history]
    messages.append({"role": "user", "content": body.message})

    # Gemini 需要把 history 轉成 contents 格式（user/model 交替）
    contents = []
    for m in messages:
        role = "model" if m["role"] == "assistant" else "user"
        contents.append(genai_types.Content(role=role, parts=[genai_types.Part(text=m["content"])]))

    def generate():
        try:
            client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))
            for chunk in client.models.generate_content_stream(
                model="gemini-2.5-flash",
                contents=contents,
                config=genai_types.GenerateContentConfig(
                    system_instruction=system,
                    max_output_tokens=2048,
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

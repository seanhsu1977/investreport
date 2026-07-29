from __future__ import annotations
import html
import json
import os
import re
import time
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse
from google import genai
from google.genai import types as genai_types

router = APIRouter(prefix="/news", tags=["news"])

CNYES_API = "https://api.cnyes.com/media/api/v1/newslist/category/tw_stock?limit=30"
_cache: dict = {"ts": 0.0, "text": ""}
_news_cache: dict = {"ts": 0.0, "data": []}
CACHE_TTL = 1800  # 30 min
NEWS_TTL = 300    # 5 min

_SAFETY_OFF = [
    genai_types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_NONE"),
    genai_types.SafetySetting(category="HARM_CATEGORY_HARASSMENT",         threshold="BLOCK_NONE"),
    genai_types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH",        threshold="BLOCK_NONE"),
    genai_types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT",  threshold="BLOCK_NONE"),
]

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


def _parse_content(raw: str) -> str:
    """HTML-encoded content → plain text, max 2000 chars."""
    text = html.unescape(raw or "")
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:2000]


def _to_newsitem(n: dict) -> dict:
    """Map cnyes API item → our NewsItem format."""
    ts = n.get("publishAt", 0)
    date_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    stocks = n.get("stock") or []
    stocks_str = ",".join(f"{s}(TW)" for s in stocks if s) or None

    cover = n.get("coverSrc") or {}
    img = (cover.get("s") or cover.get("m") or {}).get("src", "")

    return {
        "id": str(n.get("newsId", "")),
        "category": n.get("categoryName", ""),
        "title": n.get("title", ""),
        "summary": n.get("summary", ""),
        "content": _parse_content(n.get("content", "")),
        "link": f"https://news.cnyes.com/news/id/{n.get('newsId', '')}",
        "source": n.get("source", "鉅亨網"),
        "date": date_str,
        "stocks": stocks_str,
        "img": img,
        "click": 0,
    }


async def _get_news() -> list[dict]:
    now = time.time()
    if now - _news_cache["ts"] < NEWS_TTL and _news_cache["data"]:
        return _news_cache["data"]
    async with httpx.AsyncClient(timeout=10, headers={"User-Agent": _UA}) as c:
        r = await c.get(CNYES_API)
        r.raise_for_status()
        items = r.json()["items"]["data"]
        mapped = [_to_newsitem(n) for n in items]
        _news_cache["ts"] = now
        _news_cache["data"] = mapped
        return mapped


@router.get("/list")
async def news_list():
    try:
        data = await _get_news()
        return {"data": data}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/market-analysis")
async def market_analysis(refresh: bool = False):
    now = time.time()
    if not refresh and now - _cache["ts"] < CACHE_TTL and _cache["text"]:
        text = _cache["text"]

        def _cached():
            yield f"data: {json.dumps({'text': text, 'cached': True}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            _cached(), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache"},
        )

    try:
        news = await _get_news()
    except Exception as e:
        async def _err():
            yield f"data: {json.dumps({'error': f'新聞抓取失敗：{e}'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(_err(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache"})

    # 用完整內文（content）拼湊 prompt
    parts = []
    for n in news[:15]:
        body = n["content"] or n["summary"] or "（無內文）"
        stocks_tag = f"  相關個股：{n['stocks']}" if n["stocks"] else ""
        parts.append(f"【{n['category']}】{n['title']}{stocks_tag}\n{body}")
    combined = "\n\n---\n\n".join(parts)

    prompt = f"""以下是今日台股財經新聞（鉅亨網），請根據這些資料產生一份盤勢分析。

{combined}

請用繁體中文輸出，格式如下（每個段落都要有實質內容，不要省略）：

## 今日盤勢重點
- （列出 4-5 條要點，每條 1-2 句，涵蓋大盤走勢、產業動態、法人動向等重要訊號）

## 強弱族群
強勢：（列出 3-4 個偏強族群，各附一句說明原因，包含個股舉例）
弱勢：（列出 2-3 個偏弱族群，各附一句說明原因）

## 明日觀察
- （列出 3-4 個明天值得追蹤的事件、數據或個股）

根據新聞事實分析，語言精準，不加入投資建議。"""

    def stream():
        try:
            client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))
            full = ""
            for chunk in client.models.generate_content_stream(
                model="gemini-2.5-flash",
                contents=[genai_types.Content(role="user", parts=[genai_types.Part(text=prompt)])],
                config=genai_types.GenerateContentConfig(
                    max_output_tokens=2048,
                    safety_settings=_SAFETY_OFF,
                ),
            ):
                if chunk.text:
                    full += chunk.text
                    yield f"data: {json.dumps({'text': chunk.text}, ensure_ascii=False)}\n\n"
            _cache["ts"] = time.time()
            _cache["text"] = full
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

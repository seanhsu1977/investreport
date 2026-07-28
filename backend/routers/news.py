from __future__ import annotations
import asyncio
import json
import os
import time

import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse
from google import genai
from google.genai import types as genai_types

router = APIRouter(prefix="/news", tags=["news"])

NSTOCK_API = "https://www.nstock.tw/api/cnyes-news/?limit=20&categoryAll=true"
_cache: dict = {"ts": 0.0, "text": ""}
CACHE_TTL = 1800  # 30 min

_SAFETY_OFF = [
    genai_types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_NONE"),
    genai_types.SafetySetting(category="HARM_CATEGORY_HARASSMENT",         threshold="BLOCK_NONE"),
    genai_types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH",        threshold="BLOCK_NONE"),
    genai_types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT",  threshold="BLOCK_NONE"),
]

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


async def _get_news() -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(NSTOCK_API)
        r.raise_for_status()
        return r.json().get("data", [])


async def _get_article_text(url: str) -> str:
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as c:
            r = await c.get(url, headers={"User-Agent": _UA})
            soup = BeautifulSoup(r.text, "html.parser")
            for tag in soup(["script", "style", "nav", "header", "footer", "aside", "button"]):
                tag.decompose()
            paras = [p.get_text(" ", strip=True) for p in soup.find_all("p")]
            text = "\n".join(p for p in paras if len(p) > 30)
            return text[:3000]
    except Exception:
        return ""


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

    # Fetch news and article content upfront (async)
    try:
        news = await _get_news()
    except Exception as e:
        async def _err():
            yield f"data: {json.dumps({'error': f'新聞抓取失敗：{e}'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(_err(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache"})

    articles = [n for n in news if "article_c" in n.get("link", "")][:6]
    texts = await asyncio.gather(*[_get_article_text(n["link"]) for n in articles])

    parts = []
    for n, t in zip(articles, texts):
        parts.append(f"【{n['category']}】{n['title']}\n{t or '（內文無法取得）'}")
    combined = "\n\n---\n\n".join(parts)

    prompt = f"""以下是今日台股財經新聞的內文，請根據這些資料產生一份精簡的盤勢分析。

{combined}

請用繁體中文輸出，格式如下：

## 今日盤勢重點
- （3-4 條要點，每條 1-2 句，聚焦最重要的市場訊號）

## 強弱族群
強勢：（2-3 個偏強族群，一句說明原因）
弱勢：（2-3 個偏弱族群，一句說明原因）

## 明日觀察
- （2-3 個明天值得追蹤的事件或指標）

根據新聞事實分析，不加入投資建議。輸出簡潔。"""

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

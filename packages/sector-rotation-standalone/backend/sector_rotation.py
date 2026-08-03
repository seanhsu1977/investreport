"""
台股概念股輪動圖 — 後端邏輯（standalone 版）

跟 investreport 主專案的 backend/routers/stocks.py 裡的邏輯完全一致，只有
一個差異：`/sector-rotation/ask` 拿掉了主專案的登入驗證（`Depends(get_current_user)`），
因為這個 standalone 版沒有帶使用者系統。要接回主專案時記得補回去。

架構、演算法設計（含 X 軸 log2 比例偏離的推導）說明見上層資料夾的 README.md。
"""
from __future__ import annotations
import asyncio
import json
import math
import os
import time
import httpx
from datetime import datetime
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import nstock as ns

router = APIRouter(prefix="/api/stocks", tags=["stocks"])

_SAFETY_OFF = None  # 延遲初始化，見 sector_rotation_ask()

# ── Concept Stock Rotation ───────────────────────────────────────────────────
# 資料來源：nstock 概念股清單 (StockChip)，各股成交金額加總計算動能
_SECTOR_CHIP_CACHE: dict[str, tuple[dict, float]] = {}
_SECTOR_CHIP_TTL = 4 * 3600
_NSTOCK_STRATEGY = "https://api.nstock.tw/strategy/"

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
        # x 軸代表「相對平均的資金強弱」。族群間成交金額呈長尾分布（龍頭族群可能是冷門族群的
        # 上千倍），用絕對金額差會被少數幾個巨型族群主導、把其餘族群全部擠在中間。改用
        # log2(自己/平均) 的比例式偏離，讓數量級差距被壓縮成可讀的尺度，正負號意義不變。
        bubbles = []
        for name, ids in concept_map.items():
            x20_total = 0.0
            x5_total  = 0.0
            rt_total  = 0.0
            stock_raw = []

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
                stock_raw.append((code, info["name"], x20, x5, rt, y))

            if not stock_raw or x20_total <= 0:
                continue

            x20_avg_in_concept = x20_total / len(stock_raw)
            stock_items = [{
                "code":    code,
                "name":    s_name,
                "x":       round(math.log2(x20 / x20_avg_in_concept), 2),   # 相對族群內平均之比例偏離（log2）
                "y":       round(y / 1e7, 1),   # 千萬元/日
                "size":    round(x20 / 1e8, 1),
                "amt_5d":  round(x5  / 1e8, 1),
                "amt_20d": round(x20 / 1e8, 1),
                "rt_amt":  round(rt  / 1e8, 1),
            } for code, s_name, x20, x5, rt, y in stock_raw]

            y_concept = x5_total / 5 - x20_total / 20

            bubbles.append({
                "name":    name,
                "x20_total": x20_total,   # 暫存，計算全族群平均後轉為相對值
                "y":       round(y_concept  / 1e8, 1),
                "size":    round(x20_total / 1e9, 1),
                "amt_5d":  round(x5_total  / 1e9, 1),
                "amt_20d": round(x20_total / 1e9, 1),
                "rt_amt":  round(rt_total  / 1e8, 1),
                "stocks":  sorted(stock_items, key=lambda s: s["size"], reverse=True),
            })

        if not bubbles:
            return

        x20_total_avg = sum(b["x20_total"] for b in bubbles) / len(bubbles)
        for b in bubbles:
            b["x"] = round(math.log2(b.pop("x20_total") / x20_total_avg), 2)   # 相對全族群平均之比例偏離（log2）

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
async def sector_rotation_ask(body: SectorAskBody):
    """AI 問答（standalone 版無登入驗證；主專案版本這裡多一個 Depends(get_current_user)）"""
    question = body.question.strip()
    if not question:
        raise HTTPException(400, "question required")

    if "sector_rotation" not in _SECTOR_CHIP_CACHE:
        raise HTTPException(503, "資料尚未準備好，請稍後再試")

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(503, "GEMINI_API_KEY not set")

    from google import genai
    from google.genai import types as genai_types

    global _SAFETY_OFF
    if _SAFETY_OFF is None:
        _SAFETY_OFF = [
            genai_types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_NONE"),
            genai_types.SafetySetting(category="HARM_CATEGORY_HARASSMENT",         threshold="BLOCK_NONE"),
            genai_types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH",        threshold="BLOCK_NONE"),
            genai_types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT",  threshold="BLOCK_NONE"),
        ]

    data, _ts = _SECTOR_CHIP_CACHE["sector_rotation"]
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

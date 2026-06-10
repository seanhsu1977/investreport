from __future__ import annotations
import re
import time
from datetime import datetime

import pandas as pd
import yfinance as yf
import nstock as ns

_CACHE: dict[str, tuple[dict, float]] = {}
_CACHE_TTL = 3600  # 1 小時

def _cache_valid(ts: float) -> bool:
    """快取有效：未超過 TTL 且與今日同一天（台灣時間 UTC+8）"""
    if time.time() - ts >= _CACHE_TTL:
        return False
    TW_OFFSET = 8 * 3600
    cached_day = int((ts + TW_OFFSET) / 86400)
    today = int((time.time() + TW_OFFSET) / 86400)
    return cached_day == today


def _is_tw_stock(code: str) -> bool:
    return bool(re.match(r"^\d{4}", code))


def _fetch_history(code: str):
    """嘗試 .TW（上市）→ .TWO（上櫃）→ 原始代號"""
    if not _is_tw_stock(code):
        return yf.Ticker(code).history(period="3mo")
    for suffix in (".TW", ".TWO"):
        hist = yf.Ticker(f"{code}{suffix}").history(period="3mo")
        if not hist.empty and len(hist) >= 20:
            return hist
    return pd.DataFrame()


def _compute_rsi(closes: pd.Series, period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    delta = closes.diff()
    gain = delta.clip(lower=0).rolling(window=period).mean()
    loss = (-delta.clip(upper=0)).rolling(window=period).mean()
    rs = gain / loss
    rsi = 100 - (100 / (1 + rs))
    val = rsi.iloc[-1]
    return round(float(val), 1) if pd.notna(val) else None


def _compute_tower(
    closes: pd.Series,
    highs: pd.Series,
    lows: pd.Series,
    n: int = 4,
) -> dict | None:
    """寶塔線（台灣券商定義）：
    紅棒（陽）= 今日收盤 > 前 n 日每日最高價的最大值
    黑棒（陰）= 今日收盤 < 前 n 日每日最低價的最小值
    兩者都不符合 → 不新增磚（中性，維持前一狀態）
    n 預設 4

    回傳：{"color": "陽"/"陰", "count": 連續磚數, "signal": 轉陽/持續陽/…}
    """
    if len(closes) < n + 1:
        return None

    prices = closes.tolist()
    hi     = highs.tolist()
    lo     = lows.tolist()

    bricks: list[int] = []   # 1=紅磚, -1=黑磚（中性日不加入）

    for i in range(n, len(prices)):
        c = prices[i]
        max_prev_high = max(hi[i - j] for j in range(1, n + 1))
        min_prev_low  = min(lo[i - j] for j in range(1, n + 1))

        if c > max_prev_high:
            bricks.append(1)     # 紅棒：突破前 n 日所有最高價
        elif c < min_prev_low:
            bricks.append(-1)    # 黑棒：跌破前 n 日所有最低價
        # 中性：不加磚

    if not bricks:
        return None

    last_color = bricks[-1]

    # 連續同色磚數（從最近往前數，遇到異色停止）
    count = 0
    for b in reversed(bricks):
        if b == last_color:
            count += 1
        else:
            break

    # 是否剛發生翻轉（上一根磚為異色）
    if len(bricks) >= 2 and bricks[-2] != last_color:
        signal = "轉陽" if last_color == 1 else "轉陰"
    else:
        signal = "持續陽" if last_color == 1 else "持續陰"

    return {"color": "陽" if last_color == 1 else "陰", "count": count, "signal": signal}


def _dedup_levels(levels: list[float], limit: int = 2) -> list[float]:
    result: list[float] = []
    for lv in levels:
        if not result or abs(lv - result[-1]) / result[-1] > 0.02:
            result.append(lv)
        if len(result) == limit:
            break
    return result


def _find_levels(
    closes: pd.Series,
    highs: pd.Series,
    lows: pd.Series,
    current: float,
    volumes: pd.Series | None = None,
) -> dict:
    """支撐壓力計算：優先用爆量K棒高低點，不足時補均線兜底"""
    threshold = current * 0.005
    res_vol: list[float] = []
    sup_vol: list[float] = []

    # --- 爆量K棒法 ---
    if volumes is not None and len(volumes) >= 20:
        avg_vol = float(volumes.rolling(60, min_periods=20).mean().iloc[-1])
        if avg_vol > 0:
            big_mask = volumes > avg_vol * 1.5
            for i in range(len(closes)):
                if not big_mask.iloc[i]:
                    continue
                c = float(closes.iloc[i])
                if c > current + threshold:
                    res_vol.append(round(float(highs.iloc[i]), 1))
                elif c < current - threshold:
                    sup_vol.append(round(float(lows.iloc[i]), 1))

    resistance = _dedup_levels(sorted(res_vol))
    support    = _dedup_levels(sorted(sup_vol, reverse=True))

    # --- MA 兜底：不足兩個時補均線 ---
    ma_candidates: list[float] = []
    if len(closes) >= 20:
        ma_candidates.append(round(float(closes.iloc[-20:].mean()), 1))
    if len(closes) >= 60:
        ma_candidates.append(round(float(closes.iloc[-60:].mean()), 1))
    # 近高低
    ma_candidates.append(round(float(highs.iloc[-60:].max() if len(closes)>=60 else highs.iloc[-20:].max()), 1))
    ma_candidates.append(round(float(lows.iloc[-60:].min()  if len(closes)>=60 else lows.iloc[-20:].min()),  1))

    for c in sorted(c for c in ma_candidates if c > current + threshold):
        if len(resistance) >= 2:
            break
        if not resistance or abs(c - resistance[-1]) / resistance[-1] > 0.02:
            resistance.append(c)

    for c in sorted((c for c in ma_candidates if c < current - threshold), reverse=True):
        if len(support) >= 2:
            break
        if not support or abs(c - support[-1]) / support[-1] > 0.02:
            support.append(c)

    return {"resistance": resistance, "support": support}


def _compute_bollinger(closes: pd.Series, current: float, period: int = 20) -> dict:
    if len(closes) < period:
        return {"upper": None, "lower": None, "pct_b": None, "signal": None}
    ma = float(closes.iloc[-period:].mean())
    std = float(closes.iloc[-period:].std())
    upper = round(ma + 2 * std, 2)
    lower = round(ma - 2 * std, 2)
    band_width = upper - lower
    pct_b = round((current - lower) / band_width, 3) if band_width > 0 else None

    if pct_b is None:
        signal = None
    elif pct_b > 1.0:
        signal = "突破上軌"
    elif pct_b >= 0.8:
        signal = "近上軌"
    elif pct_b < 0.0:
        signal = "跌破下軌"
    elif pct_b <= 0.2:
        signal = "近下軌"
    else:
        signal = "帶內整理"

    return {"upper": upper, "lower": lower, "pct_b": pct_b, "signal": signal}


def _ma_position_text(price: float, ma5, ma10, ma20, ma60) -> str:
    """描述現價與各均線的位置關係"""
    mas = [("5日", ma5), ("10日", ma10), ("20日", ma20), ("60日", ma60)]
    mas = [(label, val) for label, val in mas if val is not None]
    above = [label for label, val in mas if price >= val]
    below = [label for label, val in mas if price < val]
    if not below:
        return "站上所有均線"
    if not above:
        return "跌破所有均線"
    if len(above) == 1:
        return f"僅站上{above[0]}均線"
    if len(below) == 1:
        return f"站上所有均線，逼近{below[0]}均線"
    return f"站上{above[-1]}均線，跌破{below[0]}均線"


def _make_suggestion(
    ma_signal: str,
    volume_signal: str,
    rsi: float | None,
    price_change_5d: float | None,
    bb_signal: str | None = None,
    change_pct_today: float | None = None,
) -> str:
    if bb_signal == "突破上軌":
        return "突破布林上軌，短線過熱"
    if bb_signal == "跌破下軌":
        return "跌破布林下軌，留意反彈"
    if rsi is not None and rsi >= 75:
        return "短線過熱，注意回檔"
    if rsi is not None and rsi <= 25:
        return "短線超賣，留意反彈"

    today_up = change_pct_today is not None and change_pct_today > 0
    today_down = change_pct_today is not None and change_pct_today < 0

    if ma_signal == "多頭排列" and volume_signal == "量增":
        if today_up:
            return "量增價漲，偏多"
        if today_down:
            return "量增收黑，留意賣壓"
        return "多頭 + 量增"
    if ma_signal == "多頭排列" and volume_signal == "量縮":
        return "多頭趨勢，量縮整理"
    if ma_signal == "空頭排列" and volume_signal == "量增":
        if today_down:
            return "量增價跌，注意風險"
        if today_up:
            return "量增反彈，注意是否有效"
        return "空頭 + 量增"
    if ma_signal == "空頭排列":
        return "弱勢整理，觀望為主"
    return "盤整，等待方向"


# 台灣指數：用 nStock（nstock_code, market_type）
_TW_INDEX_MAP = {
    "TWII":  {"nstock_id": "IX0001", "market_type": 1, "name": "加權指數"},
    "TWOII": {"nstock_id": "IX0043", "market_type": 2, "name": "上櫃指數"},
}

# 國際指數：繼續用 yfinance
_INTL_INDEX_MAP = {
    "SPX":  {"symbol": "^GSPC",     "name": "S&P 500"},
    "NDX":  {"symbol": "^IXIC",     "name": "那斯達克"},
    "DJI":  {"symbol": "^DJI",      "name": "道瓊"},
    "SOX":  {"symbol": "^SOX",      "name": "費半"},
    "N225": {"symbol": "^N225",     "name": "日經225"},
    "HSI":  {"symbol": "^HSI",      "name": "恆生指數"},
    "GOLD": {"symbol": "GC=F",      "name": "黃金"},
    "OIL":  {"symbol": "CL=F",      "name": "原油"},
    "DXY":  {"symbol": "DX-Y.NYB",  "name": "美元指數"},
}


def _build_index_data_from_nstock(key: str, meta: dict) -> dict | None:
    """用 nStock 資料建立指數 data dict"""
    nid = meta["nstock_id"]
    mtype = meta["market_type"]

    # 即時行情
    rt = ns.find_index_quote(nid, mtype)
    daily = ns.get_daily(nid)
    if not rt or not daily or not daily.get("日K"):
        return None

    current    = round(float(rt["當盤成交價"]), 2)
    prev       = round(float(rt["參考價"]), 2)
    change     = round(float(rt["漲跌"]), 2)
    change_pct = round(float(rt["漲跌幅"]), 2)

    # 日K 最新在前，取近 60 筆建 Series
    bars = daily["日K"][:60]
    closes_list = [float(b["收盤價"]) for b in reversed(bars)]
    highs_list  = [float(b["最高價"]) for b in reversed(bars)]
    lows_list   = [float(b["最低價"]) for b in reversed(bars)]
    vols_list   = [float(b.get("成交量", 0)) for b in reversed(bars)]

    closes  = pd.Series(closes_list)
    highs   = pd.Series(highs_list)
    lows    = pd.Series(lows_list)
    volumes = pd.Series(vols_list)

    # MA
    ma5  = round(float(closes.iloc[-5:].mean()), 2)
    ma20 = round(float(bars[0].get("SD20", closes.iloc[-20:].mean())), 2)
    ma_signal = ("多頭排列" if ma5 > ma20 * 1.005
                 else "空頭排列" if ma5 < ma20 * 0.995
                 else "均線糾結")

    # 成交量訊號
    vol1  = float(rt.get("當盤成交量", 0))
    vol20 = float(volumes[volumes > 0].iloc[-20:].mean()) if (volumes > 0).sum() >= 5 else 0
    if vol1 == 0:
        volume_signal = None
    elif vol20 > 0 and vol1 > vol20 * 1.2:
        volume_signal = "量增"
    elif vol20 > 0 and vol1 < vol20 * 0.8:
        volume_signal = "量縮"
    else:
        volume_signal = "量持平"

    # RSI — 直接用 nStock 計算好的
    rsi = round(float(bars[0].get("RSI14", 0) or 0), 1) or None
    rsi_signal = ("超買" if rsi and rsi >= 70 else "超賣" if rsi and rsi <= 30 else "正常")

    # 布林 — 直接用 nStock UB20/LB20
    bb_upper = round(float(bars[0].get("UB20", 0)), 2) or None
    bb_lower = round(float(bars[0].get("LB20", 0)), 2) or None
    if bb_upper and bb_lower and (bb_upper - bb_lower) > 0:
        pct_b = round((current - bb_lower) / (bb_upper - bb_lower), 3)
        bb_sig = ("突破上軌" if pct_b > 1.0 else "近上軌" if pct_b >= 0.8
                  else "跌破下軌" if pct_b < 0.0 else "近下軌" if pct_b <= 0.2
                  else "帶內整理")
    else:
        pct_b = None
        bb_sig = None

    suggestion = _make_suggestion(ma_signal, volume_signal, rsi, change_pct, bb_sig, change_pct_today=change_pct)
    levels = _find_levels(closes, highs, lows, current, volumes)
    tower  = _compute_tower(closes, highs, lows)

    return {
        "name": meta["name"],
        "current": current,
        "change": change,
        "change_pct": change_pct,
        "ma5": ma5,
        "ma20": ma20,
        "ma_signal": ma_signal,
        "volume_signal": volume_signal,
        "rsi": rsi,
        "rsi_signal": rsi_signal,
        "bb_upper": bb_upper,
        "bb_lower": bb_lower,
        "bb_pct_b": pct_b,
        "bb_signal": bb_sig,
        "suggestion": suggestion,
        "resistance": levels["resistance"],
        "support": levels["support"],
        "tower": tower,
        "updated_at": datetime.utcnow().isoformat(),
    }


def _build_index_data_from_yf(key: str, meta: dict) -> dict | None:
    """用 yfinance 資料建立指數 data dict"""
    sym = meta["symbol"]
    hist = yf.Ticker(sym).history(period="3mo")
    if hist.empty or len(hist) < 20:
        hist = yf.Ticker(sym).history(period="6mo")
    if hist.empty or len(hist) < 20:
        return None

    closes  = hist["Close"]
    highs   = hist["High"]
    lows    = hist["Low"]
    volumes = hist["Volume"]

    current    = round(float(closes.iloc[-1]), 2)
    prev       = round(float(closes.iloc[-2]), 2)
    change     = round(current - prev, 2)
    change_pct = round((current / prev - 1) * 100, 2) if prev else None

    ma5  = round(float(closes.iloc[-5:].mean()), 2)
    ma20 = round(float(closes.iloc[-20:].mean()), 2)
    ma_signal = ("多頭排列" if ma5 > ma20 * 1.005
                 else "空頭排列" if ma5 < ma20 * 0.995
                 else "均線糾結")

    vol1  = float(volumes.iloc[-1])
    vol20 = float(volumes[volumes > 0].iloc[-20:].mean()) if (volumes > 0).sum() >= 5 else 0
    volume_signal = (None if vol1 == 0
                     else "量增" if vol20 > 0 and vol1 > vol20 * 1.2
                     else "量縮" if vol20 > 0 and vol1 < vol20 * 0.8
                     else "量持平")

    rsi = _compute_rsi(closes)
    rsi_signal = ("超買" if rsi and rsi >= 70 else "超賣" if rsi and rsi <= 30 else "正常")

    bb = _compute_bollinger(closes, current)
    suggestion = _make_suggestion(ma_signal, volume_signal, rsi, change_pct, bb["signal"], change_pct_today=change_pct)
    levels = _find_levels(closes, highs, lows, current, volumes)
    tower  = _compute_tower(closes, highs, lows)

    return {
        "name": meta["name"],
        "current": current,
        "change": change,
        "change_pct": change_pct,
        "ma5": ma5,
        "ma20": ma20,
        "ma_signal": ma_signal,
        "volume_signal": volume_signal,
        "rsi": rsi,
        "rsi_signal": rsi_signal,
        "bb_upper": bb["upper"],
        "bb_lower": bb["lower"],
        "bb_pct_b": bb["pct_b"],
        "bb_signal": bb["signal"],
        "suggestion": suggestion,
        "resistance": levels["resistance"],
        "support": levels["support"],
        "tower": tower,
        "updated_at": datetime.utcnow().isoformat(),
    }


def get_market_overview() -> dict:
    """回傳大盤指數即時資料與技術訊號"""
    result = {}
    now = time.time()

    # 台灣指數 — nStock
    for key, meta in _TW_INDEX_MAP.items():
        cache_key = f"idx_{key}"
        if cache_key in _CACHE:
            cached, ts = _CACHE[cache_key]
            if _cache_valid(ts):
                result[key] = cached
                continue
        try:
            data = _build_index_data_from_nstock(key, meta)
            if data:
                _CACHE[cache_key] = (data, now)
                result[key] = data
        except Exception:
            continue

    # 國際指數 — yfinance
    for key, meta in _INTL_INDEX_MAP.items():
        cache_key = f"idx_{key}"
        if cache_key in _CACHE:
            cached, ts = _CACHE[cache_key]
            if _cache_valid(ts):
                result[key] = cached
                continue
        try:
            data = _build_index_data_from_yf(key, meta)
            if data:
                _CACHE[cache_key] = (data, now)
                result[key] = data
        except Exception:
            continue

    return result


def get_signals(code: str) -> dict | None:
    now = time.time()
    if code in _CACHE:
        cached, ts = _CACHE[code]
        if _cache_valid(ts):
            return cached

    # 台灣個股 — nStock
    if _is_tw_stock(code):
        try:
            daily = ns.get_daily(code)
            if not daily or not daily.get("日K") or len(daily["日K"]) < 20:
                raise ValueError("insufficient data")

            bars = daily["日K"][:60]  # 最新在前
            closes_list = [float(b["收盤價"]) for b in reversed(bars)]
            highs_list  = [float(b["最高價"]) for b in reversed(bars)]
            lows_list   = [float(b["最低價"]) for b in reversed(bars)]
            vols_list   = [float(b.get("成交量", 0)) for b in reversed(bars)]

            closes  = pd.Series(closes_list)
            highs   = pd.Series(highs_list)
            lows    = pd.Series(lows_list)
            volumes = pd.Series(vols_list)

            current_price = closes_list[-1]

            price_change_5d = None
            if len(closes_list) >= 6:
                prev5 = closes_list[-6]
                if prev5 > 0:
                    price_change_5d = round((current_price / prev5 - 1) * 100, 1)

            ma5  = float(closes.iloc[-5:].mean())
            ma10 = round(float(closes.iloc[-10:].mean()), 2) if len(closes) >= 10 else None
            ma20 = round(float(bars[0].get("SD20") or closes.iloc[-20:].mean()), 2)
            ma60 = round(float(closes.iloc[-60:].mean()), 2) if len(closes) >= 60 else None
            ma_signal = ("多頭排列" if ma5 > ma20 * 1.01
                         else "空頭排列" if ma5 < ma20 * 0.99
                         else "均線糾結")
            ma_position = _ma_position_text(current_price, round(ma5, 2), ma10, ma20, ma60)

            vol1  = vols_list[-1]
            vol20 = float(volumes[volumes > 0].iloc[-20:].mean()) if (volumes > 0).sum() >= 5 else 0
            volume_signal = (None if vol1 == 0
                             else "量增" if vol20 > 0 and vol1 > vol20 * 1.2
                             else "量縮" if vol20 > 0 and vol1 < vol20 * 0.8
                             else "量持平")

            rsi = round(float(bars[0].get("RSI14", 0) or 0), 1) or None
            rsi_signal = ("超買" if rsi and rsi >= 70 else "超賣" if rsi and rsi <= 30
                          else "正常" if rsi else "無")

            bb_upper = round(float(bars[0].get("UB20", 0)), 2) or None
            bb_lower = round(float(bars[0].get("LB20", 0)), 2) or None
            if bb_upper and bb_lower and (bb_upper - bb_lower) > 0:
                pct_b   = round((current_price - bb_lower) / (bb_upper - bb_lower), 3)
                bb_sig  = ("突破上軌" if pct_b > 1.0 else "近上軌" if pct_b >= 0.8
                           else "跌破下軌" if pct_b < 0.0 else "近下軌" if pct_b <= 0.2
                           else "帶內整理")
            else:
                pct_b, bb_sig = None, None

            suggestion = _make_suggestion(ma_signal, volume_signal, rsi, price_change_5d, bb_sig)
            levels = _find_levels(closes, highs, lows, current_price, volumes)
            tower  = _compute_tower(closes, highs, lows)

            result = {
                "current_price": round(current_price, 2),
                "price_change_5d": price_change_5d,
                "ma5": round(ma5, 2),
                "ma10": ma10,
                "ma20": ma20,
                "ma60": ma60,
                "ma_signal": ma_signal,
                "ma_position": ma_position,
                "volume_signal": volume_signal,
                "rsi": rsi,
                "rsi_signal": rsi_signal,
                "bb_upper": bb_upper,
                "bb_lower": bb_lower,
                "bb_pct_b": pct_b,
                "bb_signal": bb_sig,
                "suggestion": suggestion,
                "resistance": levels["resistance"],
                "support": levels["support"],
                "tower": tower,
                "updated_at": datetime.utcnow().isoformat(),
            }
            _CACHE[code] = (result, now)
            return result
        except Exception:
            pass  # fallback to yfinance

    # 非台灣股或 nStock 失敗 — yfinance fallback
    try:
        hist = _fetch_history(code)
        if hist.empty or len(hist) < 20:
            return None

        closes  = hist["Close"]
        highs   = hist["High"]
        lows    = hist["Low"]
        volumes = hist["Volume"]

        current_price = round(float(closes.iloc[-1]), 2)
        price_change_5d = None
        if len(closes) >= 6:
            prev = float(closes.iloc[-6])
            if prev > 0:
                price_change_5d = round((current_price / prev - 1) * 100, 1)

        ma5  = float(closes.iloc[-5:].mean())
        ma10 = round(float(closes.iloc[-10:].mean()), 2) if len(closes) >= 10 else None
        ma20 = float(closes.iloc[-20:].mean())
        ma60 = round(float(closes.iloc[-60:].mean()), 2) if len(closes) >= 60 else None
        ma_signal = ("多頭排列" if ma5 > ma20 * 1.01
                     else "空頭排列" if ma5 < ma20 * 0.99
                     else "均線糾結")
        ma_position = _ma_position_text(current_price, round(ma5, 2), ma10, round(ma20, 2), ma60)

        vol1  = float(volumes.iloc[-1])
        vol20 = float(volumes[volumes > 0].iloc[-20:].mean()) if (volumes > 0).sum() >= 5 else 0
        volume_signal = (None if vol1 == 0
                         else "量增" if vol20 > 0 and vol1 > vol20 * 1.2
                         else "量縮" if vol20 > 0 and vol1 < vol20 * 0.8
                         else "量持平")

        rsi = _compute_rsi(closes)
        rsi_signal = ("超買" if rsi and rsi >= 70 else "超賣" if rsi and rsi <= 30
                      else "正常" if rsi else "無")

        bb = _compute_bollinger(closes, current_price)
        suggestion = _make_suggestion(ma_signal, volume_signal, rsi, price_change_5d, bb["signal"])
        levels = _find_levels(closes, highs, lows, current_price, volumes)
        tower  = _compute_tower(closes, highs, lows)

        result = {
            "current_price": current_price,
            "price_change_5d": price_change_5d,
            "ma5": round(ma5, 2),
            "ma10": ma10,
            "ma20": round(ma20, 2),
            "ma60": ma60,
            "ma_signal": ma_signal,
            "ma_position": ma_position,
            "volume_signal": volume_signal,
            "rsi": rsi,
            "rsi_signal": rsi_signal,
            "bb_upper": bb["upper"],
            "bb_lower": bb["lower"],
            "bb_pct_b": bb["pct_b"],
            "bb_signal": bb["signal"],
            "suggestion": suggestion,
            "resistance": levels["resistance"],
            "support": levels["support"],
            "tower": tower,
            "updated_at": datetime.utcnow().isoformat(),
        }
        _CACHE[code] = (result, now)
        return result
    except Exception:
        return None

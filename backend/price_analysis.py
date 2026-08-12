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


def _fetch_history(code: str, period: str = "1y"):
    """嘗試 .TW（上市）→ .TWO（上櫃）→ 原始代號"""
    if not _is_tw_stock(code):
        return yf.Ticker(code).history(period=period)
    for suffix in (".TW", ".TWO"):
        hist = yf.Ticker(f"{code}{suffix}").history(period=period)
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


def _compute_kdj_series(
    closes: pd.Series,
    highs: pd.Series,
    lows: pd.Series,
    rsv_n: int = 89,
    k_w: float = 1 / 9,
    d_w: float = 1 / 12,
) -> tuple[list, list, list]:
    """KDJ(89,9,12) series. Returns (k_vals, d_vals, j_vals) lists."""
    low_min  = lows.rolling(rsv_n).min()
    high_max = highs.rolling(rsv_n).max()
    denom    = high_max - low_min
    rsv_raw  = ((closes - low_min) / denom * 100).where(denom > 0)

    k_vals, d_vals, j_vals = [], [], []
    k_prev, d_prev = 50.0, 50.0
    for r in rsv_raw:
        if pd.isna(r):
            k_vals.append(None); d_vals.append(None); j_vals.append(None)
        else:
            k = k_prev * (1 - k_w) + r * k_w
            d = d_prev * (1 - d_w) + k * d_w
            j = 3 * k - 2 * d
            k_vals.append(round(k, 2))
            d_vals.append(round(d, 2))
            j_vals.append(round(j, 2))
            k_prev, d_prev = k, d
    return k_vals, d_vals, j_vals


def _kdj_signal_from_series(
    k_vals: list, d_vals: list, j_vals: list, cross_lookback: int = 5
) -> tuple:
    """從 KDJ series 計算最新 K/D/J 值與金叉/死叉訊號，以及 J 線訊號。

    Returns: (kdj_k, kdj_d, kdj_j, signal, cross_days, j_signal, j_cross_days)
      signal: "低位金叉" | "金叉" | "高位死叉" | "低位死叉" | "死叉" | "多頭" | "空頭"
      j_signal: "J回升" | "J超賣" | "J轉弱" | "J超買" | None
    """
    valid = [(k, d, j) for k, d, j in zip(k_vals, d_vals, j_vals) if k is not None]
    if len(valid) < 2:
        return None, None, None, None, None, None, None

    cur_k, cur_d, cur_j = valid[-1]
    cross_days = cross_type = cross_k = None

    for i in range(min(cross_lookback, len(valid) - 1)):
        this_k, this_d, _ = valid[-(i + 1)]
        prev_k, prev_d, _ = valid[-(i + 2)]
        if prev_k < prev_d and this_k >= this_d:
            cross_days, cross_type, cross_k = i, "golden", this_k
            break
        if prev_k > prev_d and this_k <= this_d:
            cross_days, cross_type, cross_k = i, "dead", this_k
            break

    if cross_type == "golden":
        signal = "低位金叉" if cross_k < 30 else "金叉"
    elif cross_type == "dead":
        signal = "高位死叉" if cross_k > 70 else ("低位死叉" if cross_k < 30 else "死叉")
    else:
        signal = "多頭" if cur_k >= cur_d else "空頭"

    # J 線訊號：J = 3K - 2D，比 K/D 靈敏，常用 0 / 100 為超賣/超買閾值
    j_signal = j_cross_days = None
    for i in range(min(8, len(valid) - 1)):
        _, _, this_j = valid[-(i + 1)]
        _, _, prev_j = valid[-(i + 2)]
        if prev_j < 0 and this_j >= 0:
            j_signal, j_cross_days = "J回升", i
            break
        if prev_j > 100 and this_j <= 100:
            j_signal, j_cross_days = "J轉弱", i
            break
    if j_signal is None:
        if cur_j < 0:
            j_signal = "J超賣"
        elif cur_j > 100:
            j_signal = "J超買"

    return round(cur_k, 1), round(cur_d, 1), round(cur_j, 1), signal, cross_days, j_signal, j_cross_days


def _compute_tower(
    closes: pd.Series,
    highs: pd.Series,
    lows: pd.Series,
    n: int = 4,
) -> dict | None:
    """寶塔線（台灣券商定義，n=4）：
    n = 窗口大小（含今日），與前 n-1 天的 H/L 比對。
    紅棒（陽）= 今日收盤 > 前 (n-1) 日每日最高價的最大值
    黑棒（陰）= 今日收盤 < 前 (n-1) 日每日最低價的最小值
    中性日（兩者都不符合）= 不反轉，繼承前一根顏色延伸計數

    連續根數 = 自上次顏色轉換後（含轉換當日）到今日的所有交易日數，
              含中性日（因為中性日不代表訊號消失，只是延伸）。

    回傳：{"color": "陽"/"陰", "count": 連續根數, "signal": 轉陽/持續陽/…}
    """
    if len(closes) < n:
        return None

    prices = closes.tolist()
    hi     = highs.tolist()
    lo     = lows.tolist()

    # 每個交易日的顏色：1=陽, -1=陰, 0=尚未有訊號
    # 中性日繼承前一日顏色（沒有反轉就不重置）
    colors: list[int] = []
    last_brick_color = 0   # 最後一次實際產生磚的顏色
    prev_brick_color = 0   # 上上次磚的顏色（用於判斷是否轉向）
    turned = False         # 最近是否剛發生反轉

    for i in range(n - 1, len(prices)):
        c = prices[i]
        max_prev_high = max(hi[i - j] for j in range(1, n))   # 前 n-1 天
        min_prev_low  = min(lo[i - j] for j in range(1, n))   # 前 n-1 天

        if c > max_prev_high:
            if last_brick_color != 1:
                prev_brick_color = last_brick_color
                turned = True
            else:
                turned = False
            last_brick_color = 1
        elif c < min_prev_low:
            if last_brick_color != -1:
                prev_brick_color = last_brick_color
                turned = True
            else:
                turned = False
            last_brick_color = -1
        # 中性日：last_brick_color 不變，turned 不重置

        colors.append(last_brick_color)

    if not colors or last_brick_color == 0:
        return None

    # 連續根數：從尾端往前，計算同色連續天數（含中性延伸）
    count = 0
    for col in reversed(colors):
        if col == last_brick_color:
            count += 1
        else:
            break

    signal = ("轉陽" if last_brick_color == 1 else "轉陰") if count == 1 else \
             ("持續陽" if last_brick_color == 1 else "持續陰")

    return {"color": "陽" if last_brick_color == 1 else "陰", "count": count, "signal": signal}


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
            # 寶塔線 + KDJ 用 yfinance 資料（需要 89+ 根），與 K 線圖保持一致
            kdj_k = kdj_d = kdj_j = kdj_signal = kdj_cross_days = j_signal = j_cross_days = None
            try:
                _yf_hist = _fetch_history(code)
                if not _yf_hist.empty and len(_yf_hist) >= 10:
                    tower = _compute_tower(_yf_hist["Close"], _yf_hist["High"], _yf_hist["Low"])
                else:
                    tower = _compute_tower(closes, highs, lows)
                if len(_yf_hist) >= 90:
                    kk, dd, jj = _compute_kdj_series(_yf_hist["Close"], _yf_hist["High"], _yf_hist["Low"])
                    kdj_k, kdj_d, kdj_j, kdj_signal, kdj_cross_days, j_signal, j_cross_days = _kdj_signal_from_series(kk, dd, jj)
            except Exception:
                tower = _compute_tower(closes, highs, lows)

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
                "kdj_k": kdj_k,
                "kdj_d": kdj_d,
                "kdj_j": kdj_j,
                "kdj_signal": kdj_signal,
                "kdj_cross_days": kdj_cross_days,
                "j_signal": j_signal,
                "j_cross_days": j_cross_days,
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

        kdj_k = kdj_d = kdj_j = kdj_signal = kdj_cross_days = j_signal = j_cross_days = None
        if len(hist) >= 90:
            kk, dd, jj = _compute_kdj_series(closes, highs, lows)
            kdj_k, kdj_d, kdj_j, kdj_signal, kdj_cross_days, j_signal, j_cross_days = _kdj_signal_from_series(kk, dd, jj)

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
            "kdj_k": kdj_k,
            "kdj_d": kdj_d,
            "kdj_j": kdj_j,
            "kdj_signal": kdj_signal,
            "kdj_cross_days": kdj_cross_days,
            "j_signal": j_signal,
            "j_cross_days": j_cross_days,
            "updated_at": datetime.utcnow().isoformat(),
        }
        _CACHE[code] = (result, now)
        return result
    except Exception:
        return None


def screen_consolidation_breakout(code: str) -> dict | None:
    """篩選「橫盤整理後突破」：近 20 日區間窄 + 均線糾結 → 今日站上區間高點/布林上軌。
    只支援台股（用 nStock 日K，含 SD20/UB20/LB20/RSI14 現成欄位）。
    回傳 None 代表不符合（非台股、資料不足、或沒有整理後突破的型態）。
    """
    if not _is_tw_stock(code):
        return None
    try:
        daily = ns.get_daily(code)
        if not daily or not daily.get("日K") or len(daily["日K"]) < 25:
            return None
        bars = daily["日K"][:40]  # 最新在前
    except Exception:
        return None

    today = bars[0]
    try:
        current = float(today["收盤價"])
        vol_today = float(today.get("成交量", 0) or 0)
    except (KeyError, TypeError, ValueError):
        return None
    if current <= 0:
        return None

    # 整理窗：排除今天的前 20 個交易日
    window = bars[1:21]
    if len(window) < 20:
        return None
    range_high = max(float(b["最高價"]) for b in window)
    range_low = min(float(b["最低價"]) for b in window)
    range_pct = (range_high - range_low) / current

    closes_s = pd.Series([float(b["收盤價"]) for b in reversed(bars)])
    ma5 = float(closes_s.iloc[-5:].mean())
    ma20 = float(today.get("SD20") or closes_s.iloc[-20:].mean())
    ma_spread_pct = abs(ma5 - ma20) / current

    ub20 = float(today.get("UB20") or 0) or None
    lb20 = float(today.get("LB20") or 0) or None
    band_width_pct = None
    pct_b = None
    if ub20 and lb20 and (ub20 - lb20) > 0:
        band_width_pct = (ub20 - lb20) / current
        pct_b = (current - lb20) / (ub20 - lb20)

    vols_window = [float(b.get("成交量", 0) or 0) for b in window]
    vols_nonzero = [v for v in vols_window if v > 0]
    vol_avg = sum(vols_nonzero) / len(vols_nonzero) if vols_nonzero else 0
    volume_ratio = (vol_today / vol_avg) if vol_avg > 0 else None

    rsi = float(today.get("RSI14") or 0) or None

    # 階段一：整理（區間窄 + 均線糾結）
    was_consolidating = range_pct <= 0.12 and ma_spread_pct <= 0.03
    # 階段二：突破（站上區間高點 或 布林 %B > 1）
    breaks_out = current > range_high or (pct_b is not None and pct_b > 1.0)
    if not (was_consolidating and breaks_out):
        return None

    volume_confirm = volume_ratio is not None and volume_ratio >= 1.5
    momentum_confirm = (rsi is not None and rsi >= 55) or ma5 > ma20

    return {
        "code": code,
        "current_price": round(current, 2),
        "range_pct": round(range_pct * 100, 1),
        "range_high": round(range_high, 2),
        "ma_spread_pct": round(ma_spread_pct * 100, 1),
        "band_width_pct": round(band_width_pct * 100, 1) if band_width_pct is not None else None,
        "volume_ratio": round(volume_ratio, 2) if volume_ratio is not None else None,
        "volume_confirm": volume_confirm,
        "rsi": round(rsi, 1) if rsi is not None else None,
        "momentum_confirm": momentum_confirm,
        "confirm_score": int(volume_confirm) + int(momentum_confirm),
    }

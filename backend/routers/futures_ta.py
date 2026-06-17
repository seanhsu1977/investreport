"""期貨技術分析工具 — 輸入多空方向與進場價，回傳停損/目標/技術訊號"""
from __future__ import annotations

import math
from typing import List, Literal, Optional

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database import get_db
from models import TxfCandle
from price_analysis import _compute_rsi, _compute_bollinger, _compute_kdj_series

router = APIRouter(prefix="/futures", tags=["futures"])


# ── 資料模型 ───────────────────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    direction: Literal["long", "short"]
    entry_price: float = Field(..., gt=0, description="進場價格（台指期點位）")
    atr_multiplier: float = Field(0.5, ge=0.25, le=2.0, description="停損 ATR 倍數")


class Level(BaseModel):
    price: float
    label: str
    pct_from_entry: float


class AnalyzeResponse(BaseModel):
    direction: str
    entry_price: float
    current_price: float
    atr: float
    atr_pct: float

    atr_multiplier: float
    stop_loss: float
    stop_loss_pct: float
    stop_loss_twd: float

    targets: List[Level]
    supports: List[float]
    resistances: List[float]

    rsi: Optional[float]
    rsi_signal: str
    kdj_k: Optional[float]
    kdj_d: Optional[float]
    kdj_j: Optional[float]
    kdj_signal: str

    bollinger_upper: Optional[float]
    bollinger_lower: Optional[float]
    bb_signal: Optional[str]

    ma5: Optional[float]
    ma20: Optional[float]
    ma60: Optional[float]
    ma_signal: str

    volume_ratio: Optional[float]

    risk_reward: Optional[float]
    verdict: str
    advice: List[str]


# ── 計算工具 ───────────────────────────────────────────────────────────────────

def _atr(highs: pd.Series, lows: pd.Series, closes: pd.Series, period: int = 14) -> float:
    prev_close = closes.shift(1)
    tr = pd.concat([
        highs - lows,
        (highs - prev_close).abs(),
        (lows - prev_close).abs(),
    ], axis=1).max(axis=1)
    return float(tr.rolling(period).mean().iloc[-1])


def _find_sr(
    closes: pd.Series,
    highs: pd.Series,
    lows: pd.Series,
    current: float,
    lookback: int = 60,
) -> tuple[List[float], List[float]]:
    """找支撐/壓力：用最近 lookback 根K棒的局部高低點聚類"""
    n = min(lookback, len(closes))
    h = highs.iloc[-n:].tolist()
    l = lows.iloc[-n:].tolist()

    threshold = current * 0.008  # 0.8% 以內視為同一區間

    def cluster(vals: List[float]) -> List[float]:
        vals = sorted(vals)
        groups: list[List[float]] = []
        for v in vals:
            placed = False
            for g in groups:
                if abs(v - sum(g) / len(g)) < threshold:
                    g.append(v)
                    placed = True
                    break
            if not placed:
                groups.append([v])
        return sorted([round(sum(g) / len(g)) for g in groups])

    all_highs = cluster(h)
    all_lows  = cluster(l)

    resistances = sorted([v for v in all_highs if v > current + threshold], key=lambda x: x)[:3]
    supports    = sorted([v for v in all_lows  if v < current - threshold], key=lambda x: -x)[:3]
    return supports, resistances


def _kdj_latest(highs: pd.Series, lows: pd.Series, closes: pd.Series):
    try:
        ks, ds, js = _compute_kdj_series(closes, highs, lows)
        if not ks:
            return None, None, None
        return round(ks[-1], 1), round(ds[-1], 1), round(js[-1], 1)
    except Exception:
        return None, None, None


def _kdj_signal(k: Optional[float], d: Optional[float], j: Optional[float]) -> str:
    if k is None:
        return "資料不足"
    if k > 80 and d > 80:
        return "KDJ 超買區，留意回落"
    if k < 20 and d < 20:
        return "KDJ 超賣區，留意反彈"
    if k > d and j > k:
        return "KDJ 黃金交叉，動能向上"
    if k < d and j < k:
        return "KDJ 死亡交叉，動能向下"
    return "KDJ 中性"


def _rsi_signal(rsi: Optional[float], direction: str) -> str:
    if rsi is None:
        return "資料不足"
    if direction == "long":
        if rsi > 75:
            return f"RSI {rsi} — 超買，做多需謹慎，留意拉回"
        if rsi > 55:
            return f"RSI {rsi} — 多頭動能強，持多有利"
        if rsi > 45:
            return f"RSI {rsi} — 中性，方向待確認"
        return f"RSI {rsi} — 動能偏弱，做多需等回穩"
    else:
        if rsi < 25:
            return f"RSI {rsi} — 超賣，做空需謹慎，留意反彈"
        if rsi < 45:
            return f"RSI {rsi} — 空頭動能強，持空有利"
        if rsi < 55:
            return f"RSI {rsi} — 中性，方向待確認"
        return f"RSI {rsi} — 動能偏強，做空需等反壓確認"


def _build_targets(
    direction: str,
    entry: float,
    atr: float,
    resistances: List[float],
    supports: List[float],
) -> List[Level]:
    targets: List[Level] = []

    def add(price: float, label: str):
        pct = (price - entry) / entry * 100
        if direction == "long" and price > entry:
            targets.append(Level(price=round(price), label=label, pct_from_entry=round(pct, 2)))
        elif direction == "short" and price < entry:
            targets.append(Level(price=round(price), label=label, pct_from_entry=round(pct, 2)))

    # ATR 倍數目標
    for mult, label in [(0.5, "0.5x ATR"), (1.0, "1x ATR"), (2.0, "2x ATR")]:
        if direction == "long":
            add(entry + atr * mult, label)
        else:
            add(entry - atr * mult, label)

    # S/R 位目標
    for r in (resistances if direction == "long" else supports):
        add(r, "壓力位" if direction == "long" else "支撐位")

    # 去重、排序
    seen: set[float] = set()
    result: List[Level] = []
    key = (lambda t: t.price) if direction == "long" else (lambda t: -t.price)
    for t in sorted(targets, key=key):
        if round(t.price / 50) not in seen:
            seen.add(round(t.price / 50))
            result.append(t)
    return result[:4]


def _build_advice(
    direction: str,
    entry: float,
    current: float,
    rsi: Optional[float],
    kdj_k: Optional[float],
    atr: float,
    stop_loss: float,
    targets: List[Level],
    bb_signal: Optional[str],
    volume_ratio: Optional[float],
) -> tuple[str, List[str]]:
    advice: List[str] = []
    score = 0  # 正 = 有利方向，負 = 不利

    # 停損提醒
    sl_pts = abs(entry - stop_loss)
    atr_mult_label = f"{round(abs(sl_pts) / atr if atr else 0, 1)}x ATR"
    advice.append(f"停損設於 {round(stop_loss)} 點（距進場 {round(sl_pts)} 點 / {atr_mult_label}），觸及立即出場")

    # 目標提醒
    if targets:
        t1 = targets[0]
        advice.append(f"第一目標 {t1.price} 點（{t1.label}，+{abs(t1.pct_from_entry):.1f}%）")
        if len(targets) >= 2:
            t2 = targets[1]
            advice.append(f"若突破第一目標，移停損至成本，追蹤至 {t2.price} 點（{t2.label}）")

    # RSI
    if rsi is not None:
        if direction == "long" and rsi > 70:
            advice.append(f"⚠ RSI {rsi} 已進超買區，不宜追進；持倉者注意頂背離")
            score -= 1
        elif direction == "long" and rsi > 55:
            advice.append(f"RSI {rsi} 動能良好，可繼續持多，未見背離前不急出場")
            score += 1
        elif direction == "short" and rsi < 30:
            advice.append(f"⚠ RSI {rsi} 已進超賣區，不宜追空；持倉者注意底背離")
            score -= 1
        elif direction == "short" and rsi < 45:
            advice.append(f"RSI {rsi} 空頭動能持續，可繼續持空")
            score += 1

    # KDJ
    if kdj_k is not None:
        if direction == "long" and kdj_k > 80:
            advice.append(f"KDJ K值 {kdj_k} 超買，若出現死亡交叉考慮分批獲利")
            score -= 1
        elif direction == "short" and kdj_k < 20:
            advice.append(f"KDJ K值 {kdj_k} 超賣，若出現黃金交叉考慮分批回補")
            score -= 1

    # 布林通道
    if bb_signal:
        if direction == "long" and bb_signal in ("突破上軌", "近上軌"):
            advice.append(f"布林通道：{bb_signal}，短線阻力增加，建議移動停利保護獲利")
        elif direction == "short" and bb_signal in ("跌破下軌", "近下軌"):
            advice.append(f"布林通道：{bb_signal}，短線支撐減弱，空方有利")
            score += 1

    # 量能
    if volume_ratio is not None:
        if volume_ratio >= 1.5:
            advice.append(f"量能放大（均量 {volume_ratio:.1f}x），趨勢確認度高")
            score += 1
        elif volume_ratio < 0.7:
            advice.append(f"量能萎縮（均量 {volume_ratio:.1f}x），行情缺乏動力，注意假突破")
            score -= 1

    # 綜合判斷
    if score >= 2:
        verdict = "技術面有利，可積極持倉，用移動停利讓獲利奔跑"
    elif score >= 0:
        verdict = "技術面中性，依計畫執行，嚴守停損紀律"
    else:
        verdict = "技術面偏不利，建議縮小倉位或觀望，確認方向後再行動"

    return verdict, advice


# ── API 端點 ───────────────────────────────────────────────────────────────────

@router.post("/analyze", response_model=AnalyzeResponse)
def analyze_futures(req: AnalyzeRequest, db: Session = Depends(get_db)):
    rows = (
        db.query(TxfCandle)
        .order_by(TxfCandle.date.asc())
        .all()
    )
    rows = rows[-120:]  # 最近 120 根日K 已足夠

    if len(rows) < 20:
        raise HTTPException(status_code=503, detail="台指期K棒資料不足，請先同步資料")

    closes  = pd.Series([r.close  for r in rows])
    highs   = pd.Series([r.high   for r in rows])
    lows    = pd.Series([r.low    for r in rows])
    volumes = pd.Series([r.volume or 0 for r in rows])

    current_price = float(closes.iloc[-1])
    entry         = req.entry_price
    direction     = req.direction

    # ATR
    atr_val  = _atr(highs, lows, closes)
    atr_pct  = round(atr_val / current_price * 100, 2)

    # 停損：依使用者選擇的 ATR 倍數
    mult = req.atr_multiplier
    if direction == "long":
        stop_loss = entry - mult * atr_val
        sl_pct    = round((stop_loss - entry) / entry * 100, 2)
    else:
        stop_loss = entry + mult * atr_val
        sl_pct    = round((stop_loss - entry) / entry * 100, 2)

    # S/R
    supports, resistances = _find_sr(closes, highs, lows, current_price)

    # 目標
    targets = _build_targets(direction, entry, atr_val, resistances, supports)

    # RSI
    rsi_val    = _compute_rsi(closes)
    rsi_signal = _rsi_signal(rsi_val, direction)

    # KDJ
    kdj_k, kdj_d, kdj_j = _kdj_latest(highs, lows, closes)
    kdj_signal = _kdj_signal(kdj_k, kdj_d, kdj_j)

    # 布林
    bb = _compute_bollinger(closes, current_price)

    # MA
    ma5  = round(float(closes.rolling(5).mean().iloc[-1]),  0) if len(closes) >= 5  else None
    ma20 = round(float(closes.rolling(20).mean().iloc[-1]), 0) if len(closes) >= 20 else None
    ma60 = round(float(closes.rolling(60).mean().iloc[-1]), 0) if len(closes) >= 60 else None

    if ma5 and ma20 and ma60:
        if ma5 > ma20 > ma60:
            ma_signal = "多頭排列（MA5>MA20>MA60）"
        elif ma5 < ma20 < ma60:
            ma_signal = "空頭排列（MA5<MA20<MA60）"
        else:
            ma_signal = "均線糾結，趨勢待定"
    else:
        ma_signal = "均線資料不足"

    # 量能比
    avg_vol_20 = float(volumes.rolling(20).mean().iloc[-1]) if len(volumes) >= 20 else None
    last_vol   = float(volumes.iloc[-1]) if volumes.iloc[-1] > 0 else None
    vol_ratio  = round(last_vol / avg_vol_20, 2) if (avg_vol_20 and last_vol and avg_vol_20 > 0) else None

    # 風報比
    if targets:
        first_target = targets[0].price
        reward = abs(first_target - entry)
        risk   = abs(stop_loss - entry)
        rr     = round(reward / risk, 2) if risk > 0 else None
    else:
        rr = None

    verdict, advice = _build_advice(
        direction, entry, current_price, rsi_val, kdj_k,
        atr_val, stop_loss, targets, bb.get("signal"), vol_ratio,
    )

    return AnalyzeResponse(
        direction=direction,
        entry_price=entry,
        current_price=round(current_price),
        atr=round(atr_val),
        atr_pct=atr_pct,
        atr_multiplier=mult,
        stop_loss=round(stop_loss),
        stop_loss_pct=sl_pct,
        stop_loss_twd=round(abs(stop_loss - entry) * 50),  # 小台指每點50元
        targets=targets,
        supports=[round(s) for s in supports],
        resistances=[round(r) for r in resistances],
        rsi=rsi_val,
        rsi_signal=rsi_signal,
        kdj_k=kdj_k,
        kdj_d=kdj_d,
        kdj_j=kdj_j,
        kdj_signal=kdj_signal,
        bollinger_upper=bb.get("upper"),
        bollinger_lower=bb.get("lower"),
        bb_signal=bb.get("signal"),
        ma5=ma5,
        ma20=ma20,
        ma60=ma60,
        ma_signal=ma_signal,
        volume_ratio=vol_ratio,
        risk_reward=rr,
        verdict=verdict,
        advice=advice,
    )

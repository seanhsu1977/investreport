"""期交所選擇權 Put/Call Ratio 與大額交易人資料的抓取＋寫入資料庫。
期交所 CSV 單次查詢區間太長會回空內容，所以一律以日曆月為單位分段抓。"""
from __future__ import annotations
import logging
from datetime import date, timedelta

from sqlalchemy.orm import Session

import taifex
from models import OptionsPcr, LargeTraderTx

logger = logging.getLogger(__name__)


def _month_windows(start: date, end: date):
    cur = start
    while cur <= end:
        nxt = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
        yield cur, min(end, nxt - timedelta(days=1))
        cur = nxt


def sync_options_chips(db: Session, start: date, end: date) -> dict:
    """抓 [start, end] 的 PCR 與大額交易人並 upsert（已存在則更新）。回傳各自寫入筆數。"""
    pcr_n = lt_n = 0
    for a, b in _month_windows(start, end):
        for r in taifex.fetch_pcr_range(a, b):
            db.merge(OptionsPcr(**r))
            pcr_n += 1
        for r in taifex.fetch_large_traders_tx_range(a, b):
            db.merge(LargeTraderTx(**r))
            lt_n += 1
        db.commit()
        logger.info("options chips %s ~ %s: pcr=%d large_traders=%d (累計)", a, b, pcr_n, lt_n)
    return {"pcr": pcr_n, "large_traders": lt_n}

"""每日 00981A 操作 × 投顧報告 自動草稿生成。

Pipeline (cron 19:30+ Mon-Fri):
  1. nstock_etf 抓今日 ETF 操作明細
  2. 過濾「有投顧報告」的 active (buy/sell) 個股
  3. 排序選 1 檔最有故事
  4. 收集 context: 該股報告 + 量價訊號 + 法人籌碼 + 月營收 + 大盤背景 + 同日 ETF 其他動作
  5. Claude 以 Newtalk 蘇元和文風生成草稿
  6. 存 DailyArticle + Telegram 通知
"""
from __future__ import annotations
import json
import logging
import os
from datetime import date, datetime, timezone, timedelta
from typing import Optional

from dotenv import load_dotenv
load_dotenv(override=True)

import anthropic

import nstock_etf
import fundamental_analysis as fa
import price_analysis as pa
from database import SessionLocal
from models import Report, DailyArticle, FuturesChip
from stocks_master import resolve_name

logger = logging.getLogger(__name__)

TPE = timezone(timedelta(hours=8))
LLM_MODEL = os.environ.get("DAILY_ARTICLE_MODEL", "claude-sonnet-4-6")

# ──────────────────────────────────────────────────────────────────────
# Prompt
# ──────────────────────────────────────────────────────────────────────

_SYSTEM_PROMPT_TEMPLATE = """你是一位財經議題分析寫手，文風參考 Newtalk 記者「蘇元和」報導主動式 ETF 籌碼動向的寫法。
今日日期：{date_display}（請全文使用此具體日期，禁止使用「今日」「當天」「今天」等相對詞）

# 文風要求
- 「籌碼偵探」敘事：以主動 ETF 經理人的當日操作為切入點，搭配投顧報告觀點 + 量價數據 + 籌碼面，組合出「為什麼{date_display}這檔被盯上」的解讀
- 開場：用對比切入或情境鋪陳（例如先講大盤背景、產業氛圍、近期主流題材），再帶出主角股票
- 中段句型多用「主語 + 時間 + 動作 + 數據」，例如「00981A {date_display}加碼貿聯-KY 206 張，{date_display}股價收 2,780 元、漲幅 5.7%」
- 把幾個資訊軸線「拉在一起看」：ETF 動作 / 投顧觀點 / 法人籌碼 / 量價 / 基本面，至少串接 2~3 條
- 數據呈現：關鍵數字直接寫出，不使用任何 Markdown 標記（不要 **粗體**、不要 `反引號`）
- 多用轉場詞：「但從執行面來看」「反過來說」「把幾個時間點拉在一起看」「背後的邏輯完全不同」
- 結尾：開放式收法，不給投資建議，可用「值得繼續追蹤」「後面怎麼走，要看接下來幾週的部署節奏」這類埋懸念
- 文章必須以下列免責聲明結尾（一字不動）：
  ```
  ※ 本文為公開資訊整理與觀點分析，非任何形式之投資建議。投資人應自行判斷風險。
  ```

# 結構與長度
- 800–1500 字
- 標題：吸睛但不浮誇，可用「？」製造懸念，例如「00981A {date_display}重押 XXX，投顧 N 家目標價 Y 元，背後在押什麼？」
- 文中一律使用「00981A」稱呼此 ETF，禁止出現「ETF小百科」
- 第一段：勾子 + 點題（誰買了什麼）
- 中段 2~4 段：分別串接「投顧觀點」「籌碼面」「量價/技術面」「同 ETF 其他動作對照」中的至少 2~3 個面向
- 最後一段：埋懸念 + 觀察重點

# 嚴禁
- 不要 emoji
- 不要直接給「買進 / 賣出」建議
- 不要編造數據（只能用 context 提供的數據）
- 不要寫「身為投資人」「我認為」這類第一人稱主觀語
- 禁止使用「今日」「今天」「當天」「當日」等相對時間詞，一律改為具體日期（{date_display}）

# 輸出格式
請輸出 JSON，且只輸出 JSON，不要任何前後敘述：
{
  "title": "文章標題",
  "content": "文章正文（純文字，無任何 Markdown 標記，結尾含免責聲明）"
}
"""


# ──────────────────────────────────────────────────────────────────────
# 候選股排序 / context 組裝
# ──────────────────────────────────────────────────────────────────────

def _today_tpe() -> date:
    return datetime.now(TPE).date()


def _select_topic(
    db, etf_data: dict, target_date: date,
) -> Optional[dict]:
    """從 ETF 今日 active 個股中，挑 1 檔有報告的當主題。

    優先順序：
      1. 必須有報告 (Report.stock_code in active codes)
      2. shares 大的優先
      3. 同分時 buy 優先於 sell
    """
    active = [s for s in etf_data["stocks"] if s["action"] != "flat"]
    if not active:
        return None

    # 過濾有報告的
    codes = [s["code"] for s in active]
    has_report_codes = {
        r[0] for r in db.query(Report.stock_code)
        .filter(Report.stock_code.in_(codes)).distinct().all()
    }
    candidates = [s for s in active if s["code"] in has_report_codes]
    if not candidates:
        logger.info("Active 個股 %s 都沒有報告", codes)
        return None

    # 排序：shares desc, buy 優先
    candidates.sort(key=lambda s: (s["shares"], 1 if s["action"] == "buy" else 0), reverse=True)
    return candidates[0]


def _gather_context(db, topic: dict, etf_data: dict, target_date: date) -> dict:
    """組 LLM context：投顧報告 + 量價 + 法人 + 月營收 + 大盤 + 同 ETF 其他動作。"""
    code = topic["code"]
    name = topic["name"]

    # 1. 該股近 90 天投顧報告（含目標價、評等、key_points）
    cutoff = (datetime.utcnow() - timedelta(days=90))
    rows = (
        db.query(Report)
        .filter(Report.stock_code == code, Report.created_at >= cutoff)
        .order_by(Report.report_date.desc().nullslast(), Report.created_at.desc())
        .limit(10).all()
    )
    reports = []
    for r in rows:
        reports.append({
            "date": str(r.report_date or r.created_at.date() if r.created_at else ""),
            "analyst": r.analyst,
            "recommendation": r.recommendation,
            "target_price": r.target_price,
            "summary": (r.summary or "")[:300],
            "key_points": json.loads(r.key_points)[:5] if r.key_points else [],
        })

    # 2. 量價技術訊號（yfinance）
    try:
        signals = pa.get_signals(code)
    except Exception as e:
        logger.warning("get_signals(%s) failed: %s", code, e)
        signals = None

    # 3. 法人近 5 日 / 月營收
    try:
        institutional = fa.get_institutional(code, days=5)
    except Exception as e:
        logger.warning("get_institutional(%s) failed: %s", code, e)
        institutional = None
    try:
        revenue = fa.get_revenue(code)
    except Exception as e:
        logger.warning("get_revenue(%s) failed: %s", code, e)
        revenue = None

    # 4. 大盤背景（前一個交易日 chips 快照）
    market = None
    chip_row = (
        db.query(FuturesChip).order_by(FuturesChip.date.desc()).first()
    )
    if chip_row:
        try:
            ck = json.loads(chip_row.payload)
            taiex = ck.get("taiex") or {}
            market = {
                "date": chip_row.date,
                "taiex_close": taiex.get("close"),
                "taiex_change_pct": taiex.get("change_pct"),
            }
        except Exception:
            pass

    # 5. 同日 ETF 其他 active 動作（最多 5 檔，給對照素材）
    other_active = [
        {"code": s["code"], "name": s["name"], "action": s["action"], "shares": s["shares"]}
        for s in etf_data["stocks"]
        if s["action"] != "flat" and s["code"] != code
    ][:5]

    return {
        "topic": {
            "code": code,
            "name": resolve_name(code, name),
            "etf_action": topic["action"],
            "etf_shares": topic["shares"],
            "today_price": topic["price"],
            "today_change_pct": topic["change_pct"],
            "today_volume": topic["volume"],
        },
        "etf": {
            "name": "00981A",
            "manager": "00981A",
            "source_url": etf_data["source_url"],
            "date": etf_data["date"],
            "other_active": other_active,
        },
        "reports": reports,
        "signals": signals,
        "institutional": institutional,
        "revenue": revenue,
        "market": market,
        "target_date": target_date.isoformat(),
    }


# ──────────────────────────────────────────────────────────────────────
# LLM 呼叫
# ──────────────────────────────────────────────────────────────────────

def _call_llm(context: dict) -> dict:
    """呼叫 Claude，回傳 {'title': ..., 'content': ...}。"""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    # 將日期格式化為「6月10日」形式注入 system prompt
    from datetime import date as _date
    try:
        d = _date.fromisoformat(context["target_date"])
        date_display = f"{d.month}月{d.day}日"
    except Exception:
        date_display = context.get("target_date", "")

    system_prompt = _SYSTEM_PROMPT_TEMPLATE.format(date_display=date_display)

    user_msg = (
        f"以下是 {date_display} 的素材，請依文風要求產出 JSON：\n\n"
        + json.dumps(context, ensure_ascii=False, indent=2)
    )

    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=LLM_MODEL,
        system=system_prompt,
        messages=[{"role": "user", "content": user_msg}],
        max_tokens=4000,
    )
    text = resp.content[0].text.strip()
    # 容錯：可能被包在 ```json ... ``` 裡
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        out = json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"LLM 回傳非 JSON: {text[:200]}…") from e
    if "title" not in out or "content" not in out:
        raise RuntimeError(f"LLM 回傳缺欄位: keys={list(out.keys())}")
    return out


# ──────────────────────────────────────────────────────────────────────
# 主入口
# ──────────────────────────────────────────────────────────────────────

def generate_for_date(target_date: Optional[date] = None, *, force: bool = False) -> Optional[int]:
    """為指定日期生成草稿。回傳 DailyArticle.id，無素材時回 None。

    Args:
        target_date: 目標日期，預設為今日（Asia/Taipei）
        force: True 時即使該日已有 DailyArticle 也會重新生成（覆寫）
    """
    target_date = target_date or _today_tpe()
    iso = target_date.isoformat()

    db = SessionLocal()
    try:
        # 已生成過就跳過（除非 force）
        existing = db.query(DailyArticle).filter(DailyArticle.date == iso).first()
        if existing and not force:
            logger.info("%s 已有 DailyArticle id=%s，skip", iso, existing.id)
            return existing.id

        # 1. 抓 ETF 操作明細
        date_slash = target_date.strftime("%Y/%m/%d")
        etf_data = nstock_etf.fetch_today(date_slash)
        if not etf_data:
            logger.info("ETF小百科 %s 尚未發文", date_slash)
            return None

        # 2. 選主題
        topic = _select_topic(db, etf_data, target_date)
        if not topic:
            logger.info("%s 無候選股（active 個股皆無投顧報告）", iso)
            return None

        logger.info("%s topic = %s %s (%s %d張)",
                    iso, topic["code"], topic["name"], topic["action"], topic["shares"])

        # 3. 收集 context
        context = _gather_context(db, topic, etf_data, target_date)

        # 4. 呼叫 LLM
        result = _call_llm(context)

        # 5. 存表
        if existing:
            existing.topic_stock_code = topic["code"]
            existing.topic_stock_name = context["topic"]["name"]
            existing.title = result["title"]
            existing.content = result["content"]
            existing.raw_context = json.dumps(context, ensure_ascii=False)
            existing.generated_at = datetime.utcnow()
            existing.published_at = None
            existing.nstock_article_id = None
            article = existing
        else:
            article = DailyArticle(
                date=iso,
                topic_stock_code=topic["code"],
                topic_stock_name=context["topic"]["name"],
                title=result["title"],
                content=result["content"],
                raw_context=json.dumps(context, ensure_ascii=False),
            )
            db.add(article)
        db.commit()
        db.refresh(article)

        # 6. Telegram 推播（best effort）
        try:
            from notifier import notify_daily_draft
            notify_daily_draft(article)
        except Exception as e:
            logger.warning("notify_daily_draft failed: %s", e)

        return article.id
    finally:
        db.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    import sys
    if len(sys.argv) > 1:
        d = datetime.strptime(sys.argv[1], "%Y-%m-%d").date()
    else:
        d = _today_tpe()
    aid = generate_for_date(d, force=True)
    print(f"DailyArticle id = {aid}")

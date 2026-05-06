from __future__ import annotations
import logging
import os
import threading
import time
import httpx

logger = logging.getLogger(__name__)

_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID", "")

_polling_thread: threading.Thread | None = None
_stop_event = threading.Event()


def is_configured() -> bool:
    return bool(_BOT_TOKEN and _CHAT_ID)


def send_message(text: str) -> bool:
    """傳送 Telegram 訊息，回傳是否成功。"""
    if not is_configured():
        logger.warning("Telegram 未設定，跳過通知")
        return False
    try:
        url = f"https://api.telegram.org/bot{_BOT_TOKEN}/sendMessage"
        with httpx.Client(timeout=10) as c:
            resp = c.post(url, json={
                "chat_id": _CHAT_ID,
                "text": text,
                "parse_mode": "HTML",
            })
        ok = resp.json().get("ok", False)
        if not ok:
            logger.error(f"Telegram API 錯誤: {resp.text}")
        return ok
    except Exception as e:
        logger.error(f"Telegram 傳送失敗: {e}")
        return False


def notify_sync_done(result: dict, new_reports: list[dict]) -> None:
    """同步完成後發送通知。"""
    processed = result.get("processed", 0)
    if processed == 0:
        return

    stock_reports = [r for r in new_reports if r["stock_code"] != "MARKET"]
    market_news   = [r for r in new_reports if r["stock_code"] == "MARKET"]

    lines = ["📊 <b>投顧報告同步完成</b>"]
    lines.append(f"共新增 <b>{processed}</b> 篇報告\n")

    if stock_reports:
        lines.append("📌 <b>個股報告</b>")
        for r in stock_reports[:10]:
            code = r["stock_code"]
            name = r.get("stock_name") or ""
            rec  = r.get("recommendation") or ""
            tp   = r.get("target_price")
            tp_str = f" 目標價 {tp}" if tp else ""
            rec_icon = {"買進": "🔴", "Buy": "🔴", "賣出": "🟢", "Sell": "🟢"}.get(rec, "⚪")
            lines.append(f"  {rec_icon} <b>{code}</b> {name}  {rec}{tp_str}")
        if len(stock_reports) > 10:
            lines.append(f"  …等共 {len(stock_reports)} 篇")

    if market_news:
        lines.append(f"\n📰 <b>市場新聞</b> {len(market_news)} 則")
        for r in market_news[:3]:
            title = (r.get("summary") or "")[:40]
            if title:
                lines.append(f"  · {title}…")

    warning = result.get("warning")
    if warning:
        lines.append(f"\n⚠️ {warning}")

    send_message("\n".join(lines))


def notify_daily_draft(article) -> None:
    """每日 00981A × 報告 草稿生成完通知。

    article: DailyArticle ORM instance
    """
    preview = (article.content or "")[:200].replace("\n", " ")
    if len(article.content or "") > 200:
        preview += "…"
    lines = [
        "🤖 <b>每日草稿生成完成</b>",
        f"📅 {article.date}",
        f"🎯 主題：<b>{article.topic_stock_code} {article.topic_stock_name or ''}</b>",
        f"📝 {article.title}",
        "",
        f"<i>{preview}</i>",
        "",
        "進後台 → 社群發布 → 每日草稿 編輯 / 發布",
    ]
    send_message("\n".join(lines))


# ── Bot 指令處理 ──────────────────────────────────────────────

def _handle_command(text: str) -> str:
    cmd = text.strip().lower().split()[0]

    if cmd in ("/sync", "同步"):
        from database import SessionLocal
        from scheduler import run_sync_now, get_sync_progress
        import re
        if get_sync_progress().get("running"):
            return "⏳ 同步已在進行中，請稍候…"
        since = None
        m = re.search(r"(\d{4}-\d{2}-\d{2})", text)
        if m:
            since = m.group(1)
        def _do(since=since):
            db = SessionLocal()
            try:
                run_sync_now(db, since=since)
            finally:
                db.close()
        threading.Thread(target=_do, daemon=True).start()
        since_str = f"（{since} 之後）" if since else "（全部未處理）"
        return f"🔄 已啟動同步 {since_str}，完成後會通知你。"

    if cmd in ("/status", "狀態"):
        from scheduler import get_last_sync_result, get_sync_progress
        prog = get_sync_progress()
        if prog.get("running"):
            p = prog.get("processed", 0)
            t = prog.get("total", 0)
            return f"⏳ 同步進行中：{p}/{t} 筆"
        result = get_last_sync_result()
        if not result:
            return "ℹ️ 尚未執行過同步。"
        synced_at = result.get("synced_at", "")[:16].replace("T", " ")
        return (
            f"✅ 上次同步：{synced_at}\n"
            f"新增 {result.get('processed',0)} 筆 / "
            f"跳過 {result.get('skipped',0)} 筆 / "
            f"錯誤 {result.get('errors',0)} 筆"
        )

    if cmd in ("/market", "大盤"):
        try:
            from price_analysis import get_market_overview
            data = get_market_overview()
            if not data:
                return "⚠️ 大盤資料暫無法取得"

            def fmt_entry(idx: dict) -> str:
                up = idx["change"] >= 0
                arrow = "▲" if up else "▼"
                pct = f"{arrow}{abs(idx['change_pct']):.2f}%"
                cur = f"{idx['current']:,.0f}" if idx["current"] >= 100 else f"{idx['current']:.2f}"
                return f"<code>{idx['name']}  {cur}  {pct}</code>\n{idx['suggestion']}"

            GROUPS = [
                ("🇹🇼 台灣", ["TWII", "TWOII"]),
                ("🇺🇸 美股", ["SPX", "NDX", "DJI", "SOX"]),
                ("🌏 亞股", ["N225", "HSI"]),
                ("🏗 商品／匯率", ["GOLD", "OIL", "DXY"]),
            ]
            parts = ["📈 <b>大盤概況</b>"]
            for title, keys in GROUPS:
                entries = [fmt_entry(data[k]) for k in keys if k in data]
                if entries:
                    parts.append(f"<b>{title}</b>\n" + "\n\n".join(entries))
            return "\n\n".join(parts)
        except Exception as e:
            return f"⚠️ 取得大盤資料失敗：{e}"

    if cmd in ("/help", "help", "?", "說明"):
        return (
            "🤖 <b>可用指令</b>\n\n"
            "/sync 或 同步 — 立即觸發報告同步\n"
            "/status 或 狀態 — 查看上次同步結果\n"
            "/market 或 大盤 — 取得大盤即時概況\n"
            "/help — 顯示此說明"
        )

    return "❓ 未知指令，傳送 /help 查看可用指令。"


def _poll_loop():
    """背景輪詢 Telegram 更新，處理來自授權 Chat ID 的指令。"""
    offset = 0
    logger.info("Telegram Bot 輪詢已啟動")
    while not _stop_event.is_set():
        try:
            url = f"https://api.telegram.org/bot{_BOT_TOKEN}/getUpdates"
            with httpx.Client(timeout=30) as c:
                resp = c.get(url, params={"offset": offset, "timeout": 25})
            updates = resp.json().get("result", [])
            for update in updates:
                offset = update["update_id"] + 1
                msg = update.get("message", {})
                chat_id = str(msg.get("chat", {}).get("id", ""))
                text = msg.get("text", "").strip()
                if not text or chat_id != _CHAT_ID:
                    continue
                reply = _handle_command(text)
                send_message(reply)
        except Exception as e:
            if not _stop_event.is_set():
                logger.warning(f"Telegram 輪詢錯誤：{e}")
                time.sleep(5)


def start_polling():
    """啟動 Telegram Bot 輪詢（背景執行緒）。"""
    global _polling_thread
    if not is_configured():
        return
    _stop_event.clear()
    _polling_thread = threading.Thread(target=_poll_loop, daemon=True, name="telegram-poll")
    _polling_thread.start()


def stop_polling():
    _stop_event.set()

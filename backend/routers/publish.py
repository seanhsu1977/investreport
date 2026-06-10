from __future__ import annotations
import asyncio
import json
import os
import re
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from urllib.parse import unquote
import httpx
import anthropic
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import SessionLocal, get_db
from models import Report, Stock, DailyArticle
from routers.auth import require_admin

router = APIRouter(prefix="/publish", tags=["publish"])

THREADS_MAX = 500
THREADS_SAFE = 490  # 留 buffer 給 (1/N) 編號標記
TPE = timezone(timedelta(hours=8))

NSTOCK_BASE = os.environ.get("NSTOCK_ADMIN_BASE", "https://admin-kt290.nstock.com.tw")
NSTOCK_ARTICLE_PATH = "/admin-api/article"

# 記憶體內 cookie 快取，避免每次請求都重新登入
_nstock_cookie_cache: dict | None = None


def _nstock_login() -> tuple[dict, dict]:
    """用帳密自動登入 nStock admin，回傳 (headers, cookies)。"""
    global _nstock_cookie_cache
    email = os.environ.get("NSTOCK_ADMIN_EMAIL", "").strip()
    password = os.environ.get("NSTOCK_ADMIN_PASS", "").strip()
    if not email or not password:
        raise HTTPException(503, "請在 .env 設定 NSTOCK_ADMIN_EMAIL 和 NSTOCK_ADMIN_PASS")

    login_url = f"{NSTOCK_BASE}/admin/auth/login"
    with httpx.Client(follow_redirects=True, timeout=15) as c:
        r = c.get(login_url)
        m = re.search(r'Admin\.token\s*=\s*"([^"]+)"', r.text)
        if not m:
            raise HTTPException(503, "無法取得 nStock 登入頁 CSRF token")
        c.post(login_url, data={"_token": m.group(1), "username": email, "password": password})
        cookies = dict(c.cookies)

    xsrf = cookies.get("XSRF-TOKEN", "")
    if not xsrf or "laravel_session" not in cookies:
        raise HTTPException(503, "nStock 自動登入失敗，請確認 NSTOCK_ADMIN_EMAIL / NSTOCK_ADMIN_PASS 正確")

    headers = {
        "Content-Type": "application/json;charset=UTF-8",
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "X-XSRF-TOKEN": unquote(xsrf),
        "Referer": NSTOCK_BASE + "/admin",
        "Origin": NSTOCK_BASE,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    }
    _nstock_cookie_cache = {"headers": headers, "cookies": cookies}
    return headers, cookies

DRAFT_SYSTEM = """你是一位財經社群媒體編輯，擅長將投顧研究報告改寫成適合 Threads 的貼文。
風格要求：
- 口語、親切，像在跟朋友分享投資資訊
- 適當使用 emoji 增加閱讀感
- 結尾可加上互動問句或投資提醒
- 不要使用 Markdown 語法（不要 **、##），純文字

長度與分段：
- 短篇優先：若 1~3 檔股票、可在 ~480 字內講完，就寫一篇即可
- 長篇支援：複雜內容或多檔股票時可寫到 ~1500 字，系統會自動把超過 500 字的草稿
  以段落為界切成多段，串成 Threads 留言鏈（每段尾自動加 (n/total) 編號），不要自己標
- 重要：請以連續兩個換行 (\\n\\n) 明確分段，每段以一個完整想法為單位
- 每段（兩個 \\n\\n 之間）盡量不要超過 480 字，方便系統依段落切分；段內可有單換行
- 多檔股票時，各檔之間以 \\n\\n--- \\n\\n 分隔（系統會把每檔分到不同段）"""


class DraftRequest(BaseModel):
    report_ids: List[int]
    hint: Optional[str] = None


class PublishRequest(BaseModel):
    text: str
    topic_tag: Optional[str] = None


class FacebookPublishRequest(BaseModel):
    text: str
    link: Optional[str] = None    # 帶連結會生 link card
    picture: Optional[str] = None  # 覆蓋 og:image 縮圖（完整圖片 URL）


@router.get("/reports")
def list_reports(
    limit: int = 100,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    rows = (
        db.query(Report)
        .order_by(Report.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": r.id,
            "stock_code": r.stock_code,
            "stock_name": r.stock_name,
            "recommendation": r.recommendation,
            "target_price": r.target_price,
            "analyst": r.analyst,
            "report_date": str(r.report_date or ""),
            "summary": (r.summary or "")[:100],
        }
        for r in rows
    ]


@router.post("/draft")
def generate_draft(
    body: DraftRequest,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    reports = db.query(Report).filter(Report.id.in_(body.report_ids)).all()
    if not reports:
        raise HTTPException(status_code=400, detail="找不到指定報告")

    parts = []
    for r in reports:
        kp = json.loads(r.key_points) if r.key_points else []
        line = f"股票：{r.stock_code} {r.stock_name or ''}\n評等：{r.recommendation or '—'}｜目標價：{r.target_price or '—'}\n分析師：{r.analyst or '—'}｜日期：{r.report_date or ''}"
        if r.summary:
            line += f"\n摘要：{r.summary[:400]}"
        if kp:
            line += "\n重點：" + "；".join(kp[:4])
        parts.append(line)

    context = "\n\n---\n\n".join(parts)
    user_msg = f"請根據以下報告資料，撰寫一篇 Threads 貼文：\n\n{context}"
    if body.hint:
        user_msg += f"\n\n補充方向：{body.hint}"

    def generate():
        try:
            client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
            with client.messages.stream(
                model="claude-sonnet-4-6",
                system=DRAFT_SYSTEM,
                messages=[{"role": "user", "content": user_msg}],
                max_tokens=3000,
            ) as stream:
                for text in stream.text_stream:
                    yield f"data: {json.dumps({'text': text}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def split_for_threads(text: str, max_len: int = THREADS_SAFE) -> List[str]:
    """把長文切成多段以串成 Threads 留言鏈。

    優先在段落（連續換行）→ 句號／問號／驚嘆號 → 換行 → 硬切的順序找邊界，
    並在每段尾標 (n/total) 以提示讀者連續性。
    """
    text = text.strip()
    if not text:
        return []

    raw_segments: list[str] = []
    remaining = text
    sentence_re = re.compile(r"([。！？!?\n])")

    # 先以「段落（連續換行）」為單位累積；超出 max 時再用句號 fallback
    paragraphs = re.split(r"\n{2,}", remaining)
    buf = ""
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        candidate = (buf + "\n\n" + para) if buf else para
        if len(candidate) <= max_len:
            buf = candidate
            continue
        if buf:
            raw_segments.append(buf)
            buf = ""
        if len(para) <= max_len:
            buf = para
            continue
        # 段落本身 > max：以句號切
        chunk = ""
        pieces = sentence_re.split(para)
        for piece in pieces:
            cand = chunk + piece
            if len(cand) <= max_len:
                chunk = cand
            else:
                if chunk:
                    raw_segments.append(chunk.strip())
                if len(piece) > max_len:
                    # 句子過長：硬切
                    for i in range(0, len(piece), max_len):
                        raw_segments.append(piece[i:i + max_len])
                    chunk = ""
                else:
                    chunk = piece
        if chunk:
            buf = chunk.strip()
    if buf:
        raw_segments.append(buf)

    # 加 (n/total) 標記
    n = len(raw_segments)
    if n <= 1:
        return raw_segments
    return [f"{seg}\n({i + 1}/{n})" for i, seg in enumerate(raw_segments)]


@router.post("/threads/preview")
def preview_chain(body: PublishRequest, _: None = Depends(require_admin)):
    """預覽切段結果，不實際發布"""
    segments = split_for_threads(body.text)
    return {
        "segments": segments,
        "count": len(segments),
        "lengths": [len(s) for s in segments],
    }


async def _wait_container_ready(
    client: httpx.AsyncClient, base: str, creation_id: str, token: str,
    timeout: float = 25.0,
) -> None:
    """輪詢 media container 狀態直到 FINISHED 或超時。"""
    start = asyncio.get_event_loop().time()
    while asyncio.get_event_loop().time() - start < timeout:
        try:
            r = await client.get(
                f"{base}/{creation_id}",
                params={"fields": "status,error_message", "access_token": token},
            )
            if r.status_code == 200:
                payload = r.json()
                status = payload.get("status") or ""
                if status == "FINISHED":
                    return
                if status == "ERROR":
                    raise HTTPException(
                        status_code=502,
                        detail=f"Threads container 處理失敗：{payload.get('error_message')}"
                    )
        except HTTPException:
            raise
        except Exception:
            pass
        await asyncio.sleep(1.5)
    # 超時不報錯，讓 publish 自己決定（有時 status API 沒同步但 publish 仍可成功）


async def _create_thread_post(
    client: httpx.AsyncClient, base: str, user_id: str, token: str,
    text: str, reply_to_id: Optional[str] = None,
    topic_tag: Optional[str] = None,
) -> str:
    """建立 + 發布一則 Threads 貼文，回傳 post_id。"""
    params = {"media_type": "TEXT", "text": text, "access_token": token}
    if reply_to_id:
        params["reply_to_id"] = reply_to_id
    if topic_tag:
        params["topic_tag"] = topic_tag
    r1 = await client.post(f"{base}/{user_id}/threads", params=params)
    if r1.status_code != 200:
        err = r1.json() if r1.headers.get("content-type", "").startswith("application/json") else r1.text
        raise HTTPException(status_code=502, detail=f"Threads API 錯誤（建立貼文）：{err}")
    creation_id = r1.json().get("id")

    # 等 container 處理完才能 publish；reply 尤其需要這段等待
    await _wait_container_ready(client, base, creation_id, token)

    r2 = await client.post(
        f"{base}/{user_id}/threads_publish",
        params={"creation_id": creation_id, "access_token": token},
    )
    if r2.status_code != 200:
        err = r2.json() if r2.headers.get("content-type", "").startswith("application/json") else r2.text
        raise HTTPException(status_code=502, detail=f"Threads API 錯誤（發布）：{err}")
    return r2.json().get("id")


@router.post("/threads")
async def publish_threads(
    body: PublishRequest,
    _: None = Depends(require_admin),
):
    token = os.environ.get("THREADS_ACCESS_TOKEN", "")
    user_id = os.environ.get("THREADS_USER_ID", "")

    if not token or not user_id:
        raise HTTPException(
            status_code=503,
            detail="尚未設定 THREADS_ACCESS_TOKEN / THREADS_USER_ID，請在 .env 填入後重啟"
        )

    segments = split_for_threads(body.text)
    if not segments:
        raise HTTPException(status_code=400, detail="貼文內容為空")

    base = "https://graph.threads.net/v1.0"
    posted: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            parent_id: Optional[str] = None
            for i, seg in enumerate(segments):
                # 主題標籤只掛在第一段（主貼文），回覆段不帶
                tag = body.topic_tag if i == 0 else None
                post_id = await _create_thread_post(
                    client, base, user_id, token, seg,
                    reply_to_id=parent_id, topic_tag=tag,
                )
                posted.append(post_id)
                parent_id = post_id
                # 多段時稍等避免 API rate limit / processing race（reply container 需要時間）
                if i < len(segments) - 1:
                    await asyncio.sleep(2.5)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"發布失敗（已成功 {len(posted)}/{len(segments)}）：{e}")

    return {
        "success": True,
        "post_id": posted[0],         # 主貼文 id（向下相容）
        "post_ids": posted,           # 完整鏈
        "segments": len(segments),
    }


# ────────────────────────────────────────────────────────────
# nStock 後台同步發文
# ────────────────────────────────────────────────────────────

def _parse_cookie_string(raw: str) -> dict:
    out: dict = {}
    for kv in raw.split(";"):
        kv = kv.strip()
        if "=" in kv:
            k, v = kv.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def _nstock_auth(force_refresh: bool = False) -> tuple[dict, dict]:
    """取得 nStock admin headers + cookies。

    優先使用 NSTOCK_ADMIN_EMAIL + NSTOCK_ADMIN_PASS 自動登入（有 memory cache）。
    若未設定帳密，退回舊的 NSTOCK_COOKIE 手動方式。
    """
    global _nstock_cookie_cache

    # 優先：帳密自動登入
    if os.environ.get("NSTOCK_ADMIN_EMAIL") and os.environ.get("NSTOCK_ADMIN_PASS"):
        if not force_refresh and _nstock_cookie_cache:
            return _nstock_cookie_cache["headers"], _nstock_cookie_cache["cookies"]
        return _nstock_login()

    # 退回：手動 cookie
    raw = os.environ.get("NSTOCK_COOKIE", "").strip()
    if not raw:
        raise HTTPException(
            status_code=503,
            detail="請在 .env 設定 NSTOCK_ADMIN_EMAIL + NSTOCK_ADMIN_PASS（自動登入），或手動設定 NSTOCK_COOKIE"
        )
    cookies = _parse_cookie_string(raw)
    xsrf_cookie = cookies.get("XSRF-TOKEN", "")
    if not xsrf_cookie or "laravel_session" not in cookies:
        raise HTTPException(status_code=503, detail="NSTOCK_COOKIE 缺少 XSRF-TOKEN 或 laravel_session")
    headers = {
        "Content-Type": "application/json;charset=UTF-8",
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "X-XSRF-TOKEN": unquote(xsrf_cookie),
        "Referer": NSTOCK_BASE + "/admin",
        "Origin": NSTOCK_BASE,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    }
    return headers, cookies


_TW_CODE_RE = re.compile(r"(?<!\d)(\d{4,6})(?!\d)")


def extract_stock_codes(text: str) -> list[str]:
    """從內文掃出可能的台股代號，再用 stocks 主檔過濾掉誤判。

    主檔由 stocks_master.seed_stocks 從 nstock.tw 灌入，所以只會留下真實上市櫃代號。
    """
    if not text:
        return []
    candidates = {m for m in _TW_CODE_RE.findall(text) if 4 <= len(m) <= 6}
    if not candidates:
        return []
    db = SessionLocal()
    try:
        rows = db.query(Stock.code).filter(Stock.code.in_(list(candidates))).all()
    finally:
        db.close()
    return sorted({r[0] for r in rows})


_MD_BOLD_RE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)


def text_to_html(text: str) -> str:
    """把純文字（含 Markdown 粗體 **xxx**）草稿轉成 nStock 可接受的 HTML。

    處理：
      - 連續換行 → 段落 (<p>)，段落之間補 <p><br></p> 製造視覺空行
      - 段內單換行 → <br>
      - **xxx** → <strong>xxx</strong>
      - 單獨成段的 `---` → <hr>
    """
    paragraphs = re.split(r"\n{2,}", text.strip())
    parts = []
    for p in paragraphs:
        p = p.strip()
        if not p:
            continue
        if p.strip() == "---":
            parts.append("<hr>")
            continue
        # 段內單換行轉 <br>
        line = p.replace("\n", "<br>")
        # Markdown 粗體 → <strong>
        line = _MD_BOLD_RE.sub(r"<strong>\1</strong>", line)
        parts.append(f"<p>{line}</p>")

    # 段落之間插 <p><br></p> 空段落（除了 <hr> 前後不用，本身已是分隔）
    out: list[str] = []
    for i, p in enumerate(parts):
        if i > 0 and not (p == "<hr>" or out[-1] == "<hr>"):
            out.append("<p><br></p>")
        out.append(p)
    return "\n".join(out)


class NStockPublishRequest(BaseModel):
    title: str
    content: str                      # 純文字草稿（會自動轉 HTML）；或直接給 HTML（如已含 <p>）
    is_html: bool = False             # True: content 已是 HTML；False: 純文字自動轉
    author_id: Optional[int] = None   # 預設讀 NSTOCK_AUTHOR_ID env
    auth_name: Optional[str] = None   # 預設讀 NSTOCK_AUTHOR_NAME env
    stock_ids: Optional[str] = None   # 用逗號分隔，如 "2330,2454"
    key_word: Optional[str] = None
    description: Optional[str] = None
    publish_time: Optional[str] = None  # YYYY-MM-DD HH:MM:SS, 省略=現在 (台北時區)
    img_path: Optional[str] = None    # 已上傳到 nStock 的圖片相對路徑
    status: bool = True               # True=上架


@router.post("/nstock")
async def publish_nstock(body: NStockPublishRequest, _: None = Depends(require_admin)):
    headers, cookies = _nstock_auth()

    author_id = body.author_id or int(os.environ.get("NSTOCK_AUTHOR_ID") or 0)
    if not author_id:
        raise HTTPException(400, "未指定 author_id（在 .env 設 NSTOCK_AUTHOR_ID 或請求帶入）")
    auth_name = body.auth_name or os.environ.get("NSTOCK_AUTHOR_NAME", "")
    publish_time = body.publish_time or datetime.now(TPE).strftime("%Y-%m-%d %H:%M:%S")
    content_html = body.content if body.is_html else text_to_html(body.content)

    # 以 caller 指定的 stock_ids 為種子，再從內文掃描並合併（去重保序）
    seed = [s.strip() for s in (body.stock_ids or "").split(",") if s.strip()]
    scanned = extract_stock_codes(f"{body.title}\n{body.content}")
    merged = list(dict.fromkeys(seed + scanned))  # 保序去重，種子優先
    stock_ids = ",".join(merged) if merged else None

    payload = {
        "title": body.title,
        "sub_title": None,
        "auth": auth_name,
        "author_id": author_id,
        "description": body.description,
        "time": publish_time,
        "stock_ids": stock_ids,
        "key_word": body.key_word,
        "article_ad_id": None,
        "web_app_dowload_id": None,
        "vip_id": None,
        "status": body.status,
        "is_show_at_web_all_list": True,
        "show_tag": False,
        "img": body.img_path or os.environ.get("NSTOCK_DEFAULT_IMG") or None,
        "content": content_html,
        "not_vip_content": None,
        "count": 1000,
    }

    url = f"{NSTOCK_BASE}{NSTOCK_ARTICLE_PATH}"
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            resp = await client.post(url, json=payload, headers=headers, cookies=cookies)
    except Exception as e:
        raise HTTPException(502, f"連線 nStock 失敗：{e}")

    if resp.status_code in (401, 419):
        # Cookie 失效 → 自動重登一次再試
        if os.environ.get("NSTOCK_ADMIN_EMAIL") and os.environ.get("NSTOCK_ADMIN_PASS"):
            try:
                headers, cookies = _nstock_auth(force_refresh=True)
                async with httpx.AsyncClient(timeout=30, follow_redirects=False) as retry_client:
                    resp = await retry_client.post(url, json=payload, headers=headers, cookies=cookies)
                if resp.status_code not in (401, 419):
                    pass  # 繼續往下處理
                else:
                    raise HTTPException(401, "nStock 自動重新登入後仍失敗，請確認帳密正確")
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(401, f"nStock 自動重新登入失敗：{e}")
        else:
            raise HTTPException(401, "nStock cookie / CSRF 已失效，請在 .env 設定 NSTOCK_ADMIN_EMAIL + NSTOCK_ADMIN_PASS 改用自動登入")
    if resp.status_code in (302, 401, 403) or resp.status_code >= 400:
        try:
            err = resp.json()
        except Exception:
            err = resp.text[:500]
        raise HTTPException(502, f"nStock 發布失敗 ({resp.status_code})：{err}")

    try:
        data = resp.json()
    except Exception:
        data = {"raw": resp.text[:500]}

    def _extract_id(d) -> Optional[int]:
        if not isinstance(d, dict):
            return None
        for k in ("id", "article_id"):
            v = d.get(k)
            if isinstance(v, int):
                return v
            if isinstance(v, str) and v.isdigit():
                return int(v)
        for nested_key in ("data", "result", "article"):
            nested = d.get(nested_key)
            if isinstance(nested, dict):
                got = _extract_id(nested)
                if got:
                    return got
        return None

    article_id = _extract_id(data)

    # POST 回傳常常只有 {code, msg} 沒給 id；fallback 查列表抓剛發那篇
    if not article_id:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                lr = await client.get(
                    f"{NSTOCK_BASE}{NSTOCK_ARTICLE_PATH}",
                    params={"get_data": "true", "page": 1, "per_page": 5},
                    headers=headers, cookies=cookies,
                )
            rows = ((lr.json() or {}).get("data") or {}).get("data") or []
            for row in rows:
                if row.get("title") == body.title:
                    article_id = row.get("id")
                    break
        except Exception:
            pass

    return {
        "success": True,
        "status_code": resp.status_code,
        "article_id": article_id,
        "edit_url": f"{NSTOCK_BASE}/admin#/article/{article_id}/edit" if article_id else None,
        "stock_ids": stock_ids,   # 實際送出的（含自動掃描結果）
        "raw": data,
    }


@router.get("/nstock/check")
def check_nstock_auth(_: None = Depends(require_admin)):
    """檢查 nStock cookie 是否設定（不驗活性，僅看 env）"""
    raw = os.environ.get("NSTOCK_COOKIE", "").strip()
    if not raw:
        return {"configured": False, "missing": ["NSTOCK_COOKIE"]}
    cookies = _parse_cookie_string(raw)
    needed = ["XSRF-TOKEN", "laravel_session"]
    missing = [k for k in needed if k not in cookies]
    return {
        "configured": not missing,
        "missing": missing,
        "author_id": os.environ.get("NSTOCK_AUTHOR_ID"),
        "author_name": os.environ.get("NSTOCK_AUTHOR_NAME"),
    }


@router.post("/facebook")
async def publish_facebook(body: FacebookPublishRequest, _: None = Depends(require_admin)):
    """直接發文到 FB 粉專（給 PublishSection 使用）。

    - text 中的 markdown 粗體 ** 會被剝掉（FB 不渲染）
    - link 帶上時 FB 會抓 og: 標籤產 link card
    """
    text = _strip_markdown_bold(body.text)
    result = await _fb_publish_text(text, link=body.link, picture=body.picture)
    post_id = result.get("id")
    return {
        "success": bool(post_id),
        "post_id": post_id,
        "url": f"https://www.facebook.com/{post_id}" if post_id else None,
        "raw": result,
    }


@router.get("/facebook/check")
def check_facebook_auth(_: None = Depends(require_admin)):
    """檢查 FB Page token 是否設定（不驗活性，僅看 env）"""
    page_id = os.environ.get("FB_PAGE_ID", "").strip()
    token = os.environ.get("FB_PAGE_ACCESS_TOKEN", "").strip()
    missing = []
    if not page_id: missing.append("FB_PAGE_ID")
    if not token: missing.append("FB_PAGE_ACCESS_TOKEN")
    return {
        "configured": not missing,
        "missing": missing,
        "page_id": page_id or None,
    }


# ────────────────────────────────────────────────────────────
# 每日 00981A × 投顧報告 自動草稿
# ────────────────────────────────────────────────────────────

class DailyEditRequest(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None


def _serialize_daily(a: DailyArticle, *, include_content: bool = False) -> dict:
    out = {
        "id": a.id,
        "date": a.date,
        "topic_stock_code": a.topic_stock_code,
        "topic_stock_name": a.topic_stock_name,
        "title": a.title,
        "generated_at": a.generated_at,
        "published_at": a.published_at,
        "nstock_article_id": a.nstock_article_id,
        "edit_url": (
            f"{NSTOCK_BASE}/admin#/article/{a.nstock_article_id}/edit"
            if a.nstock_article_id else None
        ),
        "threads_post_id": a.threads_post_id,
        "threads_posted_at": a.threads_posted_at,
        "fb_post_id": a.fb_post_id,
        "fb_posted_at": a.fb_posted_at,
        "fb_url": (
            f"https://www.facebook.com/{a.fb_post_id}" if a.fb_post_id else None
        ),
    }
    if include_content:
        out["content"] = a.content
        # 從 raw_context 提取可比對的資料來源連結
        if a.raw_context:
            try:
                import json as _json
                ctx = _json.loads(a.raw_context)
                code = ctx.get("topic", {}).get("code", "")
                etf_url = ctx.get("etf", {}).get("source_url", "")
                links = []
                if code:
                    links.append({"label": f"{code} 個股行情", "url": f"https://www.nstock.tw/stock_info?stock_id={code}"})
                    links.append({"label": f"{code} 法人籌碼", "url": f"https://www.nstock.tw/institutional_investors?stock_id={code}"})
                    links.append({"label": f"{code} 月營收", "url": f"https://www.nstock.tw/monthly_revenue?stock_id={code}"})
                if etf_url:
                    links.append({"label": "00981A ETF 操作明細", "url": etf_url})
                out["source_links"] = links
            except Exception:
                out["source_links"] = []
        else:
            out["source_links"] = []
    else:
        out["preview"] = (a.content or "")[:200]
    return out


def _strip_markdown_bold(text: str) -> str:
    """純文字平台不吃 markdown，把 **xxx** 變回 xxx；其他原文保留。"""
    return _MD_BOLD_RE.sub(r"\1", text)


# Threads 沿用舊命名
_strip_markdown_for_threads = _strip_markdown_bold


def _extract_fb_summary(content: str, max_chars: int = 400) -> str:
    """抽 FB teaser：第一段（剝粗體後）。
    第一段太短 (<150) 時補第二段。超過 max_chars 截到最後一個句末標點。
    """
    plain = _strip_markdown_bold(content).strip()
    paras = re.split(r"\n{2,}", plain)
    if not paras:
        return ""
    out = paras[0].strip()
    if len(out) < 150 and len(paras) > 1:
        out = f"{out}\n\n{paras[1].strip()}"
    if len(out) > max_chars:
        cut = out[:max_chars]
        for sep in ["。", "！", "？", ".", "!", "?"]:
            idx = cut.rfind(sep)
            if idx > max_chars * 0.5:
                cut = cut[:idx + 1]
                break
        out = cut.rstrip() + "…"
    return out


@router.get("/daily")
def list_daily(
    limit: int = 30,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    rows = (
        db.query(DailyArticle)
        .order_by(DailyArticle.date.desc())
        .limit(limit).all()
    )
    return [_serialize_daily(r) for r in rows]


@router.get("/daily/{article_id}")
def get_daily(
    article_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    a = db.get(DailyArticle, article_id)
    if not a:
        raise HTTPException(404, "找不到草稿")
    return _serialize_daily(a, include_content=True)


@router.post("/daily/refresh")
async def refresh_daily(
    date: Optional[str] = None,
    force: bool = True,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """手動觸發指定日期的草稿生成；不帶 date 預設今日（Asia/Taipei）。"""
    from daily_article import generate_for_date, _today_tpe
    target = (
        datetime.strptime(date, "%Y-%m-%d").date() if date else _today_tpe()
    )
    aid = await asyncio.to_thread(generate_for_date, target, force=force)
    if not aid:
        raise HTTPException(
            404,
            "今日無素材：ETF小百科尚未發文，或 active 個股皆無投顧報告"
        )
    a = db.get(DailyArticle, aid)
    return _serialize_daily(a, include_content=True)


@router.patch("/daily/{article_id}")
def edit_daily(
    article_id: int,
    body: DailyEditRequest,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    a = db.get(DailyArticle, article_id)
    if not a:
        raise HTTPException(404, "找不到草稿")
    if body.title is not None:
        a.title = body.title
    if body.content is not None:
        a.content = body.content
    db.commit()
    db.refresh(a)
    return _serialize_daily(a, include_content=True)


@router.post("/daily/{article_id}/publish-nstock")
async def publish_daily_to_nstock(
    article_id: int,
    live: bool = False,    # False=送 nStock 後台存草稿不上架；True=直接上架
    img_path: Optional[str] = None,   # 封面圖片路徑（覆蓋 NSTOCK_DEFAULT_IMG）
    auth_name: Optional[str] = None,  # 作者名稱（覆蓋 NSTOCK_AUTHOR_NAME）
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """把每日草稿送到 nStock 後台（用既有 publish_nstock 邏輯）。

    預設 live=False（後台存草稿，不上架）。
    """
    a = db.get(DailyArticle, article_id)
    if not a:
        raise HTTPException(404, "找不到草稿")
    # 以 topic_stock_code 為基礎，publish_nstock 還會再從內文掃更多股號
    body = NStockPublishRequest(
        title=a.title,
        content=a.content,
        is_html=False,
        status=live,
        img_path=img_path or None,
        auth_name=auth_name or None,
        stock_ids=a.topic_stock_code or None,
    )
    result = await publish_nstock(body, _)  # 重用既有 endpoint
    if result.get("article_id"):
        a.nstock_article_id = result["article_id"]
        a.published_at = datetime.utcnow()
        db.commit()
    return result


@router.post("/daily/{article_id}/publish-threads")
async def publish_daily_to_threads(
    article_id: int,
    topic_tag: Optional[str] = None,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """把每日草稿發到 Threads（自動切段成留言鏈）。Markdown 粗體會被剝掉。"""
    a = db.get(DailyArticle, article_id)
    if not a:
        raise HTTPException(404, "找不到草稿")
    plain = _strip_markdown_bold(a.content)
    # 標題若希望出現在第一段，可直接拼前綴
    full_text = f"{a.title}\n\n{plain}"
    body = PublishRequest(text=full_text, topic_tag=topic_tag)
    result = await publish_threads(body, _)
    if result.get("post_id"):
        a.threads_post_id = result["post_id"]
        a.threads_posted_at = datetime.utcnow()
        db.commit()
    return result


# ────────────────────────────────────────────────────────────
# Facebook Pages 發文
# ────────────────────────────────────────────────────────────

FB_GRAPH_BASE = "https://graph.facebook.com/v18.0"


async def _fb_publish_text(text: str, link: Optional[str] = None, picture: Optional[str] = None) -> dict:
    """用 Page token 發文到 FB Page。回傳 {id: 'PAGE_POST'}。"""
    page_id = os.environ.get("FB_PAGE_ID", "").strip()
    token = os.environ.get("FB_PAGE_ACCESS_TOKEN", "").strip()
    if not page_id or not token:
        raise HTTPException(
            503, "尚未設定 FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN，請在 .env 填入後重啟"
        )
    params = {"message": text, "access_token": token}
    if link:
        params["link"] = link  # FB 會自動抓 og: 標籤產 link card
    if picture:
        params["picture"] = picture  # 覆蓋 og:image，指定縮圖
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(f"{FB_GRAPH_BASE}/{page_id}/feed", data=params)
    if r.status_code != 200:
        try:
            err = r.json()
        except Exception:
            err = r.text[:500]
        raise HTTPException(502, f"FB Graph API 錯誤：{err}")
    return r.json()


@router.post("/daily/{article_id}/publish-facebook")
async def publish_daily_to_facebook(
    article_id: int,
    summary_only: bool = True,        # True=只發標題+第一段+link card；False=整篇 + link
    with_nstock_link: bool = True,    # 已發過 nStock 時自動帶連結（生 link card）
    picture: Optional[str] = None,    # 覆蓋縮圖 URL
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """把每日草稿發到 Facebook 粉專。

    - 預設「摘要模式」：標題 + 第一段 teaser + nStock link card（FB 演算法偏好短文 + 強連結）
    - summary_only=False 改發整篇純文字 + link card（適合長文型實驗）
    - Markdown 粗體 ** 一律剝掉
    """
    a = db.get(DailyArticle, article_id)
    if not a:
        raise HTTPException(404, "找不到草稿")

    if summary_only:
        teaser = _extract_fb_summary(a.content)
        text = f"{a.title}\n\n{teaser}" if teaser else a.title
    else:
        text = f"{a.title}\n\n{_strip_markdown_bold(a.content)}"

    link = None
    if with_nstock_link and a.nstock_article_id:
        # nStock 公開文章 URL pattern（用 nstock.tw 主站不是 admin）
        link = f"https://www.nstock.tw/author/article?id={a.nstock_article_id}"

    result = await _fb_publish_text(text, link=link, picture=picture or None)
    post_id = result.get("id")
    if post_id:
        a.fb_post_id = post_id
        a.fb_posted_at = datetime.utcnow()
        db.commit()
    return {
        "success": bool(post_id),
        "post_id": post_id,
        "url": f"https://www.facebook.com/{post_id}" if post_id else None,
        "link_card": link,
        "raw": result,
    }

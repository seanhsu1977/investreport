from __future__ import annotations
import base64
import json
import os
import pdfplumber
from io import BytesIO
import time
import anthropic
from PIL import Image


def _get_client() -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))


def _generate_with_retry(client: anthropic.Anthropic, model: str, system: str, messages: list, max_tokens: int = 1024, max_retries: int = 3):
    for attempt in range(max_retries):
        try:
            return client.messages.create(
                model=model,
                system=system,
                messages=messages,
                max_tokens=max_tokens,
            )
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            msg = str(e)
            if "529" in msg or "429" in msg or "overloaded" in msg.lower() or "rate_limit" in msg.lower():
                wait = 2 ** attempt * 3  # 3s, 6s, 12s
                time.sleep(wait)
            else:
                raise


MODEL = "claude-haiku-4-5"

# Anthropic Messages API 圖片限制：base64 編碼後 ≤ 10MB、單邊像素 ≤ 8000px
# （官方建議長邊 ≤1568px 兼顧辨識品質與 token 花費）。超過會直接 400，
# 且原始檔案永遠不會被標記為已處理，之後每次同步都會重新踩到同一個錯誤。
_MAX_IMAGE_B64_BYTES = 10 * 1024 * 1024
_MAX_IMAGE_DIMENSION = 1568

SYSTEM_PROMPT = """你是一位專業的投資報告分析師。
請從投資研究報告或財經新聞中提取結構化資訊，並以 JSON 格式回傳。
只回傳 JSON，不要包含其他說明文字。"""

_SCHEMA = """{
  "stock_code": "股票代碼（如 2330 或 AAPL，若為大盤/總經/新聞類報告則為 null）",
  "stock_name": "公司名稱（若為大盤報告則為 null）",
  "recommendation": "投資建議（買進/中立/賣出，若無明確建議則為 null）",
  "target_price": 目標價格（數字，若無則為 null）,
  "analyst": "分析師或記者姓名（若無則為 null）",
  "report_date": "報告或新聞日期（YYYY-MM-DD 格式，若無則為 null）",
  "summary": "報告或新聞摘要（100-200 字，繁體中文）",
  "key_points": ["重點1", "重點2", "重點3"],
  "mentioned_stocks": ["2330 台積電", "2454 聯發科"]
}"""

EXTRACT_PROMPT_TEXT = """請從以下投資報告或財經新聞中提取資訊，回傳 JSON 格式。
{filename_hint}

{schema}

注意：mentioned_stocks 只在 stock_code 為 null 時填入，格式為「代碼 公司名稱」（如 "2330 台積電"），若只知道公司名稱無代碼則只填名稱。若為個股報告則填空陣列。

報告內容：
{text}"""

EXTRACT_PROMPT_IMAGE = """請從這份投資報告或財經新聞圖片中提取資訊，回傳 JSON 格式。
{filename_hint}

{schema}

注意：mentioned_stocks 只在 stock_code 為 null 時填入，格式為「代碼 公司名稱」（如 "2330 台積電"），若只知道公司名稱無代碼則只填名稱。若為個股報告則填空陣列。"""


def extract_text_from_pdf(pdf_bytes: bytes, max_pages: int = 20, skip_pages: int = 0) -> tuple[str, int]:
    """從 PDF 抽取文字，回傳 (text, total_pages)。
    skip_pages: 跳過前幾頁（用於有封面的早報/彙整報告）。
    """
    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        total = len(pdf.pages)
        pages = []
        for page in pdf.pages[skip_pages: skip_pages + max_pages]:
            text = page.extract_text()
            if text:
                pages.append(text)
    return "\n\n".join(pages), total


def pdf_to_images_base64(pdf_bytes: bytes, max_pages: int = 3) -> list[str]:
    try:
        from pdf2image import convert_from_bytes
        images = convert_from_bytes(pdf_bytes, first_page=1, last_page=max_pages, dpi=150)
        result = []
        for img in images:
            # 少數 PDF 頁面尺寸異常大（如非標準版面），dpi=150 轉出來仍可能超過
            # Anthropic 單邊像素上限，這裡先按比例縮到安全範圍再編碼
            if max(img.size) > _MAX_IMAGE_DIMENSION:
                ratio = _MAX_IMAGE_DIMENSION / max(img.size)
                img = img.resize((max(1, int(img.width * ratio)), max(1, int(img.height * ratio))))
            buf = BytesIO()
            img.save(buf, format="JPEG", quality=85)
            result.append(base64.b64encode(buf.getvalue()).decode())
        return result
    except Exception:
        return []


import logging
import re as _re

logger = logging.getLogger(__name__)


def _as_result_dict(parsed) -> dict | None:
    """schema 要求單一物件，但模型遇到一份文件提到多支股票（如早報彙整）時
    有時會不理會 schema、回傳 JSON 陣列。取第一筆可用的物件當主要結果，
    避免呼叫端直接 .get() 炸掉（且該筆永遠不會被標記為已處理、每次同步重踩）。
    """
    if isinstance(parsed, dict):
        return parsed
    if isinstance(parsed, list):
        for item in parsed:
            if isinstance(item, dict):
                return item
    return None


def parse_json_response(raw: str) -> dict | None:
    if not raw:
        return None
    raw = raw.strip()

    # 先試直接解析
    try:
        result = _as_result_dict(json.loads(raw))
        if result is not None:
            return result
    except json.JSONDecodeError:
        pass

    # 去掉 ```json ... ``` 或 ``` ... ``` 圍欄（允許圍欄後有換行或空白）
    fence = _re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    if fence:
        try:
            result = _as_result_dict(json.loads(fence.group(1).strip()))
            if result is not None:
                return result
        except json.JSONDecodeError:
            pass

    # 找第一個 { ... } 物件（貪婪，處理前後有多餘文字的情況）
    obj = _re.search(r"\{[\s\S]*\}", raw)
    if obj:
        try:
            result = _as_result_dict(json.loads(obj.group(0)))
            if result is not None:
                return result
        except json.JSONDecodeError:
            pass

    logger.warning("parse_json_response: 無法解析回應，前100字: %s", raw[:100])
    return None


def build_filename_hint(filename: str | None) -> str:
    if not filename:
        return ""
    return f"檔名（可能含有日期、股票代碼等資訊，請優先參考）：{filename}"


def _shrink_image_if_needed(image_bytes: bytes, media_type: str) -> tuple[bytes, str]:
    """base64 編碼後超過 Anthropic 10MB 上限，或單邊像素超過長邊上限時，
    縮小尺寸/畫質重新編碼成 JPEG。"""
    try:
        img = Image.open(BytesIO(image_bytes))
        too_big_dim = max(img.size) > _MAX_IMAGE_DIMENSION
    except Exception as e:
        if len(base64.b64encode(image_bytes)) <= _MAX_IMAGE_B64_BYTES:
            return image_bytes, media_type
        logger.warning("圖片縮圖失敗，原樣送出：%s", e)
        return image_bytes, media_type

    if not too_big_dim and len(base64.b64encode(image_bytes)) <= _MAX_IMAGE_B64_BYTES:
        return image_bytes, media_type

    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    if too_big_dim:
        ratio = _MAX_IMAGE_DIMENSION / max(img.size)
        img = img.resize((max(1, int(img.width * ratio)), max(1, int(img.height * ratio))))

    quality = 85
    scale = 1.0
    data = image_bytes
    for _ in range(6):
        w, h = img.size
        resized = img.resize((max(1, int(w * scale)), max(1, int(h * scale)))) if scale < 1.0 else img
        buf = BytesIO()
        resized.save(buf, format="JPEG", quality=quality)
        data = buf.getvalue()
        if len(base64.b64encode(data)) <= _MAX_IMAGE_B64_BYTES:
            return data, "image/jpeg"
        quality = quality - 15 if quality > 50 else quality
        if quality <= 50:
            scale *= 0.7
    return data, "image/jpeg"  # 盡力而為，回傳最後一次嘗試的結果（仍可能略超，交給 API 判斷）


def analyze_image_file(image_bytes: bytes, media_type: str, filename: str | None = None) -> dict | None:
    image_bytes, media_type = _shrink_image_if_needed(image_bytes, media_type)
    filename_hint = build_filename_hint(filename)
    client = _get_client()
    prompt = EXTRACT_PROMPT_IMAGE.format(filename_hint=filename_hint, schema=_SCHEMA)
    img_b64 = base64.b64encode(image_bytes).decode()
    response = _generate_with_retry(
        client, MODEL,
        system=SYSTEM_PROMPT,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": img_b64,
                    },
                },
                {"type": "text", "text": prompt},
            ],
        }],
    )
    return parse_json_response(response.content[0].text)


def analyze_report(pdf_bytes: bytes, filename: str | None = None) -> dict | None:
    filename_hint = build_filename_hint(filename)
    client = _get_client()

    # 大型 PDF（報紙/早報）只讀前 5 頁避免浪費；一般報告讀前 20 頁
    # 先嘗試取 total_pages 判斷是否為超大 PDF
    # pdfplumber 遇到少數格式異常/損毀的 PDF（如不支援的 stream filter）會直接拋例外，
    # 若讓它往上炸，這個檔案會永遠不被標記為已處理、每次同步都重踩同一個錯誤——
    # 這裡當作「沒有文字」處理，往下走圖片版掃描的 Vision 分支。
    try:
        text, total_pages = extract_text_from_pdf(pdf_bytes, max_pages=20)
    except Exception as e:
        logger.warning("[%s] extract_text_from_pdf failed (%s), fallback to Vision", filename, e)
        text, total_pages = "", 0

    if text.strip():
        # 大型 PDF（早報/報紙/晨會彙整，> 10 頁）：有封面，跳過第 1 頁，取第 2-6 頁
        # 個股投顧報告（≤ 10 頁）：沒有封面，第 1 頁就是評等/目標價，字數上限拉高到 12000
        if total_pages > 10:
            try:
                text_short, _ = extract_text_from_pdf(pdf_bytes, max_pages=5, skip_pages=1)
                text_to_send = text_short[:10000]
            except Exception as e:
                logger.warning("[%s] second-pass extract_text_from_pdf failed (%s), reuse first pass", filename, e)
                text_to_send = text[:10000]
        else:
            text_to_send = text[:12000]

        prompt = EXTRACT_PROMPT_TEXT.format(
            filename_hint=filename_hint,
            schema=_SCHEMA,
            text=text_to_send,
        )
        response = _generate_with_retry(
            client, MODEL,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
        result = parse_json_response(response.content[0].text)
        if result is None:
            logger.warning("[%s] text-path parse failed (pages=%d). raw[:120]: %s",
                           filename, total_pages, response.content[0].text[:120])
        return result

    else:
        # 掃描圖片型 PDF → Claude Vision（最多 3 頁）
        images_b64 = pdf_to_images_base64(pdf_bytes, max_pages=3)
        if not images_b64:
            logger.warning("[%s] no text and pdf_to_images returned empty — skipping", filename)
            return None

        content: list = []
        for img_b64 in images_b64:
            content.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": img_b64,
                },
            })
        content.append({
            "type": "text",
            "text": EXTRACT_PROMPT_IMAGE.format(filename_hint=filename_hint, schema=_SCHEMA),
        })

        response = _generate_with_retry(
            client, MODEL,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": content}],
        )
        return parse_json_response(response.content[0].text)

from __future__ import annotations
import base64
import json
import os
import pdfplumber
from io import BytesIO
import time
from google import genai
from google.genai import types


def _get_client() -> genai.Client:
    return genai.Client(api_key=os.getenv("GEMINI_API_KEY"))


def _generate_with_retry(client: genai.Client, model: str, contents, config, max_retries: int = 3):
    for attempt in range(max_retries):
        try:
            return client.models.generate_content(model=model, contents=contents, config=config)
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            msg = str(e)
            if "503" in msg or "429" in msg or "UNAVAILABLE" in msg or "quota" in msg.lower():
                wait = 2 ** attempt * 3  # 3s, 6s, 12s
                time.sleep(wait)
            else:
                raise


MODEL = "gemini-2.5-flash"

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

注意：mentioned_stocks 只在 stock_code 為 null 時填入，格式為「代碼 公司名稱」（如 "2330 台積電"），若只知道公司名稱無代碼則只填名稱。"""


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
            buf = BytesIO()
            img.save(buf, format="JPEG", quality=85)
            result.append(base64.b64encode(buf.getvalue()).decode())
        return result
    except Exception:
        return []


import logging
import re as _re

logger = logging.getLogger(__name__)


def parse_json_response(raw: str) -> dict | None:
    if not raw:
        return None
    raw = raw.strip()

    # 先試直接解析
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # 去掉 ```json ... ``` 或 ``` ... ``` 圍欄（允許圍欄後有換行或空白）
    fence = _re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    if fence:
        try:
            return json.loads(fence.group(1).strip())
        except json.JSONDecodeError:
            pass

    # 找第一個 { ... } 物件（貪婪，處理前後有多餘文字的情況）
    obj = _re.search(r"\{[\s\S]*\}", raw)
    if obj:
        try:
            return json.loads(obj.group(0))
        except json.JSONDecodeError:
            pass

    logger.warning("parse_json_response: 無法解析 Gemini 回應，前100字: %s", raw[:100])
    return None


def build_filename_hint(filename: str | None) -> str:
    if not filename:
        return ""
    return f"檔名（可能含有日期、股票代碼等資訊，請優先參考）：{filename}"


def analyze_image_file(image_bytes: bytes, media_type: str, filename: str | None = None) -> dict | None:
    filename_hint = build_filename_hint(filename)
    client = _get_client()
    prompt = EXTRACT_PROMPT_IMAGE.format(filename_hint=filename_hint, schema=_SCHEMA)
    response = _generate_with_retry(
        client, MODEL,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type=media_type),
            prompt,
        ],
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            max_output_tokens=1024,
        ),
    )
    return parse_json_response(response.text)


def analyze_report(pdf_bytes: bytes, filename: str | None = None) -> dict | None:
    filename_hint = build_filename_hint(filename)
    client = _get_client()

    # 大型 PDF（報紙/早報）只讀前 5 頁避免浪費；一般報告讀前 20 頁
    # 先嘗試取 total_pages 判斷是否為超大 PDF
    text, total_pages = extract_text_from_pdf(pdf_bytes, max_pages=20)

    if text.strip():
        # 大型 PDF（早報/報紙/晨會彙整，> 10 頁）：有封面，跳過第 1 頁，取第 2-6 頁
        # 個股投顧報告（≤ 10 頁）：沒有封面，第 1 頁就是評等/目標價，字數上限拉高到 12000
        if total_pages > 10:
            text_short, _ = extract_text_from_pdf(pdf_bytes, max_pages=5, skip_pages=1)
            text_to_send = text_short[:10000]
        else:
            text_to_send = text[:12000]

        prompt = EXTRACT_PROMPT_TEXT.format(
            filename_hint=filename_hint,
            schema=_SCHEMA,
            text=text_to_send,
        )
        response = _generate_with_retry(
            client, MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                max_output_tokens=1024,
            ),
        )
        result = parse_json_response(response.text)
        if result is None:
            logger.warning("[%s] text-path parse failed (pages=%d). raw[:120]: %s",
                           filename, total_pages, response.text[:120])
        return result

    else:
        # 掃描圖片型 PDF → Gemini Vision（最多 3 頁）
        images_b64 = pdf_to_images_base64(pdf_bytes, max_pages=3)
        if not images_b64:
            logger.warning("[%s] no text and pdf_to_images returned empty — skipping", filename)
            return None

        parts: list = []
        for img_b64 in images_b64:
            img_bytes = base64.b64decode(img_b64)
            parts.append(types.Part.from_bytes(data=img_bytes, mime_type="image/jpeg"))
        parts.append(EXTRACT_PROMPT_IMAGE.format(filename_hint=filename_hint, schema=_SCHEMA))

        response = _generate_with_retry(
            client, MODEL,
            contents=parts,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                max_output_tokens=1024,
            ),
        )
        return parse_json_response(response.text)

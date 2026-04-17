from __future__ import annotations
import base64
import json
import os
import pdfplumber
import anthropic
from io import BytesIO


client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

SYSTEM_PROMPT = """你是一位專業的投資報告分析師。
請從投資研究報告或財經新聞中提取結構化資訊，並以 JSON 格式回傳。
只回傳 JSON，不要包含其他說明文字。"""

EXTRACT_PROMPT_TEXT = """請從以下投資報告或財經新聞中提取資訊，回傳 JSON 格式。
{filename_hint}


{{
  "stock_code": "股票代碼（如 2330 或 AAPL，若為大盤/總經/新聞類報告則為 null）",
  "stock_name": "公司名稱（若為大盤報告則為 null）",
  "recommendation": "投資建議（買進/中立/賣出，若無明確建議則為 null）",
  "target_price": 目標價格（數字，若無則為 null）,
  "analyst": "分析師或記者姓名（若無則為 null）",
  "report_date": "報告或新聞日期（YYYY-MM-DD 格式，若無則為 null）",
  "summary": "報告或新聞摘要（100-200 字，繁體中文）",
  "key_points": ["重點1", "重點2", "重點3"],
  "mentioned_stocks": ["2330 台積電", "2454 聯發科"]
}}

注意：mentioned_stocks 只在 stock_code 為 null 時填入，格式為「代碼 公司名稱」（如 "2330 台積電"），若只知道公司名稱無代碼則只填名稱。若為個股報告則填空陣列。

報告內容：
{text}"""

EXTRACT_PROMPT_IMAGE = """請從這份投資報告或財經新聞圖片中提取資訊，回傳 JSON 格式。
{filename_hint}


{{
  "stock_code": "股票代碼（如 2330 或 AAPL，若為大盤/總經/新聞類報告則為 null）",
  "stock_name": "公司名稱（若為大盤報告則為 null）",
  "recommendation": "投資建議（買進/中立/賣出，若無明確建議則為 null）",
  "target_price": 目標價格（數字，若無則為 null）,
  "analyst": "分析師或記者姓名（若無則為 null）",
  "report_date": "報告或新聞日期（YYYY-MM-DD 格式，若無則為 null）",
  "summary": "報告或新聞重點摘要（100-200 字，繁體中文）",
  "key_points": ["重點1", "重點2", "重點3"],
  "mentioned_stocks": ["2330 台積電", "2454 聯發科"]
}}

注意：mentioned_stocks 只在 stock_code 為 null 時填入，格式為「代碼 公司名稱」（如 "2330 台積電"），若只知道公司名稱無代碼則只填名稱。"""


def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        pages = []
        for page in pdf.pages[:20]:
            text = page.extract_text()
            if text:
                pages.append(text)
    return "\n\n".join(pages)


def pdf_to_images_base64(pdf_bytes: bytes, max_pages: int = 3) -> list[str]:
    """將 PDF 前幾頁轉成 base64 圖片"""
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


def parse_json_response(raw: str) -> dict | None:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def build_filename_hint(filename: str | None) -> str:
    if not filename:
        return ""
    return f"檔名（可能含有日期、股票代碼等資訊，請優先參考）：{filename}"


def analyze_image_file(image_bytes: bytes, media_type: str, filename: str | None = None) -> dict | None:
    """直接分析圖片檔（JPG / PNG / WebP / GIF）"""
    filename_hint = build_filename_hint(filename)
    img_b64 = base64.b64encode(image_bytes).decode()
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": img_b64}},
            {"type": "text", "text": EXTRACT_PROMPT_IMAGE.format(filename_hint=filename_hint)},
        ]}],
    )
    return parse_json_response(message.content[0].text)


def analyze_report(pdf_bytes: bytes, filename: str | None = None) -> dict | None:
    filename_hint = build_filename_hint(filename)

    # 先嘗試文字提取
    text = extract_text_from_pdf(pdf_bytes)

    if text.strip():
        # 文字型 PDF
        message = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[{
                "role": "user",
                "content": EXTRACT_PROMPT_TEXT.format(
                    filename_hint=filename_hint,
                    text=text[:8000],
                )
            }],
        )
        return parse_json_response(message.content[0].text)

    else:
        # 掃描圖片型 PDF → 用 Claude Vision
        images = pdf_to_images_base64(pdf_bytes, max_pages=3)
        if not images:
            return None

        content = []
        for img_b64 in images:
            content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg", "data": img_b64}
            })
        content.append({
            "type": "text",
            "text": EXTRACT_PROMPT_IMAGE.format(filename_hint=filename_hint),
        })

        message = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": content}],
        )
        return parse_json_response(message.content[0].text)

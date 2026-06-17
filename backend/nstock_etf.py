"""爬 nStock 名師專欄每日 ETF 操作明細。

目前支援：
  - 00981A：作者 id=60（ETF小百科）
  - 00403A：作者 id=1991

標題 pattern：`YYYY/MM/DD {ETF_CODE} 今日操作明細 成份股持股明細`

Pipeline:
  1. find_article_id_for_date(today, etf_code, author_id)  → 從作者頁找今日 article id
  2. parse_etf_article(id)                                  → 解析持股明細表
"""
from __future__ import annotations
import logging
import re
from typing import Optional
import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

NSTOCK_BASE = "https://www.nstock.tw"
DEFAULT_AUTHOR_ID = 60   # ETF小百科 (00981A)
TARGET_ETF = "00981A"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


def _get(url: str, timeout: float = 10.0) -> str:
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html"}
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        r = client.get(url, headers=headers)
        r.raise_for_status()
        return r.text


def find_article_id_for_date(
    date_str: str,
    author_id: int = DEFAULT_AUTHOR_ID,
    etf_code: str = TARGET_ETF,
) -> Optional[int]:
    """從作者頁找標題符合 `{date_str} {etf_code}` 的文章 id。

    Args:
        date_str: 「YYYY/MM/DD」格式（注意是斜線，跟標題一致）
    """
    html = _get(f"{NSTOCK_BASE}/author/info?id={author_id}")
    soup = BeautifulSoup(html, "html.parser")
    title_prefix = f"{date_str} {etf_code}"
    for a in soup.select('a[href^="/author/article?id="]'):
        title = a.get_text(strip=True)
        if not title.startswith(title_prefix):
            continue
        m = re.search(r"id=(\d+)", a.get("href", ""))
        if m:
            return int(m.group(1))
    return None


def parse_etf_article(article_id: int) -> dict:
    """抓 article HTML，解析「成份股持股明細」表，回傳：
    {
      "article_id": 1890,
      "date": "2026/04/29",
      "title": "...",
      "stocks": [
        {"code": "3665", "name": "貿聯-KY", "price": 2780.0, "change_pct": 5.7,
         "volume": 2716, "action": "buy"|"sell"|"flat", "shares": 206},
        ...
      ],
    }
    """
    html = _get(f"{NSTOCK_BASE}/author/article?id={article_id}")
    soup = BeautifulSoup(html, "html.parser")

    title_tag = soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else ""
    title = title.replace(" - nStock 名師專欄文章", "")
    date_match = re.match(r"(\d{4}/\d{2}/\d{2})", title)
    date = date_match.group(1) if date_match else ""

    stocks: list[dict] = []
    seen_codes: set[str] = set()
    for a in soup.select('a[href^="/stock_info?stock_id="]'):
        code_m = re.search(r"stock_id=(\d+)", a.get("href", ""))
        if not code_m:
            continue
        code = code_m.group(1)
        text = a.get_text(strip=True)
        if text == code or code in seen_codes:
            continue   # 跳過第二個（純數字）連結 / 已見過的代號
        row = a.find_parent("div", class_=re.compile(r"grid-cols-4"))
        if not row:
            continue
        cells = row.find_all("div", recursive=False, class_=re.compile(r"col-span-1"))
        if len(cells) != 4:
            continue

        # cell 2: 收盤價 + 漲跌幅 (兩個 div)
        # nstock 的百分比文字本身已含正負號（如 "-0.39"、"+5.37"），直接 parse 即可。
        # 早期用 color_sign 推斷方向，但 (-0.39%) strip 後是 "-0.39"，再乘 color_sign(-1) 會反號。
        price_divs = cells[1].find_all("div")
        price_text = price_divs[0].get_text(strip=True) if price_divs else ""
        pct_text = price_divs[1].get_text(strip=True).strip("()%") if len(price_divs) > 1 else ""

        # cell 3: 成交量
        volume_text = cells[2].get_text(strip=True).replace(",", "")
        # cell 4: 持股變化（"+206" / "-50" / "持平"）
        holding_text = cells[3].get_text(strip=True)

        if holding_text == "持平":
            action, shares = "flat", 0
        else:
            hm = re.match(r"([+-]?)(\d+)", holding_text)
            if hm:
                shares = int(hm.group(2))
                action = "sell" if hm.group(1) == "-" else "buy"
            else:
                continue

        try:
            price = float(price_text) if price_text else None
        except ValueError:
            price = None
        try:
            change_pct = float(pct_text) if pct_text else None
        except ValueError:
            change_pct = None
        volume = int(volume_text) if volume_text.isdigit() else None

        stocks.append({
            "code": code, "name": text,
            "price": price, "change_pct": change_pct, "volume": volume,
            "action": action, "shares": shares,
        })
        seen_codes.add(code)

    return {
        "article_id": article_id,
        "date": date,
        "title": title,
        "source_url": f"{NSTOCK_BASE}/author/article?id={article_id}",
        "stocks": stocks,
    }


def fetch_today(
    date_str: str,
    etf_code: str = TARGET_ETF,
    author_id: int = DEFAULT_AUTHOR_ID,
) -> Optional[dict]:
    """便利函數：找今日 article + 解析。date_str 用「YYYY/MM/DD」。"""
    article_id = find_article_id_for_date(date_str, author_id=author_id, etf_code=etf_code)
    if not article_id:
        logger.info("nstock author=%d %s %s 尚未發文", author_id, etf_code, date_str)
        return None
    return parse_etf_article(article_id)


if __name__ == "__main__":
    import json, sys
    date_str = sys.argv[1] if len(sys.argv) > 1 else "2026/04/29"
    article_id = find_article_id_for_date(date_str)
    print(f"[{date_str}] article_id = {article_id}")
    if article_id:
        data = parse_etf_article(article_id)
        active = [s for s in data["stocks"] if s["action"] != "flat"]
        print(f"  total stocks: {len(data['stocks'])}, active: {len(active)}")
        for s in active:
            sign = "+" if s["action"] == "buy" else "-"
            print(f"    {sign}{s['shares']:>5}張  {s['code']:6} {s['name']:10} {s['price']} ({s['change_pct']:+.1f}%)")

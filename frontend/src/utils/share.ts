import type { Report } from "../api/client";

/** 將報告格式化成可分享的純文字 */
export function buildShareText(r: Report & { mentioned_stocks?: string[] }): string {
  const lines: string[] = [];

  if (r.stock_code === "MARKET") {
    lines.push(`【市場新聞】${r.analyst ?? ""}`.trim());
  } else {
    const title = `【${r.stock_code}${r.stock_name ? " " + r.stock_name : ""}】`;
    const rec = r.recommendation ? ` ${r.recommendation}` : "";
    const price = r.target_price ? ` 目標價 ${r.target_price}` : "";
    lines.push(title + rec + price);
  }

  const date = (r.report_date ?? r.created_at)?.slice(0, 10);
  if (date) lines.push(date);

  if (r.summary) lines.push("", r.summary);

  if (r.key_points?.length) {
    lines.push("");
    r.key_points.forEach((pt) => lines.push(`• ${pt}`));
  }

  return lines.join("\n");
}

/** 個股報告的分享連結（導回個股頁） */
export function buildShareUrl(r: Report): string {
  const base = window.location.origin;
  return r.stock_code === "MARKET" ? base : `${base}/stocks/${r.stock_code}`;
}

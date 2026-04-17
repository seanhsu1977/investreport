import { Link } from "react-router-dom";

/**
 * 將文字中出現的股票代號（來自 mentionedStocks）標注為可點擊的藍色連結。
 * mentionedStocks 格式可為純代號「2330」或「2330 台積電」。
 */
export default function StockLinkedText({
  text,
  mentionedStocks,
  linkState,
}: {
  text: string;
  mentionedStocks: string[];
  linkState?: Record<string, string>;
}) {
  // 從 "2330 台積電" 或 "2330" 萃取 4 位代號
  const codes = [
    ...new Set(
      mentionedStocks
        .map((entry) => entry.match(/^(\d{4})/)?.[1])
        .filter((c): c is string => !!c)
    ),
  ];

  if (!codes.length) return <>{text}</>;

  // 由長到短避免部分匹配
  const sorted = [...codes].sort((a, b) => b.length - a.length);
  const regex = new RegExp(
    `(${sorted.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "g"
  );
  const parts = text.split(regex);
  const codeSet = new Set(codes);

  return (
    <>
      {parts.map((part, i) =>
        codeSet.has(part) ? (
          <Link
            key={i}
            to={`/stocks/${part}`}
            state={linkState}
            className="inline-flex items-center px-1 py-0.5 rounded bg-blue-50 text-blue-700 font-mono text-xs font-semibold hover:bg-blue-100 transition"
          >
            {part}
          </Link>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

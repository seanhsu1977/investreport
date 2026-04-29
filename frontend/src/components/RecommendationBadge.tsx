interface Props {
  value: string | null;
  compact?: boolean;
}

// 台股慣例：漲紅跌綠
const styleMap: Record<string, { cls: string; arrow: string; short: string }> = {
  買進: { cls: "bg-red-50 text-red-600 border border-red-200",    arrow: "▲", short: "買" },
  Buy:  { cls: "bg-red-50 text-red-600 border border-red-200",    arrow: "▲", short: "買" },
  中立: { cls: "bg-gray-50 text-gray-500 border border-gray-300", arrow: "◆", short: "中" },
  Hold: { cls: "bg-gray-50 text-gray-500 border border-gray-300", arrow: "◆", short: "中" },
  賣出: { cls: "bg-green-50 text-green-700 border border-green-300", arrow: "▼", short: "賣" },
  Sell: { cls: "bg-green-50 text-green-700 border border-green-300", arrow: "▼", short: "賣" },
};

export default function RecommendationBadge({ value, compact = false }: Props) {
  if (!value) return <span className="text-gray-300 text-xs">—</span>;
  const style = styleMap[value];
  if (!style) {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs font-bold bg-gray-100 text-gray-600 border border-gray-200">
        {value}
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-bold tracking-wide ${style.cls}`}>
      <span className="text-[10px]">{style.arrow}</span>
      {compact ? style.short : value}
    </span>
  );
}

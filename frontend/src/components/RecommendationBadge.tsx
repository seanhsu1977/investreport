interface Props {
  value: string | null;
}

const colorMap: Record<string, string> = {
  買進: "bg-green-100 text-green-800",
  Buy: "bg-green-100 text-green-800",
  中立: "bg-yellow-100 text-yellow-800",
  Hold: "bg-yellow-100 text-yellow-800",
  賣出: "bg-red-100 text-red-800",
  Sell: "bg-red-100 text-red-800",
};

export default function RecommendationBadge({ value }: Props) {
  if (!value) return <span className="text-gray-400 text-sm">—</span>;
  const cls = colorMap[value] ?? "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${cls}`}>
      {value}
    </span>
  );
}

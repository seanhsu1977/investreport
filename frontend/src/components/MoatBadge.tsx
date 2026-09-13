export default function MoatBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return null;
  const cls =
    score >= 70 ? "bg-red-50 text-red-600 border-red-200" :
    score >= 50 ? "bg-orange-50 text-orange-600 border-orange-200" :
    score >= 30 ? "bg-amber-50 text-amber-600 border-amber-200" :
    "bg-emerald-50 text-emerald-700 border-emerald-200";
  return (
    <span
      className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${cls}`}
      title="護城河評分（獲利持續性 + 毛利率趨勢 + 同業相對地位，僅供參考）"
    >
      護城河 {score}
    </span>
  );
}

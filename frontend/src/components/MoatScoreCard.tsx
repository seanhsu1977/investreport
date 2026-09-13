import { useEffect, useState } from "react";
import { stocksApi, type MoatScore } from "../api/client";

function ScoreRing({ score, color, size = 60 }: { score: number | null; color: string; size?: number }) {
  if (score == null) return <div className="text-[11px] text-[#6B7A99]">無資料</div>;
  const r = size * 0.37, circ = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, score)) / 100) * circ;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E8ECF4" strokeWidth="5" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="5"
        strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round" />
      <text x={size / 2} y={size / 2 + 5} textAnchor="middle" className="rotate-90"
        style={{ fontSize: 13, fontWeight: 700, fill: color, transform: `rotate(90deg)`, transformOrigin: `${size / 2}px ${size / 2}px` }}>
        {score}
      </text>
    </svg>
  );
}

export default function MoatScoreCard({ code }: { code: string }) {
  const [data, setData] = useState<MoatScore | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    stocksApi.moat(code)
      .then(setData)
      .catch((e: unknown) => {
        const msg =
          (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
          ?? "載入失敗";
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, [code]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <svg className="w-5 h-5 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a10 10 0 100 10H4z" />
        </svg>
      </div>
    );
  }

  if (error || !data) {
    return <p className="text-sm text-[#6B7A99] text-center py-8">{error ?? "沒有護城河資料"}</p>;
  }

  const overallColor = data.score >= 70 ? "#DC2626" : data.score >= 50 ? "#E95C2E" : data.score >= 30 ? "#D97706" : "#15803D";
  const dims = [
    { key: "profitability", label: "獲利持續性", score: Math.round((data.breakdown.profitability / 40) * 100), color: "#1B6FD8" },
    { key: "margin", label: "毛利率趨勢", score: Math.round((data.breakdown.margin / 30) * 100), color: "#7C3AED" },
    { key: "industry_relative", label: "同業相對地位", score: Math.round((data.breakdown.industry_relative / 30) * 100), color: "#F59E0B" },
  ];

  const gmDelta = data.avg_gross_margin_recent != null && data.avg_gross_margin_3y_ago != null
    ? data.avg_gross_margin_recent - data.avg_gross_margin_3y_ago
    : null;

  return (
    <div className="space-y-4">
      {/* 總分卡 */}
      <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden">
        <div className="px-5 py-5 flex items-center gap-5">
          <div className="relative flex-shrink-0">
            <svg width="88" height="88" viewBox="0 0 88 88">
              <circle cx="44" cy="44" r="34" fill="none" stroke="#E8ECF4" strokeWidth="7" />
              <circle cx="44" cy="44" r="34" fill="none" stroke={overallColor} strokeWidth="7"
                strokeDasharray={`${(data.score / 100) * 2 * Math.PI * 34} ${2 * Math.PI * 34}`}
                strokeLinecap="round" transform="rotate(-90 44 44)" />
              <text x="44" y="49" textAnchor="middle" style={{ fontSize: 22, fontWeight: 800, fill: overallColor }}>{data.score}</text>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] text-[#6B7A99] mb-1">護城河評分・{data.industry}</div>
            <div className="text-[15px] font-bold text-[#0D1B2A]">
              {data.score >= 70 ? "護城河較深" : data.score >= 50 ? "有一定優勢" : data.score >= 30 ? "優勢不明顯" : "護城河偏弱"}
            </div>
            <div className="text-[11px] text-[#6B7A99] mt-1">獲利持續性×40 ＋ 毛利率趨勢×30 ＋ 同業相對地位×30</div>
          </div>
        </div>
      </div>

      {/* 三面向 */}
      <div className="grid grid-cols-3 gap-3">
        {dims.map((d) => (
          <div key={d.key} className="bg-white border border-[#DDE2EC] rounded-xl p-3 flex flex-col items-center gap-1">
            <div className="text-[10px] text-[#6B7A99] font-medium text-center">{d.label}</div>
            <ScoreRing score={d.score} color={d.color} />
            <div className="text-[10px] text-[#6B7A99] text-center">/ 100</div>
          </div>
        ))}
      </div>

      {/* 支撐數據 */}
      <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#DDE2EC]">
          <h3 className="text-[13px] font-bold text-[#0D1B2A]">數據依據</h3>
        </div>
        <div className="px-4 py-3 space-y-2.5 text-[13px]">
          <div className="flex items-center justify-between">
            <span className="text-[#6B7A99]">近 12 季平均單季 ROE</span>
            <span className="font-semibold text-[#0D1B2A] tabular-nums">
              {data.avg_roe_12q != null ? `${data.avg_roe_12q}%` : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[#6B7A99]">近 4 季毛利率</span>
            <span className="font-semibold text-[#0D1B2A] tabular-nums">
              {data.avg_gross_margin_recent != null ? `${data.avg_gross_margin_recent}%` : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[#6B7A99]">3 年前毛利率（4 季均）</span>
            <span className="font-semibold text-[#0D1B2A] tabular-nums">
              {data.avg_gross_margin_3y_ago != null ? `${data.avg_gross_margin_3y_ago}%` : "—"}
            </span>
          </div>
          {gmDelta != null && (
            <div className="flex items-center justify-between">
              <span className="text-[#6B7A99]">毛利率變化</span>
              <span className={`font-semibold tabular-nums ${gmDelta >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]"}`}>
                {gmDelta >= 0 ? "+" : ""}{gmDelta.toFixed(1)} 個百分點
              </span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-[#6B7A99]">同業 ROE 百分位</span>
            <span className="font-semibold text-[#0D1B2A] tabular-nums">
              {data.industry_percentile != null ? `前 ${100 - data.industry_percentile}%（樣本 ${data.peer_sample_size} 檔）` : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* 近 8 季 ROE / 毛利率 */}
      {data.history.length > 0 && (
        <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#DDE2EC]">
            <h3 className="text-[13px] font-bold text-[#0D1B2A]">近 8 季 ROE / 毛利率</h3>
          </div>
          <div className="divide-y divide-[#F5F7FC]">
            {data.history.map((h) => (
              <div key={h.period} className="flex items-center justify-between px-4 py-2 text-[12px]">
                <span className="text-[#6B7A99] tabular-nums">{h.period.slice(0, 4)} Q{h.period.slice(4)}</span>
                <span className="text-[#0D1B2A] tabular-nums">ROE {h.roe != null ? `${h.roe}%` : "—"}</span>
                <span className="text-[#0D1B2A] tabular-nums">毛利率 {h.gross_margin != null ? `${h.gross_margin}%` : "—"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11px] text-[#6B7A99] px-1">
        資料來源：nStock 財報 API（未公開文件端點，格式可能異動）・僅供參考，非投資建議
      </p>
    </div>
  );
}

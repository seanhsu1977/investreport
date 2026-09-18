import { useEffect, useMemo, useState } from "react";
import { stocksApi, type FinancialStructure, type Report } from "../api/client";

function MarginChart({ quarters }: { quarters: FinancialStructure["quarters"] }) {
  const W = 560, H = 160, padL = 32, padR = 12, padT = 10, padB = 20;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = quarters.length;
  if (n < 2) return null;

  const x = (i: number) => padL + (innerW * i) / (n - 1);
  const vals = quarters.map((q) => q.gross_margin).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  const yMax = Math.max(20, Math.ceil((Math.max(...vals) + 5) / 5) * 5);
  const yMin = Math.min(0, Math.floor((Math.min(...vals) - 5) / 5) * 5);
  const y = (v: number) => padT + innerH * (1 - (v - yMin) / (yMax - yMin));

  let d = "";
  quarters.forEach((q, i) => {
    if (q.gross_margin == null) return;
    d += (d === "" ? "M" : "L") + x(i).toFixed(1) + " " + y(q.gross_margin).toFixed(1) + " ";
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="毛利率趨勢">
      {[0, 0.5, 1].map((f) => {
        const yy = padT + innerH * f;
        return <line key={f} x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="#EEF0F6" strokeWidth={1} />;
      })}
      {quarters.map((q, i) => (
        <text key={q.period} x={x(i)} y={H - 4} fontSize={9} fill="#6B7A99" textAnchor="middle">
          {q.period.slice(2, 4)}Q{q.period.slice(4)}
        </text>
      ))}
      <text x={2} y={padT + 4} fontSize={9} fill="#6B7A99">{yMax}%</text>
      <path d={d} fill="none" stroke="#1B6FD8" strokeWidth={2.5} />
      {quarters.map((q, i) => q.gross_margin != null && (
        <circle key={q.period} cx={x(i)} cy={y(q.gross_margin)} r={2.5} fill="#1B6FD8" />
      ))}
    </svg>
  );
}

export default function DailyArticlePreview({ code, title, content }: { code: string; title: string; content: string }) {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [fin, setFin] = useState<FinancialStructure | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!code) { setLoading(false); return; }
    setLoading(true);
    Promise.allSettled([
      stocksApi.reports(code).then((r) => setReports(r.reports)),
      stocksApi.financial_structure(code).then(setFin),
    ]).finally(() => setLoading(false));
  }, [code]);

  const consensus = useMemo(() => {
    if (!reports || reports.length === 0) return null;
    const buy = reports.filter((r) => ["買進", "Buy", "增持"].includes(r.recommendation ?? "")).length;
    const hold = reports.filter((r) => ["持有", "Hold", "中立"].includes(r.recommendation ?? "")).length;
    const sell = reports.filter((r) => ["賣出", "Sell", "減持"].includes(r.recommendation ?? "")).length;
    const targets = reports.map((r) => r.target_price).filter((t): t is number => t != null && t > 0);
    const avgTarget = targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : null;
    return { buy, hold, sell, avgTarget, count: reports.length };
  }, [reports]);

  const paragraphs = content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  if (loading) {
    return <p className="text-xs text-gray-400 text-center py-6">載入視覺預覽資料中…</p>;
  }

  return (
    <div className="space-y-3">
      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="px-4 py-3" style={{ background: "linear-gradient(180deg,#0B1E3D,#122548)" }}>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs px-1.5 py-0.5 rounded" style={{ background: "linear-gradient(135deg,#C9A84C,#E8C36A)", color: "#0B1E3D", fontWeight: 700 }}>
              {code}
            </span>
            <span className="text-white text-sm font-semibold truncate">{title || "（未命名草稿）"}</span>
          </div>
        </div>

        {consensus && (
          <div className="grid grid-cols-4 divide-x divide-gray-100 border-b border-gray-100">
            <div className="text-center py-2.5">
              <div className="text-lg font-extrabold text-red-500 tabular-nums">{consensus.buy}</div>
              <div className="text-[10px] text-gray-400">買進</div>
            </div>
            <div className="text-center py-2.5">
              <div className="text-lg font-extrabold text-gray-500 tabular-nums">{consensus.hold}</div>
              <div className="text-[10px] text-gray-400">持有</div>
            </div>
            <div className="text-center py-2.5">
              <div className="text-lg font-extrabold text-emerald-600 tabular-nums">{consensus.sell}</div>
              <div className="text-[10px] text-gray-400">賣出</div>
            </div>
            <div className="text-center py-2.5">
              <div className="text-lg font-extrabold text-blue-700 tabular-nums">
                {consensus.avgTarget ? consensus.avgTarget.toFixed(0) : "—"}
              </div>
              <div className="text-[10px] text-gray-400">平均目標價</div>
            </div>
          </div>
        )}

        {fin && fin.quarters.length > 1 && (
          <div className="px-4 py-3 border-b border-gray-100">
            <div className="text-[11px] font-semibold text-gray-500 mb-1.5">毛利率趨勢（既有財報，非預測）</div>
            <MarginChart quarters={fin.quarters} />
          </div>
        )}

        {fin?.forward && (fin.forward.forward_pe != null || fin.forward.target_price != null) && (
          <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-4 text-xs">
            <span className="text-gray-500">前瞻本益比 <b className="text-gray-800">{fin.forward.forward_pe ?? "—"}</b></span>
            <span className="text-gray-500">共識目標價 <b className="text-gray-800">{fin.forward.target_price ?? "—"}</b></span>
          </div>
        )}

        <div className="px-4 py-4 space-y-3">
          {paragraphs.length === 0 ? (
            <p className="text-sm text-gray-400">（草稿內容是空的）</p>
          ) : (
            paragraphs.map((p, i) => (
              <p key={i} className="text-[13.5px] text-gray-800 leading-relaxed whitespace-pre-wrap">{p}</p>
            ))
          )}
        </div>
      </div>
      <p className="text-[11px] text-gray-400 px-1">
        僅供編輯時參考的視覺預覽，不影響實際發布到 nStock/Threads/Facebook 的內容格式。
      </p>
    </div>
  );
}

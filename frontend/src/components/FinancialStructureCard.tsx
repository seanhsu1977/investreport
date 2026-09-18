import { useEffect, useState } from "react";
import { stocksApi, type FinancialStructure } from "../api/client";

function MarginChart({ quarters }: { quarters: FinancialStructure["quarters"] }) {
  const W = 640, H = 200, padL = 34, padR = 16, padT = 12, padB = 24;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = quarters.length;
  if (n < 2) return null;

  const x = (i: number) => padL + (innerW * i) / (n - 1);
  const vals = quarters.flatMap((q) => [q.gross_margin, q.operating_margin, q.net_margin]).filter((v): v is number => v != null);
  const yMax = Math.max(20, Math.ceil((Math.max(...vals, 0) + 5) / 5) * 5);
  const yMin = Math.min(0, Math.floor((Math.min(...vals, 0) - 5) / 5) * 5);
  const y = (v: number) => padT + innerH * (1 - (v - yMin) / (yMax - yMin));

  const line = (key: "gross_margin" | "operating_margin" | "net_margin") => {
    let d = "";
    quarters.forEach((q, i) => {
      const v = q[key];
      if (v == null) return;
      d += (d === "" ? "M" : "L") + x(i).toFixed(1) + " " + y(v).toFixed(1) + " ";
    });
    return d;
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="近幾季三率趨勢">
      {[0, 0.5, 1].map((f) => {
        const yy = padT + innerH * f;
        return <line key={f} x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="#EEF0F6" strokeWidth={1} />;
      })}
      {quarters.map((q, i) => (
        <text key={q.period} x={x(i)} y={H - 6} fontSize={10} fill="#6B7A99" textAnchor="middle">
          {q.period.slice(2, 4)}Q{q.period.slice(4)}
        </text>
      ))}
      <text x={4} y={padT + 4} fontSize={10} fill="#6B7A99">{yMax}%</text>
      <text x={4} y={H - padB + 4} fontSize={10} fill="#6B7A99">{yMin}%</text>
      <path d={line("gross_margin")} fill="none" stroke="#1B6FD8" strokeWidth={2.5} />
      <path d={line("operating_margin")} fill="none" stroke="#7C3AED" strokeWidth={2} />
      <path d={line("net_margin")} fill="none" stroke="#F59E0B" strokeWidth={2} />
      {quarters.map((q, i) => q.gross_margin != null && (
        <circle key={q.period} cx={x(i)} cy={y(q.gross_margin)} r={2.5} fill="#1B6FD8" />
      ))}
    </svg>
  );
}

export default function FinancialStructureCard({ code }: { code: string }) {
  const [data, setData] = useState<FinancialStructure | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    stocksApi.financial_structure(code)
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
    return <p className="text-sm text-[#6B7A99] text-center py-8">{error ?? "沒有財務結構資料"}</p>;
  }

  const latest = data.quarters[data.quarters.length - 1];
  const fwd = data.forward;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white border border-[#DDE2EC] rounded-xl p-3">
          <div className="text-[10px] text-[#6B7A99] uppercase tracking-[0.4px]">ROE（近四季）</div>
          <div className="text-[17px] font-bold mt-1 tabular-nums">{data.roe_ttm != null ? `${data.roe_ttm}%` : "—"}</div>
        </div>
        <div className="bg-white border border-[#DDE2EC] rounded-xl p-3">
          <div className="text-[10px] text-[#6B7A99] uppercase tracking-[0.4px]">ROA（近四季）</div>
          <div className="text-[17px] font-bold mt-1 tabular-nums">{data.roa_ttm != null ? `${data.roa_ttm}%` : "—"}</div>
        </div>
        <div className="bg-white border border-[#DDE2EC] rounded-xl p-3">
          <div className="text-[10px] text-[#6B7A99] uppercase tracking-[0.4px]">負債比例</div>
          <div className="text-[17px] font-bold mt-1 tabular-nums">{data.debt_ratio != null ? `${data.debt_ratio}%` : "—"}</div>
        </div>
      </div>

      {latest && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white border border-[#DDE2EC] rounded-xl p-3">
            <div className="text-[10px] text-[#6B7A99] uppercase tracking-[0.4px]">單季毛利率</div>
            <div className="text-[17px] font-bold mt-1 tabular-nums" style={{ color: "#1B6FD8" }}>
              {latest.gross_margin != null ? `${latest.gross_margin}%` : "—"}
            </div>
          </div>
          <div className="bg-white border border-[#DDE2EC] rounded-xl p-3">
            <div className="text-[10px] text-[#6B7A99] uppercase tracking-[0.4px]">單季營業利益率</div>
            <div className="text-[17px] font-bold mt-1 tabular-nums" style={{ color: "#7C3AED" }}>
              {latest.operating_margin != null ? `${latest.operating_margin}%` : "—"}
            </div>
          </div>
          <div className="bg-white border border-[#DDE2EC] rounded-xl p-3">
            <div className="text-[10px] text-[#6B7A99] uppercase tracking-[0.4px]">單季淨利率</div>
            <div className="text-[17px] font-bold mt-1 tabular-nums" style={{ color: "#F59E0B" }}>
              {latest.net_margin != null ? `${latest.net_margin}%` : "—"}
            </div>
          </div>
        </div>
      )}

      <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#DDE2EC] flex items-center justify-between">
          <h3 className="text-[13px] font-bold text-[#0D1B2A]">三率趨勢</h3>
          <div className="flex items-center gap-3 text-[11px] text-[#6B7A99]">
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm inline-block" style={{ background: "#1B6FD8" }} />毛利率</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm inline-block" style={{ background: "#7C3AED" }} />營業利益率</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm inline-block" style={{ background: "#F59E0B" }} />淨利率</span>
          </div>
        </div>
        <div className="p-4">
          <MarginChart quarters={data.quarters} />
        </div>
      </div>

      <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#DDE2EC]">
          <h3 className="text-[13px] font-bold text-[#0D1B2A]">前瞻本益比 / 共識目標價</h3>
        </div>
        {fwd && (fwd.forward_pe != null || fwd.target_price != null) ? (
          <div className="px-4 py-3 space-y-2.5 text-[13px]">
            <div className="flex items-center justify-between">
              <span className="text-[#6B7A99]">分析師預估 EPS</span>
              <span className="font-semibold text-[#0D1B2A] tabular-nums">{fwd.estimated_eps}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#6B7A99]">前瞻本益比</span>
              <span className="font-semibold text-[#0D1B2A] tabular-nums">{fwd.forward_pe ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#6B7A99]">共識目標價</span>
              <span className="font-semibold text-[#0D1B2A] tabular-nums">{fwd.target_price ?? "—"}</span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-[#6B7A99] text-center py-6">
            {fwd && fwd.estimated_eps != null && fwd.estimated_eps < 0
              ? "分析師預估虧損，無法計算前瞻本益比"
              : "沒有前瞻估值資料"}
          </p>
        )}
      </div>

      <p className="text-[11px] text-[#6B7A99] px-1">
        資料來源：nStock（歷史財報 + 分析師共識前瞻估值，單一快照非分年拆解）・僅供參考，非投資建議
      </p>
    </div>
  );
}

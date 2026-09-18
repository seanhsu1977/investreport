import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { stocksApi, type FundamentalScreenItem } from "../api/client";
import MoatBadge from "./MoatBadge";

type SortKey = "market_cap" | "moat_score" | "roe_ttm" | "gross_margin" | "dividend_yield" | "pe" | "upside";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "market_cap", label: "市值" },
  { key: "moat_score", label: "護城河評分" },
  { key: "roe_ttm", label: "ROE(近四季)" },
  { key: "gross_margin", label: "毛利率" },
  { key: "dividend_yield", label: "殖利率" },
  { key: "pe", label: "本益比（低到高）" },
  { key: "upside", label: "共識目標價 Upside" },
];

type CacheResult = {
  items: FundamentalScreenItem[];
  total: number;
  scanned: number;
  computed_at: string | null;
  data_date: string | null;
};

function upside(it: FundamentalScreenItem): number | null {
  if (it.target_price == null || it.forward_pe == null || it.estimated_eps == null) return null;
  const currentPrice = it.forward_pe * it.estimated_eps;
  if (!currentPrice) return null;
  return ((it.target_price / currentPrice) - 1) * 100;
}

export default function FundamentalScreener() {
  const [result, setResult] = useState<CacheResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [peMax, setPeMax] = useState("");
  const [pbMax, setPbMax] = useState("");
  const [yieldMin, setYieldMin] = useState("");
  const [roeMin, setRoeMin] = useState("");
  const [gmMin, setGmMin] = useState("");
  const [capMin, setCapMin] = useState("");
  const [moatMin, setMoatMin] = useState("");
  const [industry, setIndustry] = useState("全部");
  const [sortKey, setSortKey] = useState<SortKey>("market_cap");

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  useEffect(() => {
    stocksApi.fundamental_screen()
      .then(setResult)
      .catch((e: unknown) => {
        const msg =
          (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
          ?? (e as Error)?.message ?? "載入失敗";
        setError(msg);
      })
      .finally(() => setLoading(false));
    return stopPoll;
  }, []);

  const triggerRefresh = async () => {
    setRefreshing(true);
    stopPoll();
    try {
      await stocksApi.fundamental_screen_refresh();
    } catch {
      setRefreshing(false);
      return;
    }
    const originalAt = result?.computed_at ?? null;
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts++;
      try {
        const r = await stocksApi.fundamental_screen();
        if (r.computed_at !== originalAt || attempts >= 24) {
          stopPoll();
          setResult(r);
          setRefreshing(false);
        }
      } catch { /* ignore poll errors */ }
    }, 15_000);
  };

  const industries = useMemo(() => {
    const set = new Set<string>();
    (result?.items ?? []).forEach((it) => { if (it.industry) set.add(it.industry); });
    return ["全部", ...Array.from(set).sort()];
  }, [result]);

  const filtered = useMemo(() => {
    const items = result?.items ?? [];
    const peMaxN = parseFloat(peMax), pbMaxN = parseFloat(pbMax), yieldMinN = parseFloat(yieldMin);
    const roeMinN = parseFloat(roeMin), gmMinN = parseFloat(gmMin), capMinN = parseFloat(capMin), moatMinN = parseFloat(moatMin);

    const out = items.filter((it) => {
      if (!isNaN(peMaxN) && (it.pe == null || it.pe > peMaxN)) return false;
      if (!isNaN(pbMaxN) && (it.pb == null || it.pb > pbMaxN)) return false;
      if (!isNaN(yieldMinN) && (it.dividend_yield == null || it.dividend_yield < yieldMinN)) return false;
      if (!isNaN(roeMinN) && (it.roe_ttm == null || it.roe_ttm < roeMinN)) return false;
      if (!isNaN(gmMinN) && (it.gross_margin == null || it.gross_margin < gmMinN)) return false;
      if (!isNaN(capMinN) && (it.market_cap == null || it.market_cap < capMinN)) return false;
      if (!isNaN(moatMinN) && (it.moat_score == null || it.moat_score < moatMinN)) return false;
      if (industry !== "全部" && it.industry !== industry) return false;
      return true;
    });

    const val = (it: FundamentalScreenItem): number => {
      if (sortKey === "upside") return upside(it) ?? -Infinity;
      if (sortKey === "pe") return it.pe ?? Infinity;
      return (it[sortKey] as number | null) ?? -Infinity;
    };
    const asc = sortKey === "pe";
    out.sort((a, b) => asc ? val(a) - val(b) : val(b) - val(a));
    return out;
  }, [result, peMax, pbMax, yieldMin, roeMin, gmMin, capMin, moatMin, industry, sortKey]);

  const clearFilters = () => {
    setPeMax(""); setPbMax(""); setYieldMin(""); setRoeMin("");
    setGmMin(""); setCapMin(""); setMoatMin(""); setIndustry("全部");
  };

  const fieldCls = "w-full text-sm px-2.5 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs text-gray-400">
          本益比/股價淨值比/殖利率/ROE/毛利率/市值/護城河 多因子篩選・自選股（手動）/ 含 ETF 成份股 + 投顧精選候選股（每日 15:36 排程）
          {result?.data_date && (
            <span className="ml-1.5 text-gray-300">資料日期 {result.data_date}</span>
          )}
        </p>
        <button
          onClick={triggerRefresh}
          disabled={refreshing || loading}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-600 disabled:opacity-40 transition shrink-0 ml-3"
        >
          <svg className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
          {refreshing ? "掃描中…" : "手動更新"}
        </button>
      </div>

      {refreshing && (
        <p className="text-xs text-blue-500 text-center py-2">掃描進行中，通常需要 2–3 分鐘，完成後自動更新</p>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <svg className="w-5 h-5 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a10 10 0 100 10H4z"/>
          </svg>
        </div>
      ) : error ? (
        <p className="text-xs text-red-500 text-center py-6">✗ {error}</p>
      ) : (
        <>
          <div className="bg-white rounded-2xl border border-gray-200 p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div><label className="text-xs text-gray-500 block mb-1">本益比 ≤</label>
                <input className={fieldCls} value={peMax} onChange={(e) => setPeMax(e.target.value)} placeholder="不限" /></div>
              <div><label className="text-xs text-gray-500 block mb-1">股價淨值比 ≤</label>
                <input className={fieldCls} value={pbMax} onChange={(e) => setPbMax(e.target.value)} placeholder="不限" /></div>
              <div><label className="text-xs text-gray-500 block mb-1">殖利率 % ≥</label>
                <input className={fieldCls} value={yieldMin} onChange={(e) => setYieldMin(e.target.value)} placeholder="不限" /></div>
              <div><label className="text-xs text-gray-500 block mb-1">ROE(近四季) % ≥</label>
                <input className={fieldCls} value={roeMin} onChange={(e) => setRoeMin(e.target.value)} placeholder="不限" /></div>
              <div><label className="text-xs text-gray-500 block mb-1">毛利率 % ≥</label>
                <input className={fieldCls} value={gmMin} onChange={(e) => setGmMin(e.target.value)} placeholder="不限" /></div>
              <div><label className="text-xs text-gray-500 block mb-1">市值(億) ≥</label>
                <input className={fieldCls} value={capMin} onChange={(e) => setCapMin(e.target.value)} placeholder="不限" /></div>
              <div><label className="text-xs text-gray-500 block mb-1">護城河評分 ≥</label>
                <input className={fieldCls} value={moatMin} onChange={(e) => setMoatMin(e.target.value)} placeholder="不限" /></div>
              <div><label className="text-xs text-gray-500 block mb-1">產業</label>
                <select className={fieldCls} value={industry} onChange={(e) => setIndustry(e.target.value)}>
                  {industries.map((i) => <option key={i} value={i}>{i}</option>)}
                </select></div>
            </div>
            <div className="flex items-center gap-2 mt-3">
              <label className="text-xs text-gray-500">排序</label>
              <select className={`${fieldCls} w-auto`} value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                {SORT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <button onClick={clearFilters} className="text-xs text-blue-500 hover:underline ml-auto">清除條件</button>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-gray-100">
              <span className="text-xs text-gray-400">共 {filtered.length} / {result?.total ?? 0} 檔</span>
            </div>
            {filtered.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">沒有符合條件的個股</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead className="bg-gray-50 text-gray-500 text-xs">
                    <tr>
                      <th className="px-3 py-2 text-left">股票</th>
                      <th className="px-3 py-2 text-right">本益比</th>
                      <th className="px-3 py-2 text-right">股價淨值比</th>
                      <th className="px-3 py-2 text-right">殖利率</th>
                      <th className="px-3 py-2 text-right">ROE</th>
                      <th className="px-3 py-2 text-right">毛利率</th>
                      <th className="px-3 py-2 text-right">前瞻本益比</th>
                      <th className="px-3 py-2 text-right">共識目標價</th>
                      <th className="px-3 py-2 text-right">市值(億)</th>
                      <th className="px-3 py-2 text-center">護城河</th>
                      <th className="px-3 py-2 text-left">產業</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {filtered.map((it) => {
                      const up = upside(it);
                      return (
                        <tr key={it.code} className="hover:bg-gray-50 transition">
                          <td className="px-3 py-2">
                            <Link to={`/stocks/${it.code}`} className="font-bold text-blue-700 hover:underline">{it.code}</Link>
                            <span className="text-gray-500 ml-1.5">{it.name}</span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{it.pe ?? "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{it.pb ?? "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{it.dividend_yield != null ? `${it.dividend_yield}%` : "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{it.roe_ttm != null ? `${it.roe_ttm}%` : "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{it.gross_margin != null ? `${it.gross_margin}%` : "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{it.forward_pe ?? "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {it.target_price ?? "—"}
                            {up != null && (
                              <span className={`ml-1.5 text-xs font-semibold ${up >= 0 ? "text-red-500" : "text-emerald-600"}`}>
                                {up >= 0 ? "+" : ""}{up.toFixed(1)}%
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{it.market_cap != null ? Math.round(it.market_cap).toLocaleString() : "—"}</td>
                          <td className="px-3 py-2 text-center"><MoatBadge score={it.moat_score} /></td>
                          <td className="px-3 py-2 text-gray-500 text-xs">{it.industry ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {!loading && !error && !result && (
        <p className="text-xs text-gray-400 text-center py-8">尚無快取資料，今日收盤後（15:36）將自動更新</p>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { stocksApi, type KdjScreenItem } from "../api/client";

const KD_SIGNAL_COLOR: Record<string, string> = {
  "低位金叉": "bg-red-100 text-red-700",
  "金叉":    "bg-orange-100 text-orange-700",
  "低位死叉": "bg-emerald-100 text-emerald-700",
  "死叉":    "bg-teal-100 text-teal-700",
  "高位死叉": "bg-green-100 text-green-700",
};

const J_SIGNAL_COLOR: Record<string, string> = {
  "J回升": "bg-red-100 text-red-700",
  "J超賣": "bg-orange-100 text-orange-600",
  "J轉弱": "bg-emerald-100 text-emerald-700",
  "J超買": "bg-blue-100 text-blue-700",
};

type FilterType = "j" | "golden" | "dead" | "all";

type CacheResult = {
  items: KdjScreenItem[];
  total: number;
  scanned: number;
  computed_at: string | null;
  data_date: string | null;
};

export default function KdjScreener() {
  const [result, setResult] = useState<CacheResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>("j");
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  useEffect(() => {
    stocksApi.kdj_screen()
      .then((r) => setResult(r))
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
      await stocksApi.kdj_screen_refresh();
    } catch {
      setRefreshing(false);
      return;
    }
    const originalAt = result?.computed_at ?? null;
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts++;
      try {
        const r = await stocksApi.kdj_screen();
        if (r.computed_at !== originalAt || attempts >= 24) {
          stopPoll();
          setResult(r);
          setRefreshing(false);
        }
      } catch { /* ignore poll errors */ }
    }, 15_000);
  };

  const displayed = (result?.items ?? []).filter((it) => {
    if (filter === "j") return it.j_signal === "J回升" || it.j_signal === "J超賣";
    if (filter === "golden") return it.kdj_signal === "低位金叉" || it.kdj_signal === "金叉";
    if (filter === "dead") return it.kdj_signal?.includes("死叉");
    return true;
  });

  const jCount  = (result?.items ?? []).filter(it => it.j_signal === "J回升" || it.j_signal === "J超賣").length;
  const kdCount = (result?.items ?? []).filter(it => it.kdj_signal).length;

  const FILTERS: { key: FilterType; label: string; count: number }[] = [
    { key: "j",      label: "J 訊號", count: jCount },
    { key: "golden", label: "金叉",   count: (result?.items ?? []).filter(it => it.kdj_signal === "低位金叉" || it.kdj_signal === "金叉").length },
    { key: "dead",   label: "死叉",   count: (result?.items ?? []).filter(it => it.kdj_signal?.includes("死叉")).length },
    { key: "all",    label: "全部",   count: result?.total ?? 0 },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs text-gray-400">
          KDJ(89,9,12) J 線 + 交叉訊號 + 三大法人籌碼・自選股（手動）/ 含 ETF 成份股（每日 15:30 排程）
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

      {loading && (
        <div className="flex justify-center py-12">
          <svg className="w-5 h-5 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a10 10 0 100 10H4z"/>
          </svg>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-500 text-center py-6">✗ {error}</p>
      )}

      {!loading && !error && result && (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-3 flex-wrap">
            <span className="text-xs text-gray-400">掃描 {result.scanned} 檔，命中 {result.total} 檔</span>
            <div className="flex gap-1.5 ml-auto">
              {FILTERS.map(({ key, label, count }) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={`text-xs px-2.5 py-1 rounded-full transition ${
                    filter === key ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {label}
                  {count > 0 && (
                    <span className={`ml-1 ${filter === key ? "text-blue-200" : "text-gray-400"}`}>
                      {count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {displayed.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">
              {result.total === 0
                ? "目前無訊號個股"
                : "目前所選類型無符合，可切換至「全部」查看"}
            </p>
          ) : (
            <div className="divide-y divide-gray-50">
              {displayed.map((it) => (
                <div key={it.code} className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition">
                  <div className="flex items-center gap-2 min-w-0">
                    <Link to={`/stocks/${it.code}`} className="text-sm font-bold text-blue-700 hover:underline shrink-0">
                      {it.code}
                    </Link>
                    <span className="text-sm text-gray-600 truncate">{it.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ml-2">
                    {/* J 值 */}
                    {it.kdj_j != null && (
                      <span className={`text-xs tabular-nums font-medium ${
                        it.kdj_j < 0 ? "text-red-500" : it.kdj_j > 100 ? "text-green-600" : "text-gray-400"
                      }`}>
                        J{it.kdj_j}
                      </span>
                    )}
                    {/* K/D 值 */}
                    <span className="text-xs text-gray-400 tabular-nums hidden sm:inline">
                      K{it.kdj_k} D{it.kdj_d}
                    </span>
                    {/* J 訊號 badge */}
                    {it.j_signal && (
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${J_SIGNAL_COLOR[it.j_signal] ?? "bg-gray-100 text-gray-600"}`}>
                        {it.j_signal}
                        {it.j_cross_days != null && it.j_cross_days > 0 && (
                          <span className="ml-0.5 opacity-60">{it.j_cross_days}天</span>
                        )}
                      </span>
                    )}
                    {/* K/D 交叉 badge */}
                    {it.kdj_signal && (
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${KD_SIGNAL_COLOR[it.kdj_signal] ?? "bg-gray-100 text-gray-600"}`}>
                        {it.kdj_signal}
                        {it.kdj_cross_days != null && it.kdj_cross_days > 0 && (
                          <span className="ml-0.5 opacity-60">{it.kdj_cross_days}天</span>
                        )}
                      </span>
                    )}
                    {/* 籌碼：三大法人連續買賣超 badge */}
                    {it.inst_consec_days != null && it.inst_consec_sign != null && (
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                        it.inst_consec_sign > 0 ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"
                      }`}>
                        連{it.inst_consec_days}{it.inst_consec_sign > 0 ? "買" : "賣"}
                      </span>
                    )}
                    {/* 籌碼：三大法人 5 日合計買賣超（張） */}
                    {it.inst_5d != null && (
                      <span className={`text-xs tabular-nums hidden sm:inline ${
                        it.inst_5d > 0 ? "text-red-500" : it.inst_5d < 0 ? "text-emerald-600" : "text-gray-400"
                      }`}>
                        5日{it.inst_5d > 0 ? "+" : ""}{it.inst_5d.toLocaleString()}張
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!loading && !error && !result && (
        <p className="text-xs text-gray-400 text-center py-8">尚無快取資料，今日收盤後（15:30）將自動更新</p>
      )}
    </div>
  );
}

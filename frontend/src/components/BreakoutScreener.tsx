import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { stocksApi, type BreakoutScreenItem } from "../api/client";

type CacheResult = {
  items: BreakoutScreenItem[];
  total: number;
  scanned: number;
  computed_at: string | null;
  data_date: string | null;
};

export default function BreakoutScreener() {
  const [result, setResult] = useState<CacheResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  useEffect(() => {
    stocksApi.breakout_screen()
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
      await stocksApi.breakout_screen_refresh();
    } catch {
      setRefreshing(false);
      return;
    }
    const originalAt = result?.computed_at ?? null;
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts++;
      try {
        const r = await stocksApi.breakout_screen();
        if (r.computed_at !== originalAt || attempts >= 24) {
          stopPoll();
          setResult(r);
          setRefreshing(false);
        }
      } catch { /* ignore poll errors */ }
    }, 15_000);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs text-gray-400">
          橫盤整理後突破・區間窄 + 均線糾結 → 站上區間高點/布林上軌・自選股（手動）/ 含 ETF 成份股（每日 15:32 排程）
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
          <div className="px-4 py-2.5 border-b border-gray-100">
            <span className="text-xs text-gray-400">掃描 {result.scanned} 檔，命中 {result.total} 檔</span>
          </div>

          {result.items.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">目前無符合的個股</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {result.items.map((it) => (
                <div key={it.code} className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Link to={`/stocks/${it.code}`} className="text-sm font-bold text-blue-700 hover:underline shrink-0">
                      {it.code}
                    </Link>
                    <span className="text-sm text-gray-600 truncate">{it.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ml-2 flex-wrap justify-end">
                    <span className="text-xs text-gray-400 tabular-nums">
                      區間 {it.range_pct}%
                    </span>
                    <span className="text-xs text-gray-400 tabular-nums hidden sm:inline">
                      突破 {it.range_high}
                    </span>
                    {it.volume_confirm && (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                        量增{it.volume_ratio != null ? ` ${it.volume_ratio}x` : ""}
                      </span>
                    )}
                    {it.momentum_confirm && (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                        動能轉強
                      </span>
                    )}
                    {it.rsi != null && (
                      <span className="text-xs text-gray-400 tabular-nums hidden sm:inline">
                        RSI{it.rsi}
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
        <p className="text-xs text-gray-400 text-center py-8">尚無快取資料，今日收盤後（15:32）將自動更新</p>
      )}
    </div>
  );
}

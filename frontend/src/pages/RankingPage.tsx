import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { stocksApi, watchlistApi, UpsideRankingItem } from "../api/client";
import RecommendationBadge from "../components/RecommendationBadge";

const RANK_COLORS: Record<number, string> = {
  1: "text-yellow-500 font-bold",  // 金
  2: "text-gray-400 font-bold",    // 銀
  3: "text-amber-600 font-bold",   // 銅
};

function UpsidePct({ value }: { value: number }) {
  const sign = value >= 0 ? "+" : "";
  // 台股慣例：漲=紅，跌=綠
  const cls = value >= 0 ? "text-red-600 font-semibold" : "text-green-700 font-semibold";
  return <span className={cls}>{sign}{value.toFixed(1)}%</span>;
}

function formatPrice(price: number) {
  return price.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function WatchlistButton({ item }: { item: UpsideRankingItem }) {
  const [added, setAdded] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleAdd = async () => {
    if (added || loading) return;
    setLoading(true);
    try {
      await watchlistApi.add(item.stock_code, item.stock_name ?? undefined);
      setAdded(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleAdd}
      disabled={added || loading}
      className={`text-xs px-2 py-1 rounded border transition ${
        added
          ? "border-green-300 text-green-600 bg-green-50 cursor-default"
          : loading
          ? "border-gray-200 text-gray-400 cursor-wait"
          : "border-blue-300 text-blue-600 hover:bg-blue-50"
      }`}
    >
      {added ? "已加入" : loading ? "…" : "加入自選"}
    </button>
  );
}

const PERIOD_OPTIONS = [
  { days: 7,  label: "近一週"   },
  { days: 30, label: "近一個月" },
  { days: 90, label: "近三個月" },
];

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小時

function cacheKey(days: number) { return `ranking_cache_${days}d`; }

function loadCache(days: number): { items: UpsideRankingItem[]; fetchedAt: number } | null {
  try {
    const raw = localStorage.getItem(cacheKey(days));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.fetchedAt < CACHE_TTL_MS) return parsed;
    return null;
  } catch {
    return null;
  }
}

function saveCache(days: number, items: UpsideRankingItem[]) {
  localStorage.setItem(cacheKey(days), JSON.stringify({ items, fetchedAt: Date.now() }));
}

export default function RankingPage() {
  const [days, setDays] = useState(7);
  const cached = loadCache(days);
  const [items, setItems] = useState<UpsideRankingItem[]>(cached?.items ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(
    cached ? new Date(cached.fetchedAt) : null
  );

  const fetchRanking = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    try {
      const data = await stocksApi.upside_ranking(d);
      setItems(data);
      setLastFetched(new Date());
      saveCache(d, data);
    } catch (e: any) {
      setError("載入失敗，請稍後再試。");
    } finally {
      setLoading(false);
    }
  }, []);

  // 切換期間時：有快取直接用，沒有才抓
  useEffect(() => {
    const c = loadCache(days);
    if (c) {
      setItems(c.items);
      setLastFetched(new Date(c.fetchedAt));
    } else {
      setItems([]);
      fetchRanking(days);
    }
  }, [days, fetchRanking]);

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">目標價差異排行</h1>
          <p className="text-sm text-gray-500 mt-1">
            依最新報告目標價與現價差異排序
            {lastFetched && (
              <span className="ml-2 text-gray-400">
                · 更新於 {lastFetched.toLocaleTimeString("zh-TW")}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* 報告期間篩選 */}
          <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                onClick={() => setDays(opt.days)}
                disabled={loading}
                className={`px-4 py-2 transition ${
                  days === opt.days
                    ? "bg-blue-600 text-white font-medium"
                    : "bg-white text-gray-600 hover:bg-gray-50"
                } disabled:opacity-50`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {/* 重新整理 */}
          <button
            onClick={() => fetchRanking(days)}
            disabled={loading}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-wait transition"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                載入中…
              </>
            ) : (
              <>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582M20 20v-5h-.581M5.5 9A7.5 7.5 0 0119.5 15M4.5 15A7.5 7.5 0 0118.5 9" />
                </svg>
                重新整理
              </>
            )}
          </button>
        </div>
      </div>

      {/* Loading state */}
      {loading && items.length === 0 && (
        <div className="text-center py-16">
          <svg className="animate-spin h-8 w-8 text-blue-500 mx-auto mb-3" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <p className="text-gray-500 text-sm">抓取各股現價中，請稍候…</p>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm mb-4">
          {error}
        </div>
      )}

      {/* Desktop table */}
      {items.length > 0 && (
        <>
          <div className="hidden sm:block bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100 text-gray-500 text-xs uppercase tracking-wide">
                  <th className="px-4 py-3 text-center w-12">#</th>
                  <th className="px-4 py-3 text-left">股票</th>
                  <th className="px-4 py-3 text-right">現價</th>
                  <th className="px-4 py-3 text-right">目標價</th>
                  <th className="px-4 py-3 text-right">差異</th>
                  <th className="px-4 py-3 text-center">評等</th>
                  <th className="px-4 py-3 text-center">報告數</th>
                  <th className="px-4 py-3 text-center">最新報告日</th>
                  <th className="px-4 py-3 text-center">自選</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {items.map((item, idx) => {
                  const rank = idx + 1;
                  return (
                    <tr key={item.stock_code} className="hover:bg-gray-50 transition">
                      <td className="px-4 py-3 text-center">
                        <span className={`text-sm ${RANK_COLORS[rank] ?? "text-gray-500"}`}>
                          {rank <= 3 ? (
                            <span>{rank === 1 ? "🥇" : rank === 2 ? "🥈" : "🥉"}</span>
                          ) : (
                            rank
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          to={`/stocks/${item.stock_code}`}
                          state={{ from: "/ranking", label: "排行榜" }}
                          className="font-medium text-blue-700 hover:underline"
                        >
                          {item.stock_code}
                        </Link>
                        {item.stock_name && (
                          <span className="ml-1.5 text-gray-500 text-xs">{item.stock_name}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700 tabular-nums">
                        {formatPrice(item.current_price)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700 tabular-nums">
                        {formatPrice(item.target_price)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <UpsidePct value={item.upside_pct} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <RecommendationBadge value={item.recommendation} />
                      </td>
                      <td className="px-4 py-3 text-center tabular-nums">
                        <span className="text-sm text-gray-700 font-medium">{item.report_count}</span>
                        <span className="text-xs text-gray-400 ml-0.5">篇</span>
                      </td>
                      <td className="px-4 py-3 text-center text-gray-400 text-xs">
                        {item.report_date ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <WatchlistButton item={item} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="sm:hidden space-y-3">
            {items.map((item, idx) => {
              const rank = idx + 1;
              return (
                <div
                  key={item.stock_code}
                  className="bg-white rounded-xl shadow-sm border border-gray-100 p-4"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-lg ${RANK_COLORS[rank] ?? "text-gray-500 text-sm"}`}>
                        {rank <= 3 ? (rank === 1 ? "🥇" : rank === 2 ? "🥈" : "🥉") : `#${rank}`}
                      </span>
                      <div>
                        <Link
                          to={`/stocks/${item.stock_code}`}
                          state={{ from: "/ranking", label: "排行榜" }}
                          className="font-semibold text-blue-700"
                        >
                          {item.stock_code}
                        </Link>
                        {item.stock_name && (
                          <span className="ml-1 text-gray-500 text-xs">{item.stock_name}</span>
                        )}
                      </div>
                    </div>
                    <UpsidePct value={item.upside_pct} />
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-sm text-gray-600 mb-3">
                    <div>
                      <div className="text-xs text-gray-400">現價</div>
                      <div className="tabular-nums">{formatPrice(item.current_price)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400">目標價</div>
                      <div className="tabular-nums">{formatPrice(item.target_price)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400">報告數</div>
                      <div className="tabular-nums">{item.report_count} 篇</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400">最新報告日</div>
                      <div className="text-xs">{item.report_date ?? "—"}</div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <RecommendationBadge value={item.recommendation} />
                    <WatchlistButton item={item} />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Empty state */}
      {!loading && !error && items.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <p>沒有資料，請確認資料庫中有含目標價的報告。</p>
        </div>
      )}
    </div>
  );
}

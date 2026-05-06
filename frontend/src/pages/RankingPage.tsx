import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { stocksApi, watchlistApi, UpsideRankingItem, RecommendationItem } from "../api/client";
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

function formatVolume(v: number | null) {
  if (v == null) return "—";
  if (v >= 10000) return `${(v / 10000).toFixed(1)}萬`;
  return v.toLocaleString("zh-TW");
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
  const [tab, setTab] = useState<"upside" | "recommendations">("upside");
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
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* Tab 切換 */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit mb-5">
        <button
          onClick={() => setTab("upside")}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
            tab === "upside" ? "bg-white text-gray-800 shadow-sm" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          目標價差異
        </button>
        <button
          onClick={() => setTab("recommendations")}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
            tab === "recommendations" ? "bg-white text-gray-800 shadow-sm" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          投顧精選
        </button>
      </div>

      {tab === "recommendations" && <RecommendationsSection />}

      {tab === "upside" && (
      <>
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
                  <th className="px-4 py-3 text-right">成交量<span className="text-gray-400 font-normal">(張)</span></th>
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
                      <td className="px-4 py-3 text-right text-gray-500 tabular-nums">
                        {formatVolume(item.volume)}
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
                  <div className="grid grid-cols-3 gap-2 text-sm text-gray-600 mb-3">
                    <div>
                      <div className="text-xs text-gray-400">現價</div>
                      <div className="tabular-nums">{formatPrice(item.current_price)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400">成交量</div>
                      <div className="tabular-nums">{formatVolume(item.volume)}</div>
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
      </>
      )}
    </div>
  );
}


// ── 投顧精選排行 ─────────────────────────────────────────
// Module-level cache：切換頁面不清空，TTL 1 小時
const _recCache = new Map<string, { items: RecommendationItem[]; warnings: string[]; fetchedAt: Date }>();
const REC_CACHE_TTL = 60 * 60 * 1000;
function recCacheKey(days: number, minReports: number, recFilter: string) { return `${days}_${minReports}_${recFilter}`; }
function getRecCached(days: number, minReports: number, recFilter: string) {
  const entry = _recCache.get(recCacheKey(days, minReports, recFilter));
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt.getTime() > REC_CACHE_TTL) { _recCache.delete(recCacheKey(days, minReports, recFilter)); return null; }
  return entry;
}
const REC_BADGE: Record<string, string> = {
  買進: "bg-red-50 text-red-600 border-red-200",
  Buy: "bg-red-50 text-red-600 border-red-200",
  增持: "bg-red-50 text-red-600 border-red-200",
  持有: "bg-gray-50 text-gray-600 border-gray-300",
  Hold: "bg-gray-50 text-gray-600 border-gray-300",
  中立: "bg-gray-50 text-gray-600 border-gray-300",
  減持: "bg-green-50 text-green-700 border-green-300",
  賣出: "bg-green-50 text-green-700 border-green-300",
  Sell: "bg-green-50 text-green-700 border-green-300",
};

function fmtInst(v: number): string {
  if (!v) return "0";
  const k = v / 1000;
  const sign = v >= 0 ? "+" : "−";
  const abs = Math.abs(k);
  if (abs >= 10) return `${sign}${Math.round(abs).toLocaleString()}K`;
  return `${sign}${abs.toFixed(1)}K`;
}

function ScoreCard({ item, rank, onAskReason }: { item: RecommendationItem; rank: number; onAskReason: () => void }) {
  const borderClr = rank === 1 ? "border-yellow-300" : rank === 2 ? "border-gray-300" : "border-orange-300";
  const scoreClr  = rank === 1 ? "text-yellow-600" : rank === 2 ? "text-gray-500" : "text-orange-500";
  const medal     = rank === 1 ? "🥇" : rank === 2 ? "🥈" : "🥉";
  return (
    <div className={`bg-white rounded-xl border-2 ${borderClr} shadow-sm p-4 space-y-2 relative`}>
      <span className="absolute top-3 right-3 text-2xl">{medal}</span>
      <div>
        <Link to={`/stocks/${item.code}`} state={{ from: "/ranking", label: "排行榜" }}
          className="font-mono text-blue-700 font-semibold hover:underline">{item.code}</Link>
        {item.name && <span className="ml-1 text-gray-500 text-sm">{item.name}</span>}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums">
          {item.current_price ? formatPrice(item.current_price) : "—"}
        </span>
        {item.change_pct != null && (
          <span className={`text-xs font-medium ${item.change_pct >= 0 ? "text-red-500" : "text-green-600"}`}>
            {item.change_pct >= 0 ? "▲" : "▼"} {Math.abs(item.change_pct).toFixed(2)}%
          </span>
        )}
      </div>
      <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
        <span>目標 <span className="font-semibold text-gray-700 tabular-nums">{formatPrice(item.target_price)}</span></span>
        {item.upside_pct != null && (
          <span className={`font-medium ${item.upside_pct >= 0 ? "text-red-500" : "text-green-600"}`}>
            {item.upside_pct >= 0 ? "+" : ""}{item.upside_pct.toFixed(1)}%
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap text-xs">
        {item.latest_recommendation && (
          <span className={`px-1.5 py-0.5 rounded border font-bold ${REC_BADGE[item.latest_recommendation] ?? "bg-gray-100 text-gray-600 border-gray-200"}`}>
            {item.latest_recommendation}
          </span>
        )}
        <span className="text-gray-500">{item.report_count} 篇 · 共識 {item.rec_avg.toFixed(1)}/3</span>
      </div>
      <div className="text-xs text-gray-500">
        法人 {fmtInst(item.inst_5d_net)} · {item.ma_signal ?? "—"} {item.volume_signal ? `+ ${item.volume_signal}` : ""}
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-gray-100">
        <div>
          <div className="text-xs text-gray-400">總分</div>
          <div className={`text-2xl font-bold tabular-nums ${scoreClr}`}>{item.score.toFixed(0)}</div>
        </div>
        <button onClick={onAskReason} className="px-2.5 py-1.5 rounded-lg text-xs bg-purple-100 text-purple-700 hover:bg-purple-200 font-medium">
          💡 推薦理由
        </button>
      </div>
    </div>
  );
}

const REC_PERIOD_OPTIONS = [
  { days: 30, label: "30 天" },
  { days: 60, label: "60 天" },
  { days: 90, label: "90 天" },
];

function RecommendationsSection() {
  const [days, setDays] = useState(30);
  const [minReports, setMinReports] = useState(1);
  const [recFilter, setRecFilter] = useState<"all" | "buy_only">("all");
  const initCached = getRecCached(30, 1, "all");
  const [items, setItems] = useState<RecommendationItem[]>(initCached?.items ?? []);
  const [warnings, setWarnings] = useState<string[]>(initCached?.warnings ?? []);
  const [loading, setLoading] = useState(!initCached);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(initCached?.fetchedAt ?? null);
  const [reasonOpen, setReasonOpen] = useState<RecommendationItem | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [reasonLoading, setReasonLoading] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);

  const generateReason = useCallback(async (code: string) => {
    setReasonText("");
    setReasonError(null);
    setReasonLoading(true);
    try {
      const token = localStorage.getItem("auth_token");
      const resp = await fetch(`/api/stocks/${code}/recommendation-reason`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!resp.ok) {
        const detail = await resp.text();
        throw new Error(detail || `HTTP ${resp.status}`);
      }
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload);
            if (obj.error) { setReasonError(obj.error); continue; }
            if (obj.text) setReasonText((prev) => prev + obj.text);
          } catch {}
        }
      }
    } catch (e: any) {
      setReasonError(e.message || "生成失敗");
    } finally {
      setReasonLoading(false);
    }
  }, []);

  // 開啟 modal 時自動觸發
  useEffect(() => {
    if (reasonOpen) {
      generateReason(reasonOpen.code);
    } else {
      setReasonText("");
      setReasonError(null);
    }
  }, [reasonOpen, generateReason]);

  const fetchData = useCallback(async (force = false) => {
    if (!force) {
      const cached = getRecCached(days, minReports, recFilter);
      if (cached) {
        setItems(cached.items);
        setWarnings(cached.warnings);
        setLastFetched(cached.fetchedAt);
        setLoading(false);
        return;
      }
    }
    setLoading(true);
    setError(null);
    try {
      const data = await stocksApi.recommendations({ days, min_reports: minReports, rec_filter: recFilter, limit: 30 });
      const fetchedAt = new Date();
      _recCache.set(recCacheKey(days, minReports, recFilter), { items: data.items, warnings: data.warnings ?? [], fetchedAt });
      setItems(data.items);
      setWarnings(data.warnings ?? []);
      setLastFetched(fetchedAt);
    } catch (e: any) {
      setError("載入失敗，請稍後再試。");
    } finally {
      setLoading(false);
    }
  }, [days, minReports, recFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const top3 = items.slice(0, 3);
  const rest = items.slice(3);

  return (
    <div className="space-y-4">
      {/* 頁標 + 重整 */}
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">投顧精選</h1>
          <p className="text-sm text-gray-500 mt-1">
            依投顧共識度 + 籌碼面 + 量價綜合評分　·　即時計算
            {lastFetched && (
              <span className="ml-2 text-gray-400">· 更新於 {lastFetched.toLocaleTimeString("zh-TW")}</span>
            )}
          </p>
        </div>
        <button
          onClick={() => fetchData(true)}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {loading ? (
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
          ) : (
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582M20 20v-5h-.581M5.5 9A7.5 7.5 0 0119.5 15M4.5 15A7.5 7.5 0 0118.5 9" />
            </svg>
          )}
          {loading ? "計算中…" : "重新整理"}
        </button>
      </div>

      {/* 篩選列 */}
      <section className="bg-white rounded-xl border border-gray-200 p-3 flex items-center gap-3 flex-wrap text-xs">
        <span className="text-gray-500">期間</span>
        <div className="flex gap-1">
          {REC_PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              onClick={() => setDays(opt.days)}
              className={`px-2.5 py-1 rounded font-medium ${
                days === opt.days ? "bg-blue-100 text-blue-700" : "text-gray-500 hover:bg-gray-50"
              }`}
            >{opt.label}</button>
          ))}
        </div>
        <div className="w-px h-4 bg-gray-200"></div>
        <span className="text-gray-500">最少報告數</span>
        <div className="flex gap-1">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              onClick={() => setMinReports(n)}
              className={`px-2.5 py-1 rounded font-medium ${
                minReports === n ? "bg-blue-100 text-blue-700" : "text-gray-500 hover:bg-gray-50"
              }`}
            >{n}+</button>
          ))}
        </div>
        <div className="w-px h-4 bg-gray-200"></div>
        <span className="text-gray-500">評等</span>
        <div className="flex gap-1">
          <button
            onClick={() => setRecFilter("all")}
            className={`px-2.5 py-1 rounded font-medium ${
              recFilter === "all" ? "bg-blue-100 text-blue-700" : "text-gray-500 hover:bg-gray-50"
            }`}
          >全部</button>
          <button
            onClick={() => setRecFilter("buy_only")}
            className={`px-2.5 py-1 rounded font-medium ${
              recFilter === "buy_only" ? "bg-blue-100 text-blue-700" : "text-gray-500 hover:bg-gray-50"
            }`}
          >只看買進系</button>
        </div>
      </section>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">{error}</div>
      )}

      {warnings.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800 text-xs space-y-1">
          {warnings.map((w, i) => (<div key={i}>⚠️ {w}</div>))}
        </div>
      )}

      {loading && items.length === 0 && (
        <div className="text-center py-12 text-gray-400 text-sm">計算中（要抓現價、訊號、籌碼，約 15-30 秒）…</div>
      )}

      {!loading && items.length === 0 && !error && (
        <div className="text-center py-12 text-gray-400 text-sm">沒有符合條件的個股。</div>
      )}

      {/* Top 3 卡片 */}
      {top3.length > 0 && (
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {top3.map((item, i) => (
            <ScoreCard key={item.code} item={item} rank={i + 1} onAskReason={() => setReasonOpen(item)} />
          ))}
        </section>
      )}

      {/* 完整表格 */}
      {rest.length > 0 && (
        <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="font-semibold text-gray-700">完整排行（共 {items.length} 檔）</h2>
            <span className="text-xs text-gray-400">點列跳到個股頁</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="px-3 py-2 text-center w-10">#</th>
                  <th className="px-3 py-2 text-left">股票</th>
                  <th className="px-3 py-2 text-right">現價</th>
                  <th className="px-3 py-2 text-right">目標價</th>
                  <th className="px-3 py-2 text-right">Upside</th>
                  <th className="px-3 py-2 text-center">評等</th>
                  <th className="px-3 py-2 text-center">報告</th>
                  <th className="px-3 py-2 text-right">法人 5d</th>
                  <th className="px-3 py-2 text-left">訊號</th>
                  <th className="px-3 py-2 text-right">總分</th>
                  <th className="px-3 py-2 text-center"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rest.map((item, i) => {
                  const rank = i + 4;
                  return (
                    <tr key={item.code} className="hover:bg-blue-50">
                      <td className="px-3 py-2 text-center text-gray-400">{rank}</td>
                      <td className="px-3 py-2">
                        <Link to={`/stocks/${item.code}`} state={{ from: "/ranking", label: "排行榜" }}
                          className="font-mono text-blue-700 font-medium hover:underline">{item.code}</Link>
                        {item.name && <span className="ml-1 text-xs text-gray-500">{item.name}</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {item.current_price ? formatPrice(item.current_price) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatPrice(item.target_price)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${
                        item.upside_pct != null && item.upside_pct >= 0 ? "text-red-500" : "text-green-600"
                      }`}>
                        {item.upside_pct != null ? `${item.upside_pct >= 0 ? "+" : ""}${item.upside_pct.toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {item.latest_recommendation && (
                          <span className={`text-xs px-1.5 py-0.5 rounded border font-bold ${REC_BADGE[item.latest_recommendation] ?? "bg-gray-100 text-gray-600 border-gray-200"}`}>
                            {item.latest_recommendation}
                          </span>
                        )}
                        <span className="text-xs text-gray-400 ml-1">{item.rec_avg.toFixed(1)}</span>
                      </td>
                      <td className="px-3 py-2 text-center tabular-nums">{item.report_count}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-medium ${
                        item.inst_5d_net >= 0 ? "text-red-500" : "text-green-600"
                      }`}>{fmtInst(item.inst_5d_net)}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {item.ma_signal ?? "—"}{item.volume_signal ? ` · ${item.volume_signal}` : ""}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-bold text-gray-700">{item.score.toFixed(0)}</td>
                      <td className="px-3 py-2 text-center">
                        <button onClick={() => setReasonOpen(item)} className="text-xs text-purple-600 hover:underline">💡</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* LLM 推薦理由 modal */}
      {reasonOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          onClick={() => setReasonOpen(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-2xl border border-gray-200 max-w-2xl w-full max-h-[80vh] overflow-y-auto"
          >
            {/* Header */}
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between sticky top-0 bg-white rounded-t-2xl">
              <div className="flex items-center gap-2">
                <span className="text-purple-600">💡</span>
                <span className="font-semibold text-gray-800">推薦理由</span>
                <span className="text-sm text-gray-500">·</span>
                <span className="font-mono text-blue-700">{reasonOpen.code}</span>
                {reasonOpen.name && <span className="text-sm text-gray-600">{reasonOpen.name}</span>}
              </div>
              <button
                onClick={() => setReasonOpen(null)}
                className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600 text-lg leading-none"
                aria-label="關閉"
              >×</button>
            </div>

            {/* 即時數據摘要 */}
            <div className="px-5 py-3 bg-gray-50 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <div className="text-gray-400">總分</div>
                <div className="text-lg font-bold text-gray-800 tabular-nums">{reasonOpen.score.toFixed(0)}</div>
              </div>
              <div>
                <div className="text-gray-400">Upside</div>
                <div className={`text-sm font-semibold tabular-nums ${
                  reasonOpen.upside_pct != null && reasonOpen.upside_pct >= 0 ? "text-red-500" : "text-green-600"
                }`}>
                  {reasonOpen.upside_pct != null ? `${reasonOpen.upside_pct >= 0 ? "+" : ""}${reasonOpen.upside_pct.toFixed(1)}%` : "—"}
                </div>
              </div>
              <div>
                <div className="text-gray-400">投顧共識</div>
                <div className="text-sm font-semibold text-gray-700">
                  {reasonOpen.report_count} 篇 · {reasonOpen.rec_avg.toFixed(1)}/3
                </div>
              </div>
              <div>
                <div className="text-gray-400">訊號</div>
                <div className="text-sm font-medium text-gray-700">
                  {reasonOpen.ma_signal ?? "—"}{reasonOpen.volume_signal ? ` · ${reasonOpen.volume_signal}` : ""}
                </div>
              </div>
            </div>

            {/* 評分分解 */}
            <div className="px-5 py-3 border-b border-gray-100 text-xs space-y-1.5">
              <div className="text-gray-500 mb-1">評分分解</div>
              {([
                ["Upside 空間", reasonOpen.score_breakdown.upside, 30, "bg-blue-400"],
                ["投顧共識", reasonOpen.score_breakdown.consensus, 35, "bg-purple-400"],
                ["籌碼配合", reasonOpen.score_breakdown.institutional, 15, "bg-amber-400"],
                ["技術面", reasonOpen.score_breakdown.technical, 20, "bg-green-400"],
              ] as const).map(([label, val, max, color]) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="w-20 text-gray-600">{label}</span>
                  <div className="flex-1 h-2 bg-gray-100 rounded overflow-hidden">
                    <div className={`h-full ${color}`} style={{ width: `${(val / max) * 100}%` }} />
                  </div>
                  <span className="w-14 text-right tabular-nums text-gray-600">{val.toFixed(1)}/{max}</span>
                </div>
              ))}
            </div>

            {/* LLM 推薦理由（streaming） */}
            <div className="px-5 py-4 space-y-3">
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 min-h-[140px]">
                {reasonError ? (
                  <p className="text-sm text-red-600">❌ {reasonError}</p>
                ) : reasonText ? (
                  <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                    {reasonText}
                    {reasonLoading && <span className="inline-block w-1.5 h-4 ml-0.5 bg-purple-400 animate-pulse" />}
                  </p>
                ) : reasonLoading ? (
                  <div className="flex items-center gap-2 text-sm text-purple-600">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    Claude 即時生成中…
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">準備生成…</p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => generateReason(reasonOpen!.code)}
                  disabled={reasonLoading}
                  className="flex-1 px-3 py-2 rounded-lg text-sm bg-purple-600 hover:bg-purple-700 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  {reasonLoading ? "生成中…" : reasonText ? "🔄 重新生成" : "💡 生成推薦理由"}
                </button>
                <Link
                  to={`/stocks/${reasonOpen.code}`}
                  state={{ from: "/ranking", label: "排行榜" }}
                  onClick={() => setReasonOpen(null)}
                  className="px-3 py-2 rounded-lg text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium"
                >看個股頁 →</Link>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 評分說明 */}
      <section className="bg-white rounded-xl border border-gray-200 p-4 text-xs text-gray-500 space-y-1">
        <h4 className="font-medium text-gray-700">評分構成（總分 0–100）</h4>
        <div>· <span className="text-gray-700">Upside 空間</span>：cap +50% 避免極端值灌分　(0–30 分)</div>
        <div>· <span className="text-gray-700">投顧共識</span>：報告數 × 評等平均（買=3、增持=2、持有=1、中立=0、減=-1、賣=-2）　(0–35 分)</div>
        <div>· <span className="text-gray-700">籌碼配合</span>：法人 5 日淨買超（每千張 1 分）　(0–15 分)</div>
        <div>· <span className="text-gray-700">技術面</span>：多頭排列 +10、量增 +10　(0–20 分)</div>
      </section>
    </div>
  );
}

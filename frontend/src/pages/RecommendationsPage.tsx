import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { stocksApi, RecommendationItem } from "../api/client";

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

function formatPrice(price: number) {
  return price.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtInst(v: number): string {
  if (!v) return "0";
  const k = v / 1000;
  const sign = v >= 0 ? "+" : "−";
  const abs = Math.abs(k);
  if (abs >= 10) return `${sign}${Math.round(abs).toLocaleString()}K`;
  return `${sign}${abs.toFixed(1)}K`;
}

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

const REC_PERIOD_OPTIONS = [
  { days: 30, label: "30 天" },
  { days: 60, label: "60 天" },
  { days: 90, label: "90 天" },
];

function ScoreCard({ item, rank, onAskReason }: { item: RecommendationItem; rank: number; onAskReason: () => void }) {
  const borderClr = rank === 1 ? "border-yellow-300" : rank === 2 ? "border-gray-300" : "border-orange-300";
  const scoreClr  = rank === 1 ? "text-yellow-600" : rank === 2 ? "text-gray-500" : "text-orange-500";
  const medal     = rank === 1 ? "🥇" : rank === 2 ? "🥈" : "🥉";
  return (
    <div className={`bg-white rounded-xl border-2 ${borderClr} shadow-sm p-4 space-y-2 relative`}>
      <span className="absolute top-3 right-3 text-2xl">{medal}</span>
      <div>
        <Link to={`/stocks/${item.code}`} state={{ from: "/recommendations", label: "投顧精選" }}
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

export default function RecommendationsPage() {
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
        if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
          throw new Error("後端暫時無法回應，請稍後再試");
        }
        let detail = `HTTP ${resp.status}`;
        try {
          const ct = resp.headers.get("content-type") ?? "";
          if (ct.includes("json")) {
            const j = await resp.json();
            detail = j.detail ?? detail;
          }
        } catch {}
        throw new Error(detail);
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
      const detail = e?.response?.data?.detail ?? e?.message ?? "未知錯誤";
      setError(`載入失敗：${detail}`);
    } finally {
      setLoading(false);
    }
  }, [days, minReports, recFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const top3 = items.slice(0, 3);
  const rest = items.slice(3);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
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
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm flex items-center justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => fetchData(true)} className="text-xs px-2 py-1 rounded border border-red-300 hover:bg-red-100 whitespace-nowrap">重試</button>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800 text-xs space-y-1">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">{warnings.map((w, i) => (<div key={i}>⚠️ {w}</div>))}</div>
            {items.length === 0 && (
              <button onClick={() => fetchData(true)} className="text-xs px-2 py-1 rounded border border-amber-400 hover:bg-amber-100 whitespace-nowrap shrink-0">重試</button>
            )}
          </div>
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
                        <Link to={`/stocks/${item.code}`} state={{ from: "/recommendations", label: "投顧精選" }}
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
            <div className="px-5 py-3 border-b border-gray-100 text-xs space-y-1.5">
              <div className="text-gray-500 mb-1">評分分解</div>
              {([
                ["Upside 空間", reasonOpen.score_breakdown.upside, 30, "bg-blue-400",
                  reasonOpen.upside_pct != null ? `${reasonOpen.upside_pct > 0 ? "+" : ""}${reasonOpen.upside_pct}%` : "—"],
                ["投顧共識", reasonOpen.score_breakdown.consensus, 35, "bg-purple-400",
                  `${reasonOpen.report_count} 篇・${reasonOpen.rec_avg?.toFixed(1) ?? "—"}/3`],
                ["籌碼配合", reasonOpen.score_breakdown.institutional, 15, "bg-amber-400",
                  reasonOpen.inst_5d_net != null
                    ? (reasonOpen.inst_5d_net >= 0
                        ? `買超 +${reasonOpen.inst_5d_net.toLocaleString()}張`
                        : `賣超 ${reasonOpen.inst_5d_net.toLocaleString()}張`)
                    : "無資料"],
                ["技術面", reasonOpen.score_breakdown.technical, 20, "bg-green-400",
                  [reasonOpen.ma_signal, reasonOpen.volume_signal].filter(Boolean).join("・") || "無資料"],
              ] as const).map(([label, val, max, color, hint]) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-gray-600">{label}</span>
                  <div className="flex-1 h-2 bg-gray-100 rounded overflow-hidden">
                    <div className={`h-full ${color}`} style={{ width: `${(val / max) * 100}%` }} />
                  </div>
                  <span className="w-14 shrink-0 text-right tabular-nums text-gray-600">{val.toFixed(1)}/{max}</span>
                  <span className="w-32 shrink-0 text-gray-400 truncate">{hint}</span>
                </div>
              ))}
            </div>
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
                  state={{ from: "/recommendations", label: "投顧精選" }}
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

import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { stocksApi, RecommendationItem } from "../api/client";
import KdjScreener from "../components/KdjScreener";

// ── helpers ──────────────────────────────────────────────────────────────────

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

// ── Cache ─────────────────────────────────────────────────────────────────────

const _recCache = new Map<string, { items: RecommendationItem[]; warnings: string[]; fetchedAt: Date }>();
const REC_CACHE_TTL = 60 * 60 * 1000;

function recCacheKey(days: number, minReports: number, recFilter: string) {
  return `${days}_${minReports}_${recFilter}`;
}
function getRecCached(days: number, minReports: number, recFilter: string) {
  const entry = _recCache.get(recCacheKey(days, minReports, recFilter));
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt.getTime() > REC_CACHE_TTL) {
    _recCache.delete(recCacheKey(days, minReports, recFilter));
    return null;
  }
  return entry;
}

const REC_PERIOD_OPTIONS = [
  { days: 5,  label: "5 天"  },
  { days: 30, label: "30 天" },
  { days: 60, label: "60 天" },
  { days: 90, label: "90 天" },
];

// ── ScoreCard (Top 3) ─────────────────────────────────────────────────────────

function ScoreCard({ item, rank, onAskReason }: { item: RecommendationItem; rank: number; onAskReason: () => void }) {
  const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : "🥉";
  const topBorder =
    rank === 1
      ? "before:bg-gradient-to-r before:from-[#C9A84C] before:to-[#E8C36A]"
      : rank === 2
      ? "before:bg-gradient-to-r before:from-gray-400 before:to-gray-300"
      : "before:bg-gradient-to-r before:from-[#B45309] before:to-[#D97706]";

  const sb = item.score_breakdown;

  const bars: [string, number, number, string][] = [
    ["Upside", sb.upside, 30, "#1B6FD8"],
    ["共識", sb.consensus, 35, "#7C3AED"],
    ["籌碼", sb.institutional, 15, "#F59E0B"],
    ["技術", sb.technical, 20, "#10B981"],
  ];

  return (
    <div className={`bg-white border border-[#DDE2EC] rounded-2xl p-5 relative overflow-hidden hover:shadow-lg transition-shadow
      before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-[3px] ${topBorder}`}>
      {/* rank medal */}
      <span className="absolute top-4 right-4 text-[22px] leading-none">{medal}</span>

      {/* stock id */}
      <Link
        to={`/stocks/${item.code}`}
        state={{ from: "/", label: "投顧精選" }}
        className="font-mono text-[16px] font-bold text-[#1B6FD8] hover:underline"
      >{item.code}</Link>
      {item.name && <div className="text-[18px] text-[#6B7A99] mt-0.5">{item.name}</div>}

      {/* price */}
      <div className="text-[30px] font-bold mt-3 tabular-nums">
        {item.current_price ? formatPrice(item.current_price) : "—"}
      </div>
      {item.change_pct != null && (
        <div className={`text-sm font-semibold mt-0.5 ${item.change_pct >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]"}`}>
          {item.change_pct >= 0 ? "▲" : "▼"} {Math.abs(item.change_pct).toFixed(2)}%
        </div>
      )}

      {/* rec + report count */}
      <div className="flex items-center gap-2 mt-2.5">
        {item.latest_recommendation && (
          <span className={`text-xs font-bold px-2 py-0.5 rounded border ${REC_BADGE[item.latest_recommendation] ?? "bg-gray-100 text-gray-600 border-gray-200"}`}>
            {item.latest_recommendation}
          </span>
        )}
        <span className="text-[13px] text-[#6B7A99]">{item.report_count} 篇 · 共識 {item.rec_avg.toFixed(1)}/3</span>
      </div>

      {/* score badge */}
      <div className="inline-flex items-baseline gap-1 bg-[#EEF3FC] rounded-lg px-2.5 py-1 mt-3">
        <span className="text-2xl font-extrabold text-[#0B1E3D]">{item.score.toFixed(0)}</span>
        <span className="text-xs text-[#6B7A99]">/ 100</span>
      </div>

      {/* mini score bars */}
      <div className="mt-3 flex flex-col gap-2">
        {bars.map(([label, val, max, color]) => (
          <div key={label} className="flex items-center gap-2">
            <span className="text-xs text-[#6B7A99] w-[54px] shrink-0">{label}</span>
            <div className="flex-1 h-1.5 bg-[#EEF0F6] rounded">
              <div className="h-full rounded" style={{ width: `${(val / max) * 100}%`, background: color }} />
            </div>
            <span className="text-xs text-[#6B7A99] w-6 text-right shrink-0">{val.toFixed(0)}</span>
          </div>
        ))}
      </div>

      {/* metrics grid */}
      <div className="grid grid-cols-2 gap-2 mt-3.5 pt-3.5 border-t border-[#DDE2EC]">
        <div>
          <div className="text-xs text-[#6B7A99] uppercase tracking-[0.6px]">目標價</div>
          <div className="text-[15px] font-semibold mt-0.5 tabular-nums">{formatPrice(item.target_price)}</div>
        </div>
        <div>
          <div className="text-xs text-[#6B7A99] uppercase tracking-[0.6px]">上漲空間</div>
          <div className={`text-[15px] font-semibold mt-0.5 tabular-nums ${item.upside_pct != null && item.upside_pct >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]"}`}>
            {item.upside_pct != null ? `${item.upside_pct >= 0 ? "+" : ""}${item.upside_pct.toFixed(1)}%` : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs text-[#6B7A99] uppercase tracking-[0.6px]">法人 5日</div>
          <div className={`text-[15px] font-semibold mt-0.5 tabular-nums ${item.inst_5d_net >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]"}`}>
            {fmtInst(item.inst_5d_net)}
          </div>
        </div>
        <div>
          <div className="text-xs text-[#6B7A99] uppercase tracking-[0.6px]">均線</div>
          <div className="text-[15px] font-semibold mt-0.5 text-[#0D1B2A]">{item.ma_signal ?? "—"}</div>
        </div>
        {item.gain_since_report != null && (
          <div className="col-span-2">
            <div className="text-xs text-[#6B7A99] uppercase tracking-[0.6px]">報告後漲幅</div>
            <div className={`text-[15px] font-semibold mt-0.5 tabular-nums ${item.gain_since_report >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]"}`}>
              {item.gain_since_report >= 0 ? "+" : ""}{item.gain_since_report.toFixed(1)}%
            </div>
          </div>
        )}
      </div>

      {/* ask reason */}
      <div className="mt-3 flex justify-end">
        <button
          onClick={onAskReason}
          className="text-xs px-2.5 py-1.5 rounded-lg bg-purple-50 text-purple-700 hover:bg-purple-100 font-medium transition"
        >
          💡 推薦理由
        </button>
      </div>
    </div>
  );
}

// ── RestCard (rank 4+) ────────────────────────────────────────────────────────

function RestCard({ item, rank, onAskReason }: { item: RecommendationItem; rank: number; onAskReason: () => void }) {
  const maSig = item.ma_signal;
  const volSig = item.volume_signal;
  const hasBullDot = maSig === "多頭排列";
  const hasBearDot = maSig === "空頭排列";
  const hasVolDot = volSig === "量增";
  const upsideCls = item.upside_pct != null && item.upside_pct >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]";

  return (
    <div className="bg-white border border-[#DDE2EC] rounded-xl px-4 py-3
      sm:flex sm:items-center sm:gap-4">

      {/* ── rank + stock id ── */}
      <div className="flex items-center gap-3 sm:w-52 shrink-0 mb-2 sm:mb-0">
        <span className="text-[15px] text-[#6B7A99] font-medium w-5 shrink-0">{rank}</span>
        <div className="min-w-0">
          <Link
            to={`/stocks/${item.code}`}
            state={{ from: "/", label: "投顧精選" }}
            className="font-mono text-[16px] font-bold text-[#1B6FD8] hover:underline"
          >{item.code}</Link>
          {item.name && <div className="text-[18px] text-[#6B7A99] truncate">{item.name}</div>}
        </div>
      </div>

      {/* ── metrics (mobile: 4-col grid / desktop: inline flex) ── */}
      <div className="grid grid-cols-4 gap-1.5 pt-2 border-t border-[#F0F2F6]
        sm:flex sm:gap-6 sm:pt-0 sm:border-0 sm:flex-1">
        <div className="sm:w-20">
          <div className="text-[11px] text-[#6B7A99] sm:hidden">現價</div>
          <div className="text-[13px] font-semibold mt-0.5 tabular-nums">
            {item.current_price ? formatPrice(item.current_price) : "—"}
          </div>
        </div>
        <div className="sm:w-20">
          <div className="text-[11px] text-[#6B7A99] sm:hidden">目標價</div>
          <div className="text-[13px] font-semibold mt-0.5 tabular-nums">{formatPrice(item.target_price)}</div>
        </div>
        <div className="sm:w-20">
          <div className="text-[11px] text-[#6B7A99] sm:hidden">Upside</div>
          <div className={`text-[13px] font-semibold mt-0.5 tabular-nums ${upsideCls}`}>
            {item.upside_pct != null ? `${item.upside_pct >= 0 ? "+" : ""}${item.upside_pct.toFixed(1)}%` : "—"}
          </div>
        </div>
        {item.gain_since_report != null && (
          <div className="sm:w-20">
            <div className="text-[11px] text-[#6B7A99] sm:hidden">報告後</div>
            <div className={`text-[13px] font-semibold mt-0.5 tabular-nums ${item.gain_since_report >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]"}`}>
              {item.gain_since_report >= 0 ? "+" : ""}{item.gain_since_report.toFixed(1)}%
            </div>
          </div>
        )}
        <div className="sm:w-16">
          <div className="text-[11px] text-[#6B7A99] sm:hidden">報告數</div>
          <div className="text-[13px] font-semibold mt-0.5 tabular-nums">{item.report_count} 篇</div>
        </div>
      </div>

      {/* ── rec + signal ── */}
      <div className="flex items-center gap-2 mt-2 sm:mt-0 sm:w-36 shrink-0">
        {item.latest_recommendation && (
          <span className={`text-xs font-bold px-2 py-0.5 rounded border ${REC_BADGE[item.latest_recommendation] ?? "bg-gray-100 text-gray-600 border-gray-200"}`}>
            {item.latest_recommendation}
          </span>
        )}
        <div className="flex items-center gap-1">
          {hasBullDot && <div className="w-2 h-2 rounded-full bg-[#E53935]" />}
          {hasBearDot && <div className="w-2 h-2 rounded-full bg-[#1E8B4A]" />}
          {hasVolDot && <div className="w-2 h-2 rounded-full bg-amber-400" />}
          {(maSig || volSig) && (
            <span className="text-xs text-[#6B7A99]">{[maSig, volSig].filter(Boolean).join("·")}</span>
          )}
        </div>
      </div>

      {/* ── score + reason ── */}
      <div className="flex items-center justify-between mt-2 sm:mt-0 sm:gap-4 shrink-0">
        <div className="text-right sm:w-12">
          <div className="text-[22px] font-extrabold text-[#0B1E3D] tabular-nums leading-none">{item.score.toFixed(0)}</div>
          <div className="text-[11px] text-[#6B7A99]">總分</div>
        </div>
        <button
          onClick={onAskReason}
          className="text-xs font-semibold text-purple-700 bg-purple-50 hover:bg-purple-100 border-none rounded-md px-2.5 py-1.5 transition"
        >
          💡 理由
        </button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function RecommendationsPage() {
  const [tab, setTab] = useState<"rec" | "kdj">("rec");
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
  const [reasonGeneratedAt, setReasonGeneratedAt] = useState<string | null>(null);

  const streamReason = useCallback(async (code: string) => {
    setReasonText("");
    setReasonError(null);
    setReasonGeneratedAt(null);
    setReasonLoading(true);
    let succeeded = false;
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
          if (payload === "[DONE]") { succeeded = true; continue; }
          try {
            const obj = JSON.parse(payload);
            if (obj.error) { setReasonError(obj.error); continue; }
            if (obj.text) setReasonText((prev) => prev + obj.text);
          } catch {}
        }
      }
      // 串流結束後一次性設定日期，避免 React batching 問題
      if (succeeded) setReasonGeneratedAt(new Date().toISOString());
    } catch (e: any) {
      setReasonError(e.message || "生成失敗");
    } finally {
      setReasonLoading(false);
    }
  }, []);

  const loadCachedReason = useCallback(async (code: string) => {
    setReasonText("");
    setReasonError(null);
    setReasonGeneratedAt(null);
    setReasonLoading(true);
    try {
      const token = localStorage.getItem("auth_token");
      const resp = await fetch(`/api/stocks/${code}/recommendation-reason`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (resp.ok) {
        const data = await resp.json();
        setReasonText(data.content ?? "");
        // 後端回傳的是 UTC isoformat（無 Z），補上 Z 確保正確解析
        const raw: string | undefined = data.generated_at;
        setReasonGeneratedAt(raw ? (raw.endsWith("Z") ? raw : raw + "Z") : null);
        setReasonLoading(false);
        return;
      }
    } catch {}
    // 無快取 → 自動生成
    await streamReason(code);
  }, [streamReason]);

  useEffect(() => {
    if (reasonOpen) {
      loadCachedReason(reasonOpen.code);
    } else {
      setReasonText("");
      setReasonError(null);
      setReasonGeneratedAt(null);
    }
  }, [reasonOpen, loadCachedReason]);

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
      const data = await stocksApi.recommendations({ days, min_reports: minReports, rec_filter: recFilter, limit: 30, force });
      const oldComputedAt = data.computed_at;
      const fetchedAt = new Date();
      _recCache.set(recCacheKey(days, minReports, recFilter), { items: data.items, warnings: data.warnings ?? [], fetchedAt });
      setItems(data.items);
      setWarnings(data.warnings ?? []);
      setLastFetched(fetchedAt);

      // force=true 時：背景正在重算，輪詢直到 computed_at 更新
      if (force) {
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          if (attempts > 20) { clearInterval(poll); setLoading(false); return; }
          try {
            const fresh = await stocksApi.recommendations({ days, min_reports: minReports, rec_filter: recFilter, limit: 30 });
            if (fresh.computed_at !== oldComputedAt) {
              clearInterval(poll);
              const ft = new Date();
              _recCache.set(recCacheKey(days, minReports, recFilter), { items: fresh.items, warnings: fresh.warnings ?? [], fetchedAt: ft });
              setItems(fresh.items);
              setWarnings(fresh.warnings ?? []);
              setLastFetched(ft);
              setLoading(false);
            }
          } catch { /* ignore */ }
        }, 5000);
        return; // 不在 finally 清 loading，等輪詢結束
      }
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

  const chipBase = "text-[12px] font-medium px-3 py-[5px] rounded-full border cursor-pointer whitespace-nowrap transition-all";
  const chipActive = "bg-[#0B1E3D] text-white border-[#0B1E3D]";
  const chipInactive = "bg-white text-[#6B7A99] border-[#DDE2EC] hover:text-[#0D1B2A]";

  const tabCls = (t: "rec" | "kdj") =>
    `px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition ${
      tab === t
        ? "text-[#0B1E3D] border-[#0B1E3D]"
        : "text-[#6B7A99] border-transparent hover:text-[#0D1B2A]"
    }`;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">

      {/* ── Page Header + Tabs ── */}
      <div>
        <h1 className="text-[22px] font-bold text-[#0D1B2A]">選股</h1>
        <div className="flex gap-1 mt-3 border-b border-[#DDE2EC]">
          <button className={tabCls("rec")} onClick={() => setTab("rec")}>投顧精選</button>
          <button className={tabCls("kdj")} onClick={() => setTab("kdj")}>KDJ 選股</button>
        </div>
      </div>

      {tab === "kdj" && <KdjScreener />}

      {tab === "rec" && <>

      {/* ── 投顧精選 Filter bar ── */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-[12px] text-[#6B7A99]">
            綜合投顧共識 · 籌碼面 · 技術面評分
            {lastFetched && (
              <span className="ml-2">· 更新於 {lastFetched.toLocaleTimeString("zh-TW")}</span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-[#6B7A99] font-medium">期間</span>
          <div className="flex gap-1">
            {REC_PERIOD_OPTIONS.map((opt) => (
              <button key={opt.days} onClick={() => setDays(opt.days)}
                className={`${chipBase} ${days === opt.days ? chipActive : chipInactive}`}>
                {opt.label}
              </button>
            ))}
          </div>
          <div className="w-px h-[18px] bg-[#DDE2EC]" />
          <span className="text-[11px] text-[#6B7A99] font-medium">最少報告</span>
          <div className="flex gap-1">
            {[1, 2, 3].map((n) => (
              <button key={n} onClick={() => setMinReports(n)}
                className={`${chipBase} ${minReports === n ? chipActive : chipInactive}`}>
                {n}+
              </button>
            ))}
          </div>
          <div className="w-px h-[18px] bg-[#DDE2EC]" />
          <div className="flex gap-1">
            <button onClick={() => setRecFilter("all")}
              className={`${chipBase} ${recFilter === "all" ? chipActive : chipInactive}`}>全部</button>
            <button onClick={() => setRecFilter("buy_only")}
              className={`${chipBase} ${recFilter === "buy_only" ? chipActive : chipInactive}`}>只看買進</button>
          </div>
          <button
            onClick={() => fetchData(true)}
            disabled={loading}
            className="flex items-center gap-1.5 px-3.5 py-[7px] rounded-lg bg-[#1B6FD8] text-white text-[12px] font-semibold hover:bg-[#2480EF] disabled:opacity-50 transition"
          >
            {loading ? (
              <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582M20 20v-5h-.581M5.5 9A7.5 7.5 0 0119.5 15M4.5 15A7.5 7.5 0 0118.5 9" />
              </svg>
            )}
            {loading ? "計算中…" : "重新整理"}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm flex items-center justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => fetchData(true)} className="text-xs px-2 py-1 rounded border border-red-300 hover:bg-red-100 whitespace-nowrap">重試</button>
        </div>
      )}

      {/* Warnings */}
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
        <div className="text-center py-12 text-[#6B7A99] text-sm">計算中（要抓現價、訊號、籌碼，約 15-30 秒）…</div>
      )}

      {!loading && items.length === 0 && !error && (
        <div className="text-center py-12 text-[#6B7A99] text-sm">沒有符合條件的個股。</div>
      )}

      {/* ── Top 3 Cards ── */}
      {top3.length > 0 && (
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {top3.map((item, i) => (
            <ScoreCard key={item.code} item={item} rank={i + 1} onAskReason={() => setReasonOpen(item)} />
          ))}
        </section>
      )}

      {/* ── Rank 4+ list ── */}
      {rest.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[14px] font-bold text-[#0D1B2A]">
              完整排行 <span className="text-[#6B7A99] font-normal text-[13px]">共 {items.length} 檔</span>
            </h2>
            <span className="text-[11px] text-[#6B7A99]">點選查看個股</span>
          </div>

          {/* 桌面表頭（手機隱藏） */}
          <div className="hidden sm:flex items-center gap-4 px-4 py-2 mb-1 rounded-lg bg-[#F8F9FC] border border-[#DDE2EC]">
            <div className="w-52 shrink-0 flex items-center gap-3">
              <span className="w-5" />
              <span className="text-[11px] font-bold text-[#6B7A99] uppercase tracking-wide">股票</span>
            </div>
            <div className="flex gap-6 flex-1">
              <span className="w-20 text-[11px] font-bold text-[#6B7A99] uppercase tracking-wide">現價</span>
              <span className="w-20 text-[11px] font-bold text-[#6B7A99] uppercase tracking-wide">目標價</span>
              <span className="w-20 text-[11px] font-bold text-[#6B7A99] uppercase tracking-wide">Upside</span>
              <span className="w-16 text-[11px] font-bold text-[#6B7A99] uppercase tracking-wide">報告數</span>
            </div>
            <span className="w-36 shrink-0 text-[11px] font-bold text-[#6B7A99] uppercase tracking-wide">評等</span>
            <div className="shrink-0 flex gap-4">
              <span className="w-12 text-right text-[11px] font-bold text-[#6B7A99] uppercase tracking-wide">總分</span>
              <span className="w-14" />
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            {rest.map((item, i) => (
              <RestCard key={item.code} item={item} rank={i + 4} onAskReason={() => setReasonOpen(item)} />
            ))}
          </div>
        </section>
      )}

      {/* ── LLM 推薦理由 Modal ── */}
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
                <span className="font-mono text-[#1B6FD8]">{reasonOpen.code}</span>
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
                <div className={`text-sm font-semibold tabular-nums ${reasonOpen.upside_pct != null && reasonOpen.upside_pct >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]"}`}>
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
                {/* 生成時間標注（右上角） */}
                {reasonGeneratedAt && !reasonLoading && (
                  <p className="text-[10px] text-purple-400 text-right mb-2">
                    生成於 {new Date(reasonGeneratedAt).toLocaleString("zh-TW", {
                      timeZone: "Asia/Taipei",
                      year: "numeric", month: "2-digit", day: "2-digit",
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </p>
                )}
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
                    AI 生成中…
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">準備生成…</p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => streamReason(reasonOpen!.code)}
                  disabled={reasonLoading}
                  className="flex-1 px-3 py-2 rounded-lg text-sm bg-purple-600 hover:bg-purple-700 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  {reasonLoading ? "生成中…" : reasonText ? "🔄 重新生成" : "💡 生成推薦理由"}
                </button>
                <Link
                  to={`/stocks/${reasonOpen.code}`}
                  state={{ from: "/", label: "投顧精選" }}
                  onClick={() => setReasonOpen(null)}
                  className="px-3 py-2 rounded-lg text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium"
                >看個股頁 →</Link>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Scoring note ── */}
      <section className="bg-white border border-[#DDE2EC] rounded-xl p-4 text-[11px] text-[#6B7A99] flex flex-wrap gap-x-6 gap-y-1">
        <span className="font-semibold text-[#0D1B2A]">評分構成（0–100 分）</span>
        <span><span className="font-medium text-[#0D1B2A]">Upside 空間</span> 0–30 分，cap +50%</span>
        <span><span className="font-medium text-[#0D1B2A]">投顧共識</span> 0–35 分，報告數 × 評等平均</span>
        <span><span className="font-medium text-[#0D1B2A]">籌碼配合</span> 0–15 分，法人 5 日淨買超</span>
        <span><span className="font-medium text-[#0D1B2A]">技術面</span> 0–20 分，多頭排列 +10、量增 +10</span>
      </section>

      </>}
    </div>
  );
}


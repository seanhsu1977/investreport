import { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import {
  stocksApi, watchlistApi, fundamentalsApi,
  type Report, type StockPrice, type FundamentalsResponse, type StockSignal,
} from "../api/client";
import RecommendationBadge from "../components/RecommendationBadge";
import ShareButton from "../components/ShareButton";
import { buildShareText, buildShareUrl } from "../utils/share";
import { useAuth } from "../contexts/AuthContext";
import StockLinkedText from "../components/StockLinkedText";
import { usePostMaterials } from "../hooks/usePostMaterials";
import KlineChart from "../components/KlineChart";
import KdjChart from "../components/KdjChart";
import { type KlineResponse } from "../api/client";
import type { ITimeScaleApi, UTCTimestamp } from "lightweight-charts";

// ── constants ─────────────────────────────────────────────────────────────────

const REC_COLOR: Record<string, string> = {
  買進: "bg-green-500",
  Buy: "bg-green-500",
  中立: "bg-yellow-400",
  Hold: "bg-yellow-400",
  賣出: "bg-red-500",
  Sell: "bg-red-500",
};

type StockTabKey = "reports" | "chips" | "tech" | "insight" | "article" | "news";

// ── helpers ───────────────────────────────────────────────────────────────────

function formatPrice(price: number) {
  return price.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── StockPage ─────────────────────────────────────────────────────────────────

export default function StockPage() {
  const { user } = useAuth();
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const backState = location.state as { from?: string; label?: string; recentTab?: string } | null;
  const backPath = backState?.from ?? "/";
  const backLabel = backState?.label ?? "自選股";
  const backNavState = backState?.recentTab ? { tab: backState.recentTab } : undefined;

  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [relatedNews, setRelatedNews] = useState<Report[]>([]);
  const [stockPrice, setStockPrice] = useState<StockPrice | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [inWatchlist, setInWatchlist] = useState(false);
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const [fundamentals, setFundamentals] = useState<FundamentalsResponse | null>(null);
  const [signal, setSignal] = useState<StockSignal | null>(null);
  const [signalLoading, setSignalLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<StockTabKey>("reports");
  const [kline, setKline] = useState<KlineResponse | null>(null);
  const [klineLoading, setKlineLoading] = useState(true);
  const [klineError, setKlineError] = useState(false);
  // time-scale sync between K-line chart and KDJ chart
  const klineTs = useRef<ITimeScaleApi<UTCTimestamp> | null>(null);
  const kdjTs   = useRef<ITimeScaleApi<UTCTimestamp> | null>(null);
  const syncing  = useRef(false);
  const syncCharts = (
    src: ITimeScaleApi<UTCTimestamp>,
    dst: ITimeScaleApi<UTCTimestamp>,
  ) => {
    src.subscribeVisibleLogicalRangeChange((range) => {
      if (syncing.current || !range) return;
      syncing.current = true;
      dst.setVisibleLogicalRange(range);
      syncing.current = false;
    });
  };

  const fetchPrice = () => {
    if (!code) return;
    setPriceLoading(true);
    stocksApi.price(code).then(setStockPrice).catch(() => {}).finally(() => setPriceLoading(false));
  };

  useEffect(() => {
    if (!code) return;
    stocksApi
      .reports(code)
      .then((data) => {
        setReports(data.reports);
        setRelatedNews(data.related_news);
      })
      .finally(() => setLoading(false));
    fetchPrice();
    fundamentalsApi.get(code).then(setFundamentals).catch(() => {});
    setSignalLoading(true);
    stocksApi.batch_signals([code])
      .then((d) => setSignal(d[code] ?? null))
      .catch(() => {})
      .finally(() => setSignalLoading(false));
    setKlineLoading(true);
    setKlineError(false);
    stocksApi.kline(code).then(setKline).catch(() => setKlineError(true)).finally(() => setKlineLoading(false));
    if (user) {
      watchlistApi.get().then((list) => {
        setInWatchlist(list.some((item) => item.stock_code === code));
      });
    }
  }, [code, user]);

  const toggleWatchlist = async () => {
    if (!code) return;
    setWatchlistLoading(true);
    try {
      if (inWatchlist) {
        await watchlistApi.remove(code);
        setInWatchlist(false);
      } else {
        await watchlistApi.add(code, stockName ?? undefined);
        setInWatchlist(true);
      }
    } finally {
      setWatchlistLoading(false);
    }
  };

  const sortedReports = [...reports].sort((a, b) => {
    const da = (a.report_date ?? a.created_at ?? "").slice(0, 10);
    const db = (b.report_date ?? b.created_at ?? "").slice(0, 10);
    if (da > db) return -1;
    if (da < db) return 1;
    return 0;
  });

  const stockName = sortedReports[0]?.stock_name;
  const latest = sortedReports[0];

  // consensus stats
  const buyCount  = sortedReports.filter((r) => ["買進","Buy","增持"].includes(r.recommendation ?? "")).length;
  const holdCount = sortedReports.filter((r) => ["持有","Hold","中立"].includes(r.recommendation ?? "")).length;
  const sellCount = sortedReports.filter((r) => ["賣出","Sell","減持"].includes(r.recommendation ?? "")).length;
  const targets   = sortedReports.map((r) => r.target_price).filter((t): t is number => t != null);
  const avgTarget = targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : null;
  const maxTarget = targets.length ? Math.max(...targets) : null;
  const avgUpside = avgTarget && stockPrice?.price
    ? ((avgTarget / stockPrice.price - 1) * 100)
    : null;

  // upside from latest report
  const latestUpside = latest?.target_price && stockPrice?.price
    ? ((latest.target_price / stockPrice.price - 1) * 100)
    : null;

  // ── 綜合分析分數計算 ─────────────────────────────────────────────────────────
  const insightScores = (() => {
    const instRows = fundamentals?.institutional ?? [];

    // 投顧分 (0-100)
    let brokerScore: number | null = null;
    const brokerPoints: string[] = [];
    const brokerNeg: string[] = [];
    if (sortedReports.length > 0) {
      const totalRec = buyCount + holdCount + sellCount;
      const buyRatioPts = totalRec > 0 ? Math.round((buyCount / totalRec) * 50) : 0;
      const upsidePts = avgUpside == null ? 0
        : avgUpside >= 25 ? 30 : avgUpside >= 15 ? 22 : avgUpside >= 8 ? 14 : avgUpside >= 0 ? 8 : 0;
      const latestDate = latest?.report_date ?? latest?.created_at?.slice(0, 10);
      const daysSinceReport = latestDate
        ? Math.floor((Date.now() - new Date(latestDate).getTime()) / 86400000) : 999;
      const recentPts = daysSinceReport <= 14 ? 20 : daysSinceReport <= 30 ? 14 : daysSinceReport <= 60 ? 6 : 0;
      brokerScore = Math.min(100, buyRatioPts + upsidePts + recentPts);
      if (totalRec > 0 && buyCount / totalRec >= 0.6) brokerPoints.push(`${buyCount} 篇買進（${Math.round(buyCount/totalRec*100)}%）`);
      if (avgUpside != null && avgUpside >= 8) brokerPoints.push(`平均目標漲幅 +${avgUpside.toFixed(1)}%`);
      if (daysSinceReport <= 30) brokerPoints.push(`${daysSinceReport} 天前有新報告`);
      if (totalRec > 0 && sellCount / totalRec >= 0.4) brokerNeg.push(`${sellCount} 篇賣出建議`);
      if (avgUpside != null && avgUpside < 0) brokerNeg.push(`平均目標低於現價`);
      if (daysSinceReport > 60) brokerNeg.push(`最近報告已超過 60 天`);
    }

    // 籌碼分 (0-100)
    let chipScore: number | null = null;
    const chipPoints: string[] = [];
    const chipNeg: string[] = [];
    if (instRows.length >= 3) {
      const rows5 = instRows.slice(0, 5);
      const f5 = rows5.reduce((s, d) => s + d.foreign, 0);
      const t5 = rows5.reduce((s, d) => s + d.trust, 0);
      const de5 = rows5.reduce((s, d) => s + d.dealer, 0);
      const fPts  = f5 > 0 ? 40 : f5 === 0 ? 20 : 0;
      const tPts  = t5 > 0 ? 35 : t5 === 0 ? 17 : 0;
      const dePts = de5 > 0 ? 10 : de5 === 0 ? 5 : 0;
      // 量能 bonus：三方都買超 → +15
      const allBuy = f5 > 0 && t5 > 0 && de5 > 0;
      chipScore = Math.min(100, fPts + tPts + dePts + (allBuy ? 15 : 0));
      if (f5 > 0)  chipPoints.push(`外資 5 日買超 ${f5.toLocaleString()} 張`);
      if (t5 > 0)  chipPoints.push(`投信 5 日買超 ${t5.toLocaleString()} 張`);
      if (de5 > 0) chipPoints.push(`自營商 5 日買超 ${de5.toLocaleString()} 張`);
      if (allBuy)  chipPoints.push("三大法人同步買超");
      if (f5 < 0)  chipNeg.push(`外資 5 日賣超 ${Math.abs(f5).toLocaleString()} 張`);
      if (t5 < 0)  chipNeg.push(`投信 5 日賣超 ${Math.abs(t5).toLocaleString()} 張`);
    }

    // 技術分 (0-100)
    let techScore: number | null = null;
    const techPoints: string[] = [];
    const techNeg: string[] = [];
    if (signal) {
      const maPts = signal.ma_signal === "多頭排列" ? 25 : signal.ma_signal === "空頭排列" ? 0 : 12;
      const rsi = signal.rsi ?? 50;
      const rsiPts = rsi >= 40 && rsi <= 65 ? 20 : (rsi >= 30 && rsi < 40) || (rsi > 65 && rsi <= 75) ? 14 : rsi < 30 ? 18 : 5;
      const kdjSig = signal.kdj_signal ?? "";
      const kdjPts = kdjSig.includes("低位金叉") ? 25 : kdjSig.includes("金叉") ? 15
        : kdjSig.includes("低位死叉") || kdjSig.includes("高位死叉") ? 0 : kdjSig.includes("死叉") ? 5 : 10;
      const volPts = signal.volume_signal === "量增" ? 15 : signal.volume_signal === "量縮" ? 0 : 8;
      const ch5 = signal.price_change_5d ?? 0;
      const ch5Pts = ch5 > 2 ? 15 : ch5 > 0 ? 8 : 0;
      techScore = Math.min(100, maPts + rsiPts + kdjPts + volPts + ch5Pts);
      if (signal.ma_signal === "多頭排列") techPoints.push("均線多頭排列");
      if (rsi < 35) techPoints.push(`RSI ${rsi} 相對低位`);
      if (kdjSig.includes("金叉")) techPoints.push(`KDJ ${kdjSig}`);
      if (signal.volume_signal === "量增") techPoints.push("量能放大");
      if (signal.tower?.color === "陽") techPoints.push(`寶塔線陽（${signal.tower.count}根）`);
      if (ch5 > 2) techPoints.push(`5 日漲 ${ch5}%`);
      if (signal.ma_signal === "空頭排列") techNeg.push("均線空頭排列");
      if (kdjSig.includes("死叉")) techNeg.push(`KDJ ${kdjSig}`);
      if (signal.volume_signal === "量縮") techNeg.push("量能萎縮");
      if (rsi > 75) techNeg.push(`RSI ${rsi} 偏高`);
    }

    // 綜合分
    const scores = [brokerScore, chipScore, techScore];
    const weights = [0.4, 0.3, 0.3];
    const valid = scores.map((s, i) => s != null ? { s: s!, w: weights[i] } : null).filter(Boolean) as { s: number; w: number }[];
    const totalW = valid.reduce((sum, x) => sum + x.w, 0);
    const overall = totalW > 0
      ? Math.round(valid.reduce((sum, x) => sum + x.s * x.w, 0) / totalW)
      : null;

    const verdictInfo = overall == null ? null
      : overall >= 78 ? { text: "多方訊號強烈，積極布局", color: "text-[#DC2626]", bg: "bg-red-50", border: "border-red-200" }
      : overall >= 60 ? { text: "偏多，適合分批進場",      color: "text-[#E95C2E]", bg: "bg-orange-50", border: "border-orange-200" }
      : overall >= 42 ? { text: "訊號中性，建議觀望",      color: "text-[#B45309]", bg: "bg-amber-50",  border: "border-amber-200" }
      : overall >= 25 ? { text: "偏空，謹慎操作",          color: "text-[#15803D]", bg: "bg-green-50",  border: "border-green-200" }
      :                 { text: "空方訊號居多，不建議進場", color: "text-[#15803D]", bg: "bg-green-50",  border: "border-green-200" };

    return { brokerScore, chipScore, techScore, overall, verdictInfo, brokerPoints, brokerNeg, chipPoints, chipNeg, techPoints, techNeg };
  })();

  // beware: RecommendationItem is not available here — we're on the stock page
  // No score_breakdown data on StockPage — hero bars only show if signal exists

  const materials = usePostMaterials();

  // ── Tabs config ──────────────────────────────────────────────────────────────
  const TABS: { key: StockTabKey; label: string }[] = [
    { key: "reports", label: "投顧報告" },
    { key: "chips",   label: "籌碼面" },
    { key: "tech",    label: "技術訊號" },
    { key: "insight", label: "綜合分析" },
    { key: "article", label: "AI 每日稿" },
  ];

  // ── render ───────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#F0F2F6]">

      {/* ── Dark Hero Section ── */}
      <div className="bg-[#122548]">

        {/* top bar */}
        <div className="flex items-center gap-3 px-4 py-3">
          <button
            onClick={() => navigate(backPath, { state: backNavState })}
            className="w-8 h-8 rounded-lg bg-white/8 flex items-center justify-center shrink-0 hover:bg-white/15 transition"
            aria-label="返回"
          >
            <svg className="w-4 h-4 stroke-white/80" fill="none" viewBox="0 0 24 24" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2.5 flex-wrap">
              <a
                href={`https://www.nstock.tw/stock_info?stock_id=${code}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[22px] font-bold text-white hover:text-[#C9A84C] transition font-mono leading-none"
              >{code}</a>
              {stockName && <span className="text-[20px] font-semibold text-white/85 leading-none">{stockName}</span>}
            </div>
            <div className="text-[12px] text-white/55 mt-1">來自：{backLabel}</div>
          </div>
          {/* watchlist button */}
          {user && (
            <button
              onClick={toggleWatchlist}
              disabled={watchlistLoading}
              className="w-8 h-8 rounded-lg bg-white/8 flex items-center justify-center shrink-0 hover:bg-white/15 transition disabled:opacity-50"
              aria-label={inWatchlist ? "移除自選" : "加入自選"}
            >
              <svg className="w-4 h-4" fill={inWatchlist ? "#C9A84C" : "none"} stroke={inWatchlist ? "#C9A84C" : "rgba(255,255,255,0.7)"} viewBox="0 0 24 24" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z" />
              </svg>
            </button>
          )}
        </div>

        {/* price hero */}
        <div className="px-4 pb-5">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[36px] font-extrabold text-white tabular-nums leading-none">
                {stockPrice?.price ? formatPrice(stockPrice.price) : "—"}
              </div>
              <div className={`text-[14px] font-semibold mt-1 ${
                stockPrice?.change != null && stockPrice.change >= 0 ? "text-[#FF6B6B]" : "text-[#4CD964]"
              }`}>
                {stockPrice?.change != null ? (
                  <>
                    {stockPrice.change >= 0 ? "▲" : "▼"} {Math.abs(stockPrice.change)}
                    {stockPrice.change_pct != null && ` (${stockPrice.change >= 0 ? "+" : ""}${stockPrice.change_pct.toFixed(2)}%)`}
                    <button onClick={fetchPrice} disabled={priceLoading}
                      className="ml-2 text-[11px] text-white/30 hover:text-white/60 disabled:opacity-40 transition">
                      {priceLoading ? "…" : "↻"}
                    </button>
                  </>
                ) : "—"}
              </div>
            </div>
            {latest?.recommendation && (
              <span className={`text-[11px] font-bold px-3 py-1 rounded-lg border mt-1 ${
                ["買進","Buy","增持"].includes(latest.recommendation)
                  ? "bg-red-500/15 text-[#FF6B6B] border-red-500/30"
                  : ["賣出","Sell","減持"].includes(latest.recommendation)
                  ? "bg-green-500/15 text-[#4CD964] border-green-500/30"
                  : "bg-white/10 text-white/70 border-white/20"
              }`}>
                {latest.recommendation}
              </span>
            )}
          </div>

          {/* 4-stat row */}
          <div className="flex gap-4 mt-3.5 flex-wrap">
            {latest?.target_price && (
              <div>
                <div className="text-[12px] text-white/65 uppercase tracking-[0.7px]">目標價</div>
                <div className="text-[15px] font-semibold text-white mt-0.5 tabular-nums">{formatPrice(latest.target_price)}</div>
              </div>
            )}
            {latestUpside != null && (
              <div>
                <div className="text-[12px] text-white/65 uppercase tracking-[0.7px]">上漲空間</div>
                <div className={`text-[15px] font-semibold mt-0.5 tabular-nums ${latestUpside >= 0 ? "text-[#FF6B6B]" : "text-[#4CD964]"}`}>
                  {latestUpside >= 0 ? "+" : ""}{latestUpside.toFixed(1)}%
                </div>
              </div>
            )}
            {reports.length > 0 && (
              <div>
                <div className="text-[12px] text-white/65 uppercase tracking-[0.7px]">報告數</div>
                <div className="text-[15px] font-semibold text-white mt-0.5">{reports.length} 篇</div>
              </div>
            )}
            {signal?.current_price && (
              <div>
                <div className="text-[12px] text-white/65 uppercase tracking-[0.7px]">成交量</div>
                <div className="text-[15px] font-semibold text-white mt-0.5 tabular-nums">
                  {/* volume not directly in StockSignal; skip or show RSI */}
                  RSI {signal.rsi ?? "—"}
                </div>
              </div>
            )}
          </div>

          {/* score + mini bars — only show if signal loaded */}
          {signal && (
            <div className="flex items-center justify-between mt-4 pt-3.5 border-t border-white/8">
              <div>
                <div className="flex items-baseline gap-1 bg-white/10 rounded-xl px-3.5 py-1.5">
                  <span className="text-[24px] font-extrabold text-white leading-none tabular-nums">
                    {signal.ma_signal === "多頭排列" ? "↑" : signal.ma_signal === "空頭排列" ? "↓" : "→"}
                  </span>
                </div>
                <div className="text-[11px] text-white/60 mt-1 text-center">{signal.ma_signal ?? "—"}</div>
              </div>
              <div className="flex-1 ml-4 flex flex-col gap-1">
                {[
                  ["RSI", signal.rsi ?? 0, 100, "#1B6FD8"],
                  ["MA趨勢", signal.ma_signal === "多頭排列" ? 80 : signal.ma_signal === "空頭排列" ? 20 : 50, 100, "#7C3AED"],
                  ["量能", signal.volume_signal === "量增" ? 80 : signal.volume_signal === "量縮" ? 20 : 50, 100, "#F59E0B"],
                  ["布林", signal.bb_pct_b != null ? Math.round(signal.bb_pct_b * 100) : 50, 100, "#10B981"],
                ].map(([label, val, max, color]) => (
                  <div key={label as string} className="flex items-center gap-2">
                    <span className="text-[12px] text-white/70 w-12 shrink-0">{label as string}</span>
                    <div className="flex-1 h-[4px] bg-white/15 rounded">
                      <div className="h-full rounded" style={{ width: `${Math.min(100, Math.max(0, ((val as number) / (max as number)) * 100))}%`, background: color as string }} />
                    </div>
                    <span className="text-[12px] text-white/75 w-7 text-right shrink-0 tabular-nums">{typeof val === "number" ? val.toFixed(0) : "—"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Sticky Tab Bar ── */}
      <div className="sticky top-14 z-10 bg-white border-b border-[#DDE2EC] flex overflow-x-auto scrollbar-hide">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-[18px] py-3 text-[13px] font-medium whitespace-nowrap border-b-2 -mb-px shrink-0 transition-all ${
              activeTab === t.key
                ? "text-[#1B6FD8] border-[#1B6FD8] font-semibold"
                : "text-[#6B7A99] border-transparent hover:text-[#0D1B2A]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Tab Content ── */}
      <div className="max-w-3xl mx-auto px-4 py-4 pb-10 space-y-4">

        {/* ── Loading skeleton ── */}
        {loading && (
          <div className="space-y-4 animate-pulse">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="bg-white rounded-xl border border-[#DDE2EC] p-4 space-y-2">
                <div className="h-3 bg-gray-200 rounded w-32" />
                <div className="h-3 bg-gray-100 rounded w-full" />
                <div className="h-3 bg-gray-100 rounded w-4/5" />
              </div>
            ))}
          </div>
        )}

        {/* ════════════════ TAB: 投顧報告 ════════════════ */}
        {!loading && activeTab === "reports" && (
          <>
            {/* Consensus summary card */}
            {reports.length > 0 && (
              <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-[#DDE2EC] flex items-center justify-between">
                  <h3 className="text-[13px] font-bold text-[#0D1B2A]">投顧共識</h3>
                  <span className="text-[11px] text-[#6B7A99]">{reports.length} 篇報告</span>
                </div>
                {/* buy/hold/sell counts */}
                <div className="grid grid-cols-3 px-4 py-3.5 border-b border-[#F0F2F6]">
                  <div className="text-center">
                    <div className="text-[20px] font-extrabold tabular-nums text-[#E53935]">{buyCount}</div>
                    <div className="text-[9px] text-[#6B7A99] uppercase tracking-[0.5px] mt-0.5">買進</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[20px] font-extrabold tabular-nums text-[#6B7A99]">{holdCount}</div>
                    <div className="text-[9px] text-[#6B7A99] uppercase tracking-[0.5px] mt-0.5">持有</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[20px] font-extrabold tabular-nums text-[#1E8B4A]">{sellCount}</div>
                    <div className="text-[9px] text-[#6B7A99] uppercase tracking-[0.5px] mt-0.5">賣出</div>
                  </div>
                </div>
                {/* target price row */}
                <div className="flex items-center justify-around px-4 py-3">
                  <div className="text-center">
                    <div className="text-[9px] text-[#6B7A99] uppercase tracking-[0.5px]">平均目標價</div>
                    <div className="text-[16px] font-bold mt-0.5 tabular-nums">
                      {avgTarget ? formatPrice(avgTarget) : "—"}
                    </div>
                  </div>
                  <div className="w-px h-8 bg-[#DDE2EC]" />
                  <div className="text-center">
                    <div className="text-[9px] text-[#6B7A99] uppercase tracking-[0.5px]">最高目標</div>
                    <div className="text-[16px] font-bold mt-0.5 tabular-nums">
                      {maxTarget ? formatPrice(maxTarget) : "—"}
                    </div>
                  </div>
                  <div className="w-px h-8 bg-[#DDE2EC]" />
                  <div className="text-center">
                    <div className="text-[9px] text-[#6B7A99] uppercase tracking-[0.5px]">平均 Upside</div>
                    <div className={`text-[16px] font-bold mt-0.5 tabular-nums ${avgUpside != null && avgUpside >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]"}`}>
                      {avgUpside != null ? `${avgUpside >= 0 ? "+" : ""}${avgUpside.toFixed(1)}%` : "—"}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Report list */}
            {reports.length === 0 ? (
              <p className="text-[#6B7A99] text-sm py-8 text-center">尚無報告資料</p>
            ) : (
              <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-[#DDE2EC] flex items-center justify-between">
                  <h3 className="text-[13px] font-bold text-[#0D1B2A]">最新報告</h3>
                </div>
                {sortedReports.map((r) => {
                  const upside = r.target_price && stockPrice?.price
                    ? ((r.target_price / stockPrice.price - 1) * 100)
                    : null;
                  const gainSince = r.price_at_report && stockPrice?.price
                    ? ((stockPrice.price / r.price_at_report - 1) * 100)
                    : null;
                  const gain5d = r.price_5d_before && r.price_at_report
                    ? ((r.price_at_report / r.price_5d_before - 1) * 100) : null;
                  const gain10d = r.price_10d_before && r.price_at_report
                    ? ((r.price_at_report / r.price_10d_before - 1) * 100) : null;
                  const gain20d = r.price_20d_before && r.price_at_report
                    ? ((r.price_at_report / r.price_20d_before - 1) * 100) : null;
                  const hasPreStats = gain5d != null || gain10d != null || gain20d != null;
                  return (
                    <div key={r.id} className="px-4 py-3.5 border-b border-[#F5F7FC] last:border-b-0">
                      {/* top row */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          {r.analyst && (
                            <div className="text-[11px] font-bold text-[#1B6FD8]">{r.analyst}</div>
                          )}
                          {r.summary && (
                            <div className="text-[13px] font-medium text-[#0D1B2A] mt-1 leading-snug line-clamp-2">
                              {r.summary.slice(0, 80)}{r.summary.length > 80 ? "…" : ""}
                            </div>
                          )}
                        </div>
                        <div className="text-[10px] text-[#6B7A99] shrink-0 mt-0.5">
                          {(r.report_date ?? r.created_at)?.slice(5, 10)}
                        </div>
                      </div>
                      {/* footer pills */}
                      <div className="flex items-center gap-2 mt-2">
                        <RecommendationBadge value={r.recommendation} />
                        {r.target_price && (
                          <span className="text-[11px] text-[#6B7A99]">
                            目標 <span className="font-semibold text-[#0D1B2A]">{r.target_price}</span>
                          </span>
                        )}
                        {upside != null && (
                          <span className={`text-[11px] font-semibold ${upside >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]"}`}>
                            {upside >= 0 ? "↑ +" : "↓ "}{upside.toFixed(1)}%
                          </span>
                        )}
                        {gainSince != null && (
                          <span className={`text-[11px] px-1.5 py-0.5 rounded font-semibold ${gainSince >= 0 ? "bg-red-50 text-[#E53935]" : "bg-emerald-50 text-[#1E8B4A]"}`}>
                            報告後 {gainSince >= 0 ? "+" : ""}{gainSince.toFixed(1)}%
                          </span>
                        )}
                        <span className="ml-auto">
                          <ShareButton text={buildShareText(r)} url={buildShareUrl(r)} />
                        </span>
                      </div>
                      {/* 報告前漲幅統計 */}
                      {hasPreStats && (
                        <div className="flex items-center gap-3 mt-1.5">
                          <span className="text-[10px] text-[#6B7A99]">報告前</span>
                          {gain5d != null && (
                            <span className="text-[11px] tabular-nums">
                              <span className="text-[#6B7A99]">5日 </span>
                              <span className={`font-semibold ${gain5d >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]"}`}>
                                {gain5d >= 0 ? "+" : ""}{gain5d.toFixed(1)}%
                              </span>
                            </span>
                          )}
                          {gain10d != null && (
                            <span className="text-[11px] tabular-nums">
                              <span className="text-[#6B7A99]">10日 </span>
                              <span className={`font-semibold ${gain10d >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]"}`}>
                                {gain10d >= 0 ? "+" : ""}{gain10d.toFixed(1)}%
                              </span>
                            </span>
                          )}
                          {gain20d != null && (
                            <span className="text-[11px] tabular-nums">
                              <span className="text-[#6B7A99]">20日 </span>
                              <span className={`font-semibold ${gain20d >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]"}`}>
                                {gain20d >= 0 ? "+" : ""}{gain20d.toFixed(1)}%
                              </span>
                            </span>
                          )}
                        </div>
                      )}
                      {/* AI summary block */}
                      {r.key_points.length > 0 && (
                        <div className="mt-2 bg-[#F8F9FE] rounded-lg p-2.5 border-l-2 border-[#1B6FD8]">
                          <div className="text-[11px] text-[#6B7A99] leading-relaxed space-y-0.5">
                            {r.key_points.slice(0, 2).map((pt, j) => (
                              <div key={j}>▸ {pt}</div>
                            ))}
                          </div>
                        </div>
                      )}
                      {/* admin select */}
                      {user?.is_admin && (
                        <label className={`mt-1.5 flex items-center gap-1.5 text-xs cursor-pointer select-none transition ${
                          materials.has(r.id) ? "text-blue-600 font-medium" : "text-gray-400 hover:text-blue-600"
                        }`}>
                          <input
                            type="checkbox"
                            checked={materials.has(r.id)}
                            onChange={() => materials.toggle(r.id)}
                            className="accent-blue-500"
                          />
                          {materials.has(r.id) ? "已選為素材" : "選為貼文素材"}
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Related news */}
            {relatedNews.length > 0 && (
              <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-[#DDE2EC] flex items-center justify-between">
                  <h3 className="text-[13px] font-bold text-[#0D1B2A]">市場新聞</h3>
                  <span className="text-[11px] text-[#6B7A99]">{relatedNews.length} 篇</span>
                </div>
                {relatedNews.map((r) => {
                  const mentionedCodes = r.mentioned_stocks ?? [];
                  const newsLinkState = { from: `/stocks/${code}`, label: stockName ?? code ?? "個股", recentTab: "news" };
                  return (
                    <div key={r.id} className="px-4 py-3.5 border-b border-[#F5F7FC] last:border-b-0">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[10px] px-2 py-0.5 rounded bg-orange-50 text-orange-600 font-medium border border-orange-200">
                          {r.analyst ?? "市場新聞"}
                        </span>
                        <span className="text-[10px] text-[#6B7A99]">
                          {(r.report_date ?? r.created_at)?.slice(0, 10)}
                        </span>
                      </div>
                      {r.summary && (
                        <p className="text-sm text-[#0D1B2A] leading-relaxed">
                          <StockLinkedText text={r.summary} mentionedStocks={mentionedCodes} linkState={newsLinkState} />
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ════════════════ TAB: 籌碼面 ════════════════ */}
        {!loading && activeTab === "chips" && (
          <>
            {(fundamentals?.institutional && fundamentals.institutional.length > 0) ? (
              <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-[#DDE2EC] flex items-center justify-between">
                  <h3 className="text-[13px] font-bold text-[#0D1B2A]">籌碼面</h3>
                </div>
                {/* 2×3 chip grid from institutional data */}
                {(() => {
                  const latest = fundamentals!.institutional![0];
                  const items: [string, number, string?][] = [
                    ["外資 5 日", fundamentals!.institutional!.slice(0, 5).reduce((s, d) => s + d.foreign, 0)],
                    ["投信 5 日", fundamentals!.institutional!.slice(0, 5).reduce((s, d) => s + d.trust, 0)],
                    ["自營 5 日", fundamentals!.institutional!.slice(0, 5).reduce((s, d) => s + d.dealer, 0)],
                    ["外資昨日", latest.foreign, latest.date.slice(5)],
                    ["投信昨日", latest.trust, latest.date.slice(5)],
                    ["合計昨日", latest.total, latest.date.slice(5)],
                  ];
                  return (
                    <div className="grid grid-cols-2">
                      {items.map(([label, val, sub], idx) => {
                        const isRight = idx % 2 !== 0;
                        const isLastRow = idx >= items.length - 2;
                        return (
                          <div key={label as string}
                            className={`px-4 py-3.5 ${!isRight ? "border-r border-[#F0F2F6]" : ""} ${!isLastRow ? "border-b border-[#F0F2F6]" : ""}`}>
                            <div className="text-[9px] text-[#6B7A99] uppercase tracking-[0.5px]">{label as string}</div>
                            <div className={`text-[16px] font-bold mt-1 tabular-nums ${(val as number) >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]"}`}>
                              {(val as number) >= 0 ? "+" : ""}{(val as number).toLocaleString()}
                            </div>
                            {sub && <div className="text-[10px] text-[#6B7A99] mt-0.5">張　{sub as string}</div>}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                {/* institutional table */}
                <div className="border-t border-[#DDE2EC] px-4 py-3">
                  <p className="text-[11px] text-[#6B7A99] mb-2">法人買賣超（張）</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[#6B7A99]">
                          <th className="text-left py-1 pr-3 font-normal">日期</th>
                          <th className="text-right py-1 px-2 font-normal">外資</th>
                          <th className="text-right py-1 px-2 font-normal">投信</th>
                          <th className="text-right py-1 px-2 font-normal">自營</th>
                          <th className="text-right py-1 pl-2 font-normal">合計</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fundamentals!.institutional!.map((row) => {
                          const fmt = (v: number) => {
                            const abs = Math.abs(v);
                            const s = abs >= 1000 ? `${(abs / 1000).toFixed(0)}千` : String(abs);
                            return v >= 0 ? `+${s}` : `-${s}`;
                          };
                          const cls = (v: number) => v >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]";
                          return (
                            <tr key={row.date} className="border-t border-gray-50">
                              <td className="py-1 pr-3 text-[#6B7A99]">{row.date.slice(5)}</td>
                              <td className={`py-1 px-2 text-right tabular-nums font-medium ${cls(row.foreign)}`}>{fmt(row.foreign)}</td>
                              <td className={`py-1 px-2 text-right tabular-nums font-medium ${cls(row.trust)}`}>{fmt(row.trust)}</td>
                              <td className={`py-1 px-2 text-right tabular-nums font-medium ${cls(row.dealer)}`}>{fmt(row.dealer)}</td>
                              <td className={`py-1 pl-2 text-right tabular-nums font-semibold ${cls(row.total)}`}>{fmt(row.total)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-white border border-[#DDE2EC] rounded-2xl p-6 text-center text-[#6B7A99] text-sm">
                目前無籌碼資料
              </div>
            )}

            {/* revenue */}
            {fundamentals?.revenue && (() => {
              const r = fundamentals.revenue!;
              const fmtB = (v: number) => `${(v / 100000).toFixed(0)}億`;
              const pctCls = (v: number | null) => v == null ? "" : v >= 0 ? "text-[#E53935]" : "text-[#1E8B4A]";
              const pctStr = (v: number | null) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
              return (
                <div className="bg-white border border-[#DDE2EC] rounded-2xl p-4">
                  <p className="text-[11px] text-[#6B7A99] mb-2">月營收（{r.year}/{r.month}月）</p>
                  <div className="flex items-center gap-4 flex-wrap text-sm">
                    <span className="font-semibold text-[#0D1B2A]">{fmtB(r.revenue)}</span>
                    <span className="text-[#6B7A99]">YoY <span className={`font-medium ${pctCls(r.yoy_pct)}`}>{pctStr(r.yoy_pct)}</span></span>
                    <span className="text-[#6B7A99]">MoM <span className={`font-medium ${pctCls(r.mom_pct)}`}>{pctStr(r.mom_pct)}</span></span>
                    <span className="text-xs text-[#6B7A99]">累計 {fmtB(r.ytd)} YoY <span className={`font-medium ${pctCls(r.ytd_yoy_pct)}`}>{pctStr(r.ytd_yoy_pct)}</span></span>
                  </div>
                </div>
              );
            })()}
          </>
        )}

        {/* ════════════════ TAB: 技術訊號 ════════════════ */}
        {!loading && activeTab === "tech" && (
          <>
            {/* K-line Chart */}
            <div className="bg-white border border-[#DDE2EC] rounded-xl overflow-hidden mb-4">
              <div className="px-4 py-3 border-b border-[#DDE2EC] flex items-center justify-between">
                <h3 className="text-[13px] font-bold text-[#0D1B2A]">日 K 線</h3>
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-[#F59E0B] inline-block"/>MA5</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-[#3B82F6] inline-block"/>MA10</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-[#A855F7] inline-block"/>MA20</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-[#10B981] inline-block"/>MA60</span>
                </div>
              </div>
              {klineLoading ? (
                <div className="h-[300px] flex items-center justify-center bg-[#122548]">
                  <svg className="animate-spin h-6 w-6 text-white/40" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                </div>
              ) : kline && kline.candles.length > 0 ? (
                <KlineChart {...kline} onTimeScaleReady={(ts) => {
                  klineTs.current = ts;
                  if (kdjTs.current) {
                    syncCharts(ts, kdjTs.current);
                    syncCharts(kdjTs.current, ts);
                  }
                }} />
              ) : (
                <div className="h-[300px] flex flex-col items-center justify-center gap-3 bg-[#122548] text-white/40 text-sm">
                  <span>無法載入 K 線資料</span>
                  {klineError && (
                    <button
                      onClick={() => {
                        if (!code) return;
                        setKlineLoading(true);
                        setKlineError(false);
                        stocksApi.kline(code).then(setKline).catch(() => setKlineError(true)).finally(() => setKlineLoading(false));
                      }}
                      className="px-3 py-1 rounded text-xs bg-white/10 hover:bg-white/20 text-white/60 transition"
                    >
                      重試
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* ── KDJ Chart ── */}
            {!klineLoading && kline && kline.kdj_k.length > 0 && (
              <div className="bg-white border border-[#DDE2EC] rounded-xl overflow-hidden mb-4">
                {/* KDJ header */}
                <div className="px-4 py-3 border-b border-[#DDE2EC] flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[13px] font-bold text-[#0D1B2A]">KDJ</h3>
                    <span className="text-[11px] text-[#6B7A99]">RSV=89 · K權重 1/9 · D權重 1/12</span>
                  </div>
                  <div className="flex items-center gap-3 text-[11px]">
                    <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-[#3B82F6] inline-block"/>K</span>
                    <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-[#F59E0B] inline-block"/>D</span>
                    <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-[#A78BFA] inline-block"/>J</span>
                  </div>
                </div>

                {/* Current KDJ values */}
                <div className="px-4 py-2 bg-[#0F1E35] grid grid-cols-3 gap-2 text-center text-[11px]">
                  {([
                    ["K", kline.kdj_cur_k, "#3B82F6"],
                    ["D", kline.kdj_cur_d, "#F59E0B"],
                    ["J", kline.kdj_cur_j, "#A78BFA"],
                  ] as [string, number | null, string][]).map(([label, val, color]) => (
                    <div key={label}>
                      <span style={{ color }} className="font-bold">{label} </span>
                      <span className={`font-mono font-semibold text-[12px] ${
                        val == null ? "text-white/40" :
                        val >= 90  ? "text-[#FCA5A5]" :
                        val >= 80  ? "text-[#EF4444]" :
                        val <= 10  ? "text-[#86EFAC]" :
                        val <= 20  ? "text-[#22C55E]" : "text-white"
                      }`}>
                        {val != null ? val.toFixed(1) : "—"}
                      </span>
                    </div>
                  ))}
                </div>

                <KdjChart kdj_k={kline.kdj_k} kdj_d={kline.kdj_d} kdj_j={kline.kdj_j}
                  onTimeScaleReady={(ts) => {
                    kdjTs.current = ts;
                    if (klineTs.current) {
                      syncCharts(ts, klineTs.current);
                      syncCharts(klineTs.current, ts);
                    }
                  }}
                />

                {/* K=10/20/80/90 price estimates */}
                {kline.kdj_k10_price != null && kline.kdj_k90_price != null && (
                  <div className="px-3 py-3 border-t border-[#DDE2EC] grid grid-cols-5 text-[11px]">
                    {([
                      ["K=10", kline.kdj_k10_price,  "#16A34A", "text-[#16A34A]"],
                      ["K=20", kline.kdj_k20_price,  "#16A34A", "text-[#16A34A]"],
                      ["90-10 差距", kline.kdj_k90_price! - kline.kdj_k10_price!, null, "text-[#0D1B2A]"],
                      ["K=80", kline.kdj_k80_price,  "#DC2626", "text-[#DC2626]"],
                      ["K=90", kline.kdj_k90_price,  "#DC2626", "text-[#DC2626]"],
                    ] as [string, number | null, string | null, string][]).map(([label, val, , cls], i, arr) => (
                      <div key={label} className={`text-center ${i > 0 && i < arr.length ? "border-l border-[#DDE2EC]" : ""}`}>
                        <div className="text-[10px] text-[#6B7A99] mb-0.5">{label}</div>
                        <div className={`font-bold tabular-nums text-[13px] ${cls}`}>
                          {val != null ? formatPrice(val) : "—"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {(signalLoading || signal) ? (
              <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-[#DDE2EC]">
                  <h3 className="text-[13px] font-bold text-[#0D1B2A]">技術訊號</h3>
                </div>
                {signalLoading && !signal ? (
                  <div className="animate-pulse p-4 space-y-2">
                    <div className="h-4 bg-gray-100 rounded w-48" />
                    <div className="h-3 bg-gray-100 rounded w-full" />
                  </div>
                ) : signal ? (
                  <div>
                    {/* signal rows */}
                    {[
                      { name: "均線排列", badge: signal.ma_signal,
                        bull: signal.ma_signal === "多頭排列", bear: signal.ma_signal === "空頭排列" },
                      { name: "成交量", badge: signal.volume_signal,
                        bull: signal.volume_signal === "量增", bear: signal.volume_signal === "量縮" },
                      ...(signal.rsi != null ? [{
                        name: "RSI (14)",
                        badge: `${signal.rsi} ${signal.rsi >= 70 ? "超買" : signal.rsi <= 30 ? "超賣" : "中性"}`,
                        bull: signal.rsi >= 70, bear: signal.rsi <= 30,
                      }] : []),
                      ...(signal.bb_signal ? [{ name: "布林通道", badge: signal.bb_signal,
                        bull: false, bear: false }] : []),
                      ...(signal.kdj_signal ? [{ name: "KDJ (89,9,12)",
                        badge: `${signal.kdj_signal}${signal.kdj_cross_days != null && signal.kdj_cross_days > 0 ? `（${signal.kdj_cross_days}天前）` : ""}  K${signal.kdj_k} D${signal.kdj_d}`,
                        bull: signal.kdj_signal === "低位金叉" || signal.kdj_signal === "金叉",
                        bear: signal.kdj_signal === "低位死叉" || signal.kdj_signal === "高位死叉" || signal.kdj_signal === "死叉" }] : []),
                      ...(signal.tower ? [{ name: "寶塔線",
                        badge: `${signal.tower.signal}（${signal.tower.count}根）`,
                        bull: signal.tower.color === "陽", bear: signal.tower.color === "陰" }] : []),
                      ...(signal.price_change_5d != null ? [{
                        name: "5日漲跌",
                        badge: `${signal.price_change_5d >= 0 ? "+" : ""}${signal.price_change_5d}%`,
                        bull: signal.price_change_5d > 0, bear: signal.price_change_5d < 0,
                      }] : []),
                    ].map((row) => (
                      <div key={row.name} className="flex items-center justify-between px-4 py-2.5 border-b border-[#F5F7FC] last:border-b-0">
                        <span className="text-[12px] font-medium text-[#0D1B2A]">{row.name}</span>
                        <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full ${
                          row.bull ? "bg-[#FEF2F2] text-[#DC2626]" :
                          row.bear ? "bg-[#F0FDF4] text-[#16A34A]" :
                          "bg-[#F3F4F6] text-[#6B7280]"
                        }`}>
                          {row.badge ?? "—"}
                        </span>
                      </div>
                    ))}

                    {/* MA values */}
                    {signal.ma_position && (
                      <div className="px-4 py-3 border-t border-[#DDE2EC]">
                        <div className="text-[11px] font-semibold text-[#0D1B2A] mb-1.5">{signal.ma_position}</div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#6B7A99]">
                          <span>MA5 <span className="text-[#0D1B2A] font-medium tabular-nums">{signal.ma5}</span></span>
                          {signal.ma10 != null && <span>MA10 <span className="text-[#0D1B2A] font-medium tabular-nums">{signal.ma10}</span></span>}
                          <span>MA20 <span className="text-[#0D1B2A] font-medium tabular-nums">{signal.ma20}</span></span>
                          {signal.ma60 != null && <span>MA60 <span className="text-[#0D1B2A] font-medium tabular-nums">{signal.ma60}</span></span>}
                        </div>
                      </div>
                    )}

                    {/* support / resistance */}
                    {(signal.resistance.length > 0 || signal.support.length > 0) && (
                      <div className="px-4 py-3 border-t border-[#DDE2EC] flex flex-wrap gap-4 text-xs text-[#6B7A99]">
                        {signal.resistance.length > 0 && (
                          <span className="flex items-center gap-1">
                            壓力
                            {signal.resistance.map((v) => (
                              <span key={v} className="px-1.5 py-0.5 rounded bg-red-50 text-[#E53935] border border-red-100 tabular-nums font-medium">{v}</span>
                            ))}
                          </span>
                        )}
                        {signal.support.length > 0 && (
                          <span className="flex items-center gap-1">
                            支撐
                            {signal.support.map((v) => (
                              <span key={v} className="px-1.5 py-0.5 rounded bg-green-50 text-[#1E8B4A] border border-green-100 tabular-nums font-medium">{v}</span>
                            ))}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="bg-white border border-[#DDE2EC] rounded-2xl p-6 text-center text-[#6B7A99] text-sm">
                目前無技術訊號資料
              </div>
            )}
          </>
        )}

        {/* ════════════════ TAB: 綜合分析 ════════════════ */}
        {!loading && activeTab === "insight" && (() => {
          const { brokerScore, chipScore, techScore, overall, verdictInfo, brokerPoints, brokerNeg, chipPoints, chipNeg, techPoints, techNeg } = insightScores;

          const ScoreRing = ({ score, color }: { score: number | null; color: string }) => {
            if (score == null) return <div className="text-[11px] text-[#6B7A99]">無資料</div>;
            const r = 22, circ = 2 * Math.PI * r;
            const dash = (score / 100) * circ;
            return (
              <svg width="60" height="60" viewBox="0 0 60 60" className="-rotate-90">
                <circle cx="30" cy="30" r={r} fill="none" stroke="#E8ECF4" strokeWidth="5" />
                <circle cx="30" cy="30" r={r} fill="none" stroke={color} strokeWidth="5"
                  strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round" />
                <text x="30" y="36" textAnchor="middle" className="rotate-90"
                  style={{ fontSize: 14, fontWeight: 700, fill: color, transform: "rotate(90deg)", transformOrigin: "30px 30px" }}>
                  {score}
                </text>
              </svg>
            );
          };

          const dims = [
            { key: "broker", label: "投顧共識", score: brokerScore, color: "#1B6FD8", points: brokerPoints, neg: brokerNeg },
            { key: "chip",   label: "法人籌碼", score: chipScore,   color: "#7C3AED", points: chipPoints,  neg: chipNeg  },
            { key: "tech",   label: "技術訊號", score: techScore,   color: "#F59E0B", points: techPoints,  neg: techNeg  },
          ];

          return (
            <>
              {/* Overall verdict card */}
              <div className={`bg-white border rounded-2xl overflow-hidden mb-4 ${verdictInfo?.border ?? "border-[#DDE2EC]"}`}>
                <div className="px-5 py-5">
                  <div className="flex items-center gap-5">
                    {/* big score */}
                    <div className="relative flex-shrink-0">
                      {(() => {
                        const score = overall;
                        if (score == null) return <div className="w-20 h-20 rounded-full border-4 border-[#DDE2EC] flex items-center justify-center text-[#6B7A99] text-xs">待計算</div>;
                        const r = 34, circ = 2 * Math.PI * r, dash = (score / 100) * circ;
                        const col = score >= 78 ? "#DC2626" : score >= 60 ? "#E95C2E" : score >= 42 ? "#D97706" : "#15803D";
                        return (
                          <svg width="88" height="88" viewBox="0 0 88 88">
                            <circle cx="44" cy="44" r={r} fill="none" stroke="#E8ECF4" strokeWidth="7" />
                            <circle cx="44" cy="44" r={r} fill="none" stroke={col} strokeWidth="7"
                              strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round"
                              transform="rotate(-90 44 44)" />
                            <text x="44" y="49" textAnchor="middle" style={{ fontSize: 22, fontWeight: 800, fill: col }}>{score}</text>
                          </svg>
                        );
                      })()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] text-[#6B7A99] mb-1">綜合進場評估</div>
                      {verdictInfo ? (
                        <div className={`text-[17px] font-extrabold ${verdictInfo.color} leading-snug`}>{verdictInfo.text}</div>
                      ) : (
                        <div className="text-[15px] font-bold text-[#6B7A99]">資料載入中…</div>
                      )}
                      <div className="text-[11px] text-[#6B7A99] mt-1">投顧×0.4 ＋ 籌碼×0.3 ＋ 技術×0.3</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Three dimension cards */}
              <div className="grid grid-cols-3 gap-3 mb-4">
                {dims.map((d) => (
                  <div key={d.key} className="bg-white border border-[#DDE2EC] rounded-xl p-3 flex flex-col items-center gap-1">
                    <div className="text-[10px] text-[#6B7A99] font-medium">{d.label}</div>
                    <ScoreRing score={d.score} color={d.color} />
                    <div className="text-[10px] text-[#6B7A99] text-center">/ 100</div>
                  </div>
                ))}
              </div>

              {/* Pros / Cons */}
              {dims.some((d) => d.points.length > 0 || d.neg.length > 0) && (
                <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden mb-4">
                  <div className="px-4 py-3 border-b border-[#DDE2EC]">
                    <h3 className="text-[13px] font-bold text-[#0D1B2A]">訊號明細</h3>
                  </div>
                  <div className="divide-y divide-[#F5F7FC]">
                    {dims.map((d) => (
                      (d.points.length > 0 || d.neg.length > 0) && (
                        <div key={d.key} className="px-4 py-3">
                          <div className="text-[11px] font-semibold mb-1.5" style={{ color: d.color }}>{d.label}</div>
                          <div className="space-y-1">
                            {d.points.map((pt) => (
                              <div key={pt} className="flex items-start gap-1.5 text-[12px] text-[#0D1B2A]">
                                <span className="text-[#DC2626] mt-0.5">▲</span>{pt}
                              </div>
                            ))}
                            {d.neg.map((pt) => (
                              <div key={pt} className="flex items-start gap-1.5 text-[12px] text-[#0D1B2A]">
                                <span className="text-[#1E8B4A] mt-0.5">▼</span>{pt}
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    ))}
                  </div>
                </div>
              )}

              {/* Entry zone */}
              {(signal?.support?.length || signal?.resistance?.length || kline?.kdj_k10_price) && (
                <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#DDE2EC]">
                    <h3 className="text-[13px] font-bold text-[#0D1B2A]">進場參考區間</h3>
                  </div>
                  <div className="px-4 py-3 space-y-3">
                    {stockPrice?.price && (
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="text-[#6B7A99]">現價</span>
                        <span className="font-bold tabular-nums text-[#0D1B2A]">{formatPrice(stockPrice.price)}</span>
                      </div>
                    )}
                    {kline?.kdj_k10_price != null && kline?.kdj_k20_price != null && (
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="text-[#6B7A99]">KDJ 低位參考（K=10~20）</span>
                        <span className="font-bold tabular-nums text-[#15803D]">
                          {formatPrice(kline.kdj_k10_price)} ~ {formatPrice(kline.kdj_k20_price)}
                        </span>
                      </div>
                    )}
                    {kline?.kdj_k80_price != null && kline?.kdj_k90_price != null && (
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="text-[#6B7A99]">KDJ 高位參考（K=80~90）</span>
                        <span className="font-bold tabular-nums text-[#DC2626]">
                          {formatPrice(kline.kdj_k80_price)} ~ {formatPrice(kline.kdj_k90_price)}
                        </span>
                      </div>
                    )}
                    {(signal?.support?.length ?? 0) > 0 && (
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="text-[#6B7A99]">技術支撐</span>
                        <div className="flex gap-1.5">
                          {signal!.support.map((v) => (
                            <span key={v} className="px-1.5 py-0.5 rounded bg-green-50 text-[#1E8B4A] border border-green-100 tabular-nums font-medium">{v}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {(signal?.resistance?.length ?? 0) > 0 && (
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="text-[#6B7A99]">技術壓力</span>
                        <div className="flex gap-1.5">
                          {signal!.resistance.map((v) => (
                            <span key={v} className="px-1.5 py-0.5 rounded bg-red-50 text-[#E53935] border border-red-100 tabular-nums font-medium">{v}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {avgTarget != null && (
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="text-[#6B7A99]">投顧平均目標價</span>
                        <span className="font-bold tabular-nums text-[#1B6FD8]">{formatPrice(avgTarget)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          );
        })()}

        {/* ════════════════ TAB: AI 每日稿 ════════════════ */}
        {!loading && activeTab === "article" && (
          <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#DDE2EC]">
              <h3 className="text-[13px] font-bold text-[#0D1B2A]">AI 每日稿</h3>
            </div>
            <div className="p-6 text-center text-[#6B7A99] text-sm space-y-2">
              <div className="text-2xl">📰</div>
              <p>AI 每日稿功能需由管理員在後台生成。</p>
              <p className="text-xs text-[#6B7A99]">請至管理員頁面查看今日草稿。</p>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

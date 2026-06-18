import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { etfTrackerApi, EtfStock, EtfCrossItem, EtfCrossData } from "../api/client";

// ──────────────────────────────────────────────────────────────────────
// 工具函式
// ──────────────────────────────────────────────────────────────────────

function tpeToday(): string {
  const now = new Date();
  const tpe = new Date(now.getTime() + 8 * 3600 * 1000);
  return tpe.toISOString().slice(0, 10);
}

function fmtDate(iso: string): string {
  // "2026-06-09" → "6/9"
  const [, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}`;
}

/** 往前/後移一個交易日（跳過週六日） */
function shiftTradingDay(iso: string, delta: 1 | -1): string {
  const d = new Date(iso + "T00:00:00Z");
  do {
    d.setUTCDate(d.getUTCDate() + delta);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

// ──────────────────────────────────────────────────────────────────────
// 股票卡片
// ──────────────────────────────────────────────────────────────────────

function StockCard({
  stock,
  highlight = false,
  compact = false,
}: {
  stock: EtfStock;
  highlight?: boolean;
  compact?: boolean;
}) {
  const isBuy = stock.action === "buy";
  const isSell = stock.action === "sell";
  const absDelta = Math.abs(stock.shares_delta);
  const sign = isBuy ? "+" : isSell ? "−" : "";
  const deltaColor = isBuy
    ? "text-green-600"
    : isSell
    ? "text-red-500"
    : "text-gray-400";

  const consecutiveBg =
    stock.consecutive_buy_days >= 5
      ? "bg-red-100 text-red-700"
      : stock.consecutive_buy_days >= 3
      ? "bg-orange-100 text-orange-700"
      : "bg-blue-50 text-blue-600";

  return (
    <div
      className={`flex items-center justify-between rounded-xl border px-4 transition
        ${compact ? "py-2" : "py-3"}
        ${highlight
          ? "bg-amber-50 border-amber-200"
          : "bg-white border-gray-200"
        }`}
    >
      {/* Left: code + name + badges */}
      <div className="flex items-center gap-2 min-w-0">
        <Link
          to={`/stocks/${stock.code}`}
          className="text-sm font-bold text-blue-700 hover:underline shrink-0"
        >
          {stock.code}
        </Link>
        <span className="text-sm text-gray-700 truncate">{stock.name}</span>
        {stock.is_new && (
          <span className="shrink-0 text-[10px] font-bold bg-amber-400 text-white px-1.5 py-0.5 rounded">
            NEW
          </span>
        )}
      </div>

      {/* Right: consecutive badge + delta */}
      <div className="flex items-center gap-2 shrink-0 ml-2">
        {isBuy && stock.consecutive_buy_days > 1 && (
          <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${consecutiveBg}`}>
            連{stock.consecutive_buy_days}天
          </span>
        )}
        {!compact && stock.price != null && (
          <span className="text-xs text-gray-400 tabular-nums w-14 text-right">
            {stock.price.toLocaleString()}
          </span>
        )}
        <span className={`text-sm font-bold tabular-nums w-20 text-right ${deltaColor}`}>
          {sign}{absDelta.toLocaleString()}張
        </span>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 主頁面
// ──────────────────────────────────────────────────────────────────────

const ETF_OPTIONS = [
  { code: "00981A", name: "中信優選成長高股息" },
  { code: "00403A", name: "00403A" },
] as const;

type PageMode = "etf" | "cross";

export default function EtfTrackerPage() {
  const [mode, setMode] = useState<PageMode>("etf");
  const [etfCode, setEtfCode] = useState<string>("00981A");
  const etfName = ETF_OPTIONS.find((e) => e.code === etfCode)?.name ?? etfCode;

  const [date, setDate] = useState(tpeToday);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [data, setData] = useState<{
    etf_code: string;
    date: string;
    stocks: EtfStock[];
    has_data: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);
  const [showFlat, setShowFlat] = useState(false);

  // 交叉分析
  const [crossDays, setCrossDays] = useState<3 | 5>(3);
  const [crossData, setCrossData] = useState<EtfCrossData | null>(null);
  const [crossLoading, setCrossLoading] = useState(false);

  // 載入已有日期清單；若今日尚無資料，自動切到最新可用日期
  const refreshDates = useCallback(async () => {
    try {
      const r = await etfTrackerApi.dates(etfCode);
      setAvailableDates(r.dates);
      if (r.dates.length > 0 && !r.dates.includes(tpeToday())) {
        setDate(r.dates[0]); // dates 降冪，[0] = 最新
      }
    } catch {
      // ignore
    }
  }, [etfCode]);

  useEffect(() => {
    refreshDates();
  }, [refreshDates]);

  // 載入當前日期資料
  const loadData = useCallback(async (targetDate: string) => {
    setLoading(true);
    try {
      const r = await etfTrackerApi.daily(etfCode, targetDate);
      setData(r);
    } finally {
      setLoading(false);
    }
  }, [etfCode]);

  useEffect(() => {
    loadData(date);
  }, [date, loadData]);

  useEffect(() => {
    if (mode !== "cross") return;
    setCrossLoading(true);
    etfTrackerApi.cross(crossDays)
      .then(setCrossData)
      .finally(() => setCrossLoading(false));
  }, [mode, crossDays]);

  // 日期導覽：以交易日曆為基準，不限於已同步日期，上限為今日
  const today = tpeToday();
  const hasPrev = true;  // 往過去永遠可以走
  const hasNext = date < today;  // 往未來只到今日

  const goPrev = () => setDate(shiftTradingDay(date, -1));
  const goNext = () => { if (hasNext) setDate(shiftTradingDay(date, 1)); };

  // 同步單日
  const handleSync = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      await etfTrackerApi.sync(etfCode, date);
      await loadData(date);
      await refreshDates();
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? (e as Error)?.message
        ?? "同步失敗";
      setSyncError(msg);
    } finally {
      setSyncing(false);
    }
  };

  // 回補 10 天
  const handleBackfill = async () => {
    setBackfilling(true);
    setBackfillMsg(null);
    try {
      const r = await etfTrackerApi.backfill(etfCode, 10);
      setBackfillMsg(`回補完成：成功 ${r.synced} 天，無文章 ${r.no_article} 天${r.errors > 0 ? `，錯誤 ${r.errors} 天` : ""}`);
      await refreshDates();
      await loadData(date);
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? (e as Error)?.message
        ?? "回補失敗";
      setBackfillMsg(`✗ ${msg}`);
    } finally {
      setBackfilling(false);
    }
  };

  // 分組
  const newStocks = (data?.stocks ?? []).filter((s) => s.is_new);
  const buys = (data?.stocks ?? []).filter((s) => s.action === "buy");
  const sells = (data?.stocks ?? []).filter((s) => s.action === "sell");
  const flats = (data?.stocks ?? []).filter((s) => s.action === "flat");

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* ── Header ── */}
      <div className="bg-[#0B1E3D] text-white px-4 py-4">
        <div className="max-w-xl mx-auto">
          <p className="text-xs text-white/60 mb-0.5">ETF 買超追蹤</p>
          <h1 className="text-lg font-bold leading-tight">
            {etfCode}
            <span className="ml-2 text-sm font-normal text-white/70">{etfName}</span>
          </h1>
          {/* ETF 切換 */}
          <div className="flex gap-2 mt-2.5">
            {ETF_OPTIONS.map((opt) => (
              <button
                key={opt.code}
                onClick={() => {
                  setMode("etf");
                  if (opt.code !== etfCode) {
                    setEtfCode(opt.code);
                    setData(null);
                    setSyncError(null);
                    setBackfillMsg(null);
                  }
                }}
                className={`text-xs px-3 py-1 rounded-full font-semibold transition
                  ${mode === "etf" && etfCode === opt.code
                    ? "bg-white text-[#0B1E3D]"
                    : "bg-white/15 text-white/70 hover:bg-white/25"
                  }`}
              >
                {opt.code}
              </button>
            ))}
            <button
              onClick={() => setMode("cross")}
              className={`text-xs px-3 py-1 rounded-full font-semibold transition
                ${mode === "cross"
                  ? "bg-amber-400 text-white"
                  : "bg-white/15 text-white/70 hover:bg-white/25"
                }`}
            >
              交叉分析
            </button>
          </div>
        </div>
      </div>

      {/* ── 日期導覽列（ETF 模式才顯示）── */}
      {mode === "etf" && <div className="bg-white border-b shadow-sm sticky top-0 z-10">
        <div className="max-w-xl mx-auto px-4 py-2.5 flex items-center justify-between">
          {/* 日期箭頭 */}
          <div className="flex items-center gap-1">
            <button
              onClick={goPrev}
              disabled={!hasPrev}
              className="w-8 h-8 flex items-center justify-center rounded-full text-lg text-gray-600 hover:bg-gray-100 disabled:opacity-25 disabled:cursor-default transition"
              title="上一天"
            >
              ‹
            </button>
            <span className="font-mono text-sm font-semibold text-gray-800 px-1 min-w-[88px] text-center">
              {date}
            </span>
            <button
              onClick={goNext}
              disabled={!hasNext}
              className="w-8 h-8 flex items-center justify-center rounded-full text-lg text-gray-600 hover:bg-gray-100 disabled:opacity-25 disabled:cursor-default transition"
              title="下一天"
            >
              ›
            </button>
          </div>

          {/* 同步按鈕 */}
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg font-medium disabled:opacity-50 transition"
          >
            {syncing ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a10 10 0 100 10H4z"/>
                </svg>
                同步中…
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                </svg>
                同步 {fmtDate(date)}
              </>
            )}
          </button>
        </div>
        {syncError && (
          <div className="max-w-xl mx-auto px-4 pb-2 text-xs text-red-600">
            ✗ {syncError}
          </div>
        )}
      </div>}

      {/* ── 內容區 ── */}
      <div className="max-w-xl mx-auto px-4 py-4 space-y-5">

        {/* ── 交叉分析模式 ── */}
        {mode === "cross" && (
          <CrossAnalysisView
            days={crossDays}
            onChangeDays={setCrossDays}
            data={crossData}
            loading={crossLoading}
          />
        )}

        {/* ── ETF 模式 ── */}
        {/* Loading */}
        {mode === "etf" && loading && (
          <div className="flex items-center justify-center py-16 text-gray-400 text-sm gap-2">
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a10 10 0 100 10H4z"/>
            </svg>
            讀取中…
          </div>
        )}

        {/* 無資料 */}
        {mode === "etf" && !loading && data && !data.has_data && (
          <div className="text-center py-14 text-gray-500">
            <p className="text-sm mb-1">尚無 {date} 的持股資料</p>
            <p className="text-xs text-gray-400 mb-4">nstock 通常在每個交易日 19:30 後更新</p>
            <div className="flex flex-col items-center gap-2">
              <button
                onClick={handleSync}
                className="text-blue-600 text-sm font-medium hover:underline"
              >
                同步此日
              </button>
              <button
                onClick={handleBackfill}
                disabled={backfilling}
                className="text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50"
              >
                {backfilling ? "回補中…" : "回補最近 10 天"}
              </button>
            </div>
            {backfillMsg && (
              <p className="mt-3 text-xs text-gray-600">{backfillMsg}</p>
            )}
          </div>
        )}

        {/* ── 有資料 ── */}
        {mode === "etf" && !loading && data?.has_data && (
          <>
            {/* 統計列 */}
            <div className="flex gap-3 text-center">
              <StatChip label="買超" value={buys.length} color="green" />
              <StatChip label="賣超" value={sells.length} color="red" />
              <StatChip label="持平" value={flats.length} color="gray" />
              {newStocks.length > 0 && (
                <StatChip label="新標的" value={newStocks.length} color="amber" />
              )}
            </div>

            {/* 🆕 新進標的 */}
            {newStocks.length > 0 && (
              <Section title="🆕 新進標的" count={newStocks.length} titleColor="text-amber-700">
                {newStocks.map((s) => (
                  <StockCard key={s.code} stock={s} highlight />
                ))}
              </Section>
            )}

            {/* 📈 買超 */}
            {buys.length > 0 && (
              <Section title="📈 買超" count={buys.length} titleColor="text-green-700">
                {buys.map((s) => (
                  <StockCard key={s.code} stock={s} />
                ))}
              </Section>
            )}

            {/* 📉 賣超 */}
            {sells.length > 0 && (
              <Section title="📉 賣超" count={sells.length} titleColor="text-red-600">
                {sells.map((s) => (
                  <StockCard key={s.code} stock={s} />
                ))}
              </Section>
            )}

            {/* 持平（可展開） */}
            {flats.length > 0 && (
              <div>
                <button
                  onClick={() => setShowFlat(!showFlat)}
                  className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 transition py-1"
                >
                  <span className="text-xs">{showFlat ? "▾" : "▸"}</span>
                  持平 {flats.length} 檔
                </button>
                {showFlat && (
                  <div className="mt-2 space-y-1.5">
                    {flats.map((s) => (
                      <StockCard key={s.code} stock={s} compact />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 回補入口 */}
            <div className="pt-2 border-t border-gray-200 flex items-center justify-between">
              <button
                onClick={handleBackfill}
                disabled={backfilling}
                className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-50 transition"
              >
                {backfilling ? "回補中…" : "↺ 回補最近 10 天歷史"}
              </button>
              {backfillMsg && (
                <span className="text-xs text-gray-500">{backfillMsg}</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 小元件
// ──────────────────────────────────────────────────────────────────────

function Section({
  title,
  count,
  titleColor,
  children,
}: {
  title: string;
  count: number;
  titleColor: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className={`text-sm font-semibold mb-2 flex items-center gap-1 ${titleColor}`}>
        {title}
        <span className="ml-1 text-xs font-normal opacity-70">({count})</span>
      </h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 交叉分析元件
// ──────────────────────────────────────────────────────────────────────

function CrossAnalysisView({
  days,
  onChangeDays,
  data,
  loading,
}: {
  days: 3 | 5;
  onChangeDays: (d: 3 | 5) => void;
  data: EtfCrossData | null;
  loading: boolean;
}) {
  return (
    <div className="space-y-4">
      {/* 近3天 / 近5天 切換 */}
      <div className="flex gap-2">
        {([3, 5] as const).map((d) => (
          <button
            key={d}
            onClick={() => onChangeDays(d)}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition
              ${days === d
                ? "bg-amber-400 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
          >
            近{d}天
          </button>
        ))}
        {data && (
          <span className="text-xs text-gray-400 self-center ml-1">
            {data.start_date} 起
          </span>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16 text-gray-400 text-sm gap-2">
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a10 10 0 100 10H4z"/>
          </svg>
          分析中…
        </div>
      )}

      {!loading && data && (
        <>
          {/* 雙重買超 */}
          {data.both.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold mb-2 text-amber-700 flex items-center gap-1">
                雙重買超
                <span className="ml-1 text-xs font-normal opacity-70">({data.both.length})</span>
                <span className="text-[10px] text-amber-500 font-normal ml-1">兩檔 ETF 同時買超</span>
              </h2>
              <div className="space-y-2">
                {data.both.map((s) => <CrossCard key={s.code} item={s} mode="both" />)}
              </div>
            </section>
          )}

          {data.both.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-6">近{days}天無雙重買超個股</p>
          )}

          {/* 僅 00981A */}
          {data.only_00981A.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold mb-2 text-blue-700 flex items-center gap-1">
                僅 00981A
                <span className="ml-1 text-xs font-normal opacity-70">({data.only_00981A.length})</span>
              </h2>
              <div className="space-y-1.5">
                {data.only_00981A.map((s) => <CrossCard key={s.code} item={s} mode="981a" />)}
              </div>
            </section>
          )}

          {/* 僅 00403A */}
          {data.only_00403A.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold mb-2 text-green-700 flex items-center gap-1">
                僅 00403A
                <span className="ml-1 text-xs font-normal opacity-70">({data.only_00403A.length})</span>
              </h2>
              <div className="space-y-1.5">
                {data.only_00403A.map((s) => <CrossCard key={s.code} item={s} mode="403a" />)}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function CrossCard({ item, mode }: { item: EtfCrossItem; mode: "both" | "981a" | "403a" }) {
  const borderCls =
    mode === "both" ? "border-amber-200 bg-amber-50" :
    mode === "981a" ? "border-blue-100 bg-white" :
    "border-green-100 bg-white";

  return (
    <div className={`flex items-center justify-between rounded-xl border px-4 py-2.5 ${borderCls}`}>
      <div className="flex items-center gap-2 min-w-0">
        <Link
          to={`/stocks/${item.code}`}
          className="text-sm font-bold text-blue-700 hover:underline shrink-0"
        >
          {item.code}
        </Link>
        <span className="text-sm text-gray-700 truncate">{item.name}</span>
      </div>
      <div className="flex items-center gap-3 shrink-0 ml-2 text-xs tabular-nums">
        {item.days_00981A > 0 && (
          <span className="text-blue-600">
            981A {item.days_00981A}天 +{item.shares_00981A}張
          </span>
        )}
        {item.days_00403A > 0 && (
          <span className="text-green-600">
            403A {item.days_00403A}天 +{item.shares_00403A}張
          </span>
        )}
      </div>
    </div>
  );
}

function StatChip({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: "green" | "red" | "gray" | "amber";
}) {
  const cls = {
    green: "bg-green-50 text-green-700 border-green-200",
    red: "bg-red-50 text-red-600 border-red-200",
    gray: "bg-gray-100 text-gray-500 border-gray-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
  }[color];
  return (
    <div className={`flex-1 rounded-lg border py-2 text-center ${cls}`}>
      <div className="text-lg font-bold leading-none">{value}</div>
      <div className="text-[11px] mt-0.5 opacity-80">{label}</div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Cell,
} from "recharts";
import { chipsApi, stocksApi, type ChipSnapshot, type InstitutionPosition, type KlineResponse } from "../api/client";
import KlineChart from "../components/KlineChart";
import KdjChart from "../components/KdjChart";
import type { ITimeScaleApi, UTCTimestamp } from "lightweight-charts";

type Direction = "long" | "short" | "neutral";

function dirOfNet(net: number | undefined): Direction {
  if (net === undefined || net === 0) return "neutral";
  return net > 0 ? "long" : "short";
}

function dirOfSpot(amount: number | undefined): Direction {
  if (amount === undefined || amount === 0) return "neutral";
  return amount > 0 ? "long" : "short";
}

function fmt(n: number | null | undefined, opts?: { sign?: boolean; decimals?: number }): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  const decimals = opts?.decimals ?? 0;
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  if (opts?.sign && n > 0) return `+${abs}`;
  if (n < 0) return `-${abs}`;
  return abs;
}

function ChangeBadge({ change }: { change: number | null | undefined }) {
  if (change === null || change === undefined || change === 0) {
    return <span className="text-xs text-gray-400">—</span>;
  }
  const positive = change > 0;
  return (
    <span
      className={`text-xs font-medium inline-flex items-center gap-0.5 ${
        positive ? "text-rose-500" : "text-emerald-600"
      }`}
    >
      <span>{positive ? "▲" : "▼"}</span>
      <span>{Math.abs(change).toLocaleString()}</span>
    </span>
  );
}

function DirectionPill({ dir }: { dir: Direction }) {
  if (dir === "long") {
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-rose-50 text-rose-500 font-medium">
        多方
      </span>
    );
  }
  if (dir === "short") {
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 font-medium">
        空方
      </span>
    );
  }
  return (
    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">
      —
    </span>
  );
}

function MiniChip({ dir }: { dir: Direction }) {
  if (dir === "long") {
    return (
      <span className="inline-flex w-6 h-6 items-center justify-center rounded text-xs font-bold bg-rose-500 text-white">
        多
      </span>
    );
  }
  if (dir === "short") {
    return (
      <span className="inline-flex w-6 h-6 items-center justify-center rounded text-xs font-bold bg-emerald-500 text-white">
        空
      </span>
    );
  }
  return (
    <span className="inline-flex w-6 h-6 items-center justify-center rounded text-xs font-bold bg-gray-200 text-gray-500">
      —
    </span>
  );
}

function InstitutionRow({
  label,
  data,
  bgAccent,
}: {
  label: string;
  data: InstitutionPosition | null;
  bgAccent: "long" | "short" | "neutral";
}) {
  const dir = dirOfNet(data?.net_oi);
  const accentBar =
    bgAccent === "long"
      ? "bg-rose-500"
      : bgAccent === "short"
      ? "bg-emerald-500"
      : "bg-gray-300";
  return (
    <div className="bg-gray-50 rounded-xl flex items-center gap-3 pl-0 pr-4 py-3 overflow-hidden">
      <span className={`w-1.5 self-stretch rounded-l-xl ${accentBar}`} />
      <div className="flex-1 flex items-center gap-2 min-w-0">
        <span className="font-semibold text-gray-800 shrink-0">{label}</span>
        <DirectionPill dir={dir} />
      </div>
      <div className="text-right shrink-0">
        <div className="font-bold text-gray-900 text-base">
          <span className={dir === "long" ? "text-rose-500" : dir === "short" ? "text-emerald-600" : ""}>
            {data ? Math.abs(data.net_oi).toLocaleString() : "-"}
          </span>
          <span className="text-xs font-normal text-gray-500 ml-1">口</span>
        </div>
        <div className="text-xs">
          <ChangeBadge change={data?.net_change} />
        </div>
      </div>
    </div>
  );
}

function SpotRow({ label, value }: { label: string; value: number }) {
  const dir = dirOfSpot(value);
  const accentBar =
    dir === "long" ? "bg-rose-500" : dir === "short" ? "bg-emerald-500" : "bg-gray-300";
  const tone =
    dir === "long" ? "text-rose-500" : dir === "short" ? "text-emerald-600" : "text-gray-500";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return (
    <div className="bg-gray-50 rounded-xl flex items-center gap-3 pl-0 pr-4 py-3 overflow-hidden">
      <span className={`w-1.5 self-stretch rounded-l-xl ${accentBar}`} />
      <div className="flex-1 flex items-center gap-2 min-w-0">
        <span className="font-semibold text-gray-800 shrink-0">{label}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${dir === "long" ? "bg-rose-50 text-rose-500" : dir === "short" ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-500"}`}>
          {dir === "long" ? "買超" : dir === "short" ? "賣超" : "—"}
        </span>
      </div>
      <div className="text-right shrink-0">
        <div className={`font-bold text-base ${tone}`}>
          {sign}
          {Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          <span className="text-xs font-normal text-gray-500 ml-1">億</span>
        </div>
      </div>
    </div>
  );
}

/* ============================ Card 1: 法人 vs 散戶總覽 ============================ */

function OverviewCard({
  snap,
  history,
}: {
  snap: ChipSnapshot;
  history: ChipSnapshot[];
}) {
  const { taiex, txf } = snap;
  const txfList: { key: string; label: string; data: InstitutionPosition | null }[] = [
    { key: "foreign", label: "外資", data: txf.foreign },
    { key: "trust", label: "投信", data: txf.trust },
    { key: "dealer", label: "自營商", data: txf.dealer },
  ];

  // 法人近期方向（取最近 10 個交易日，依日期升冪）
  const dirHistory = history.slice(-10);

  return (
    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-6 space-y-5">
      <div>
        <p className="text-xs text-blue-600 font-medium mb-1">📅 {snap.date}</p>
        <h2 className="text-2xl font-bold text-gray-900">
          台指期 <span className="text-blue-500">法人</span>{" "}
          <span className="text-gray-400">vs</span>{" "}
          <span className="text-blue-500">散戶</span>
        </h2>
      </div>

      {/* 加權指數 */}
      {taiex && (
        <section>
          <h3 className="text-xs text-gray-500 mb-2 flex items-center gap-1">
            <span>📈</span> 加權指數收盤
          </h3>
          <div className="bg-gray-50 rounded-xl flex items-center gap-3 pl-0 pr-4 py-3 overflow-hidden">
            <span className={`w-1.5 self-stretch rounded-l-xl ${taiex.change >= 0 ? "bg-rose-500" : "bg-emerald-500"}`} />
            <span className="flex-1 font-semibold text-gray-800">🚩 加權指數</span>
            <div className="flex items-center gap-2">
              <span className={`text-2xl font-bold ${taiex.change >= 0 ? "text-rose-500" : "text-emerald-600"}`}>
                {taiex.close.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className={`text-sm font-medium ${taiex.change >= 0 ? "text-rose-500" : "text-emerald-600"}`}>
                {taiex.change >= 0 ? "▲" : "▼"} {Math.abs(taiex.change).toFixed(2)} ({Math.abs(taiex.change_pct).toFixed(2)}%)
              </span>
            </div>
          </div>
        </section>
      )}

      {/* === 期貨組 === */}
      <div className="rounded-2xl border border-blue-100 bg-blue-50/40 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500 text-white font-bold tracking-wide">
            期貨
          </span>
          <span className="text-xs text-gray-500">FUTURES（口數，淨未平倉）</span>
        </div>

        <section>
          <h3 className="text-xs text-gray-500 mb-2 flex items-center gap-1">
            <span>📊</span> 台指期貨法人未平倉
          </h3>
          <div className="space-y-2">
            {txfList.map((item) => (
              <InstitutionRow
                key={item.key}
                label={item.label}
                data={item.data}
                bgAccent={dirOfNet(item.data?.net_oi)}
              />
            ))}
          </div>
        </section>

        {dirHistory.length > 0 && (
          <section className="bg-white/70 rounded-xl p-3">
            <h3 className="text-xs text-gray-500 mb-2 flex items-center gap-1">
              <span>⌛</span> 期貨法人近期方向
            </h3>
            <div className="space-y-1.5">
              {(["foreign", "trust", "dealer"] as const).map((key) => {
                const label = key === "foreign" ? "外資" : key === "trust" ? "投信" : "自營商";
                return (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-xs text-gray-600 w-12 shrink-0">{label}</span>
                    <div className="flex gap-1">
                      {dirHistory.map((h) => (
                        <MiniChip key={h.date} dir={dirOfNet(h.txf[key]?.net_oi)} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {/* === 現貨組 === */}
      {snap.spot && (
        <div className="rounded-2xl border border-amber-100 bg-amber-50/40 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500 text-white font-bold tracking-wide">
              現貨
            </span>
            <span className="text-xs text-gray-500">SPOT（億 NTD，淨買賣超）</span>
          </div>

          <section>
            <h3 className="text-xs text-gray-500 mb-2 flex items-center gap-1">
              <span>💰</span> 三大法人現貨買賣超
            </h3>
            <div className="space-y-2">
              {(["foreign", "trust", "dealer"] as const).map((key) => {
                const label = key === "foreign" ? "外資" : key === "trust" ? "投信" : "自營商";
                const value = snap.spot![key];
                return <SpotRow key={key} label={label} value={value} />;
              })}
            </div>
          </section>

          {dirHistory.length > 0 && dirHistory.some((h) => h.spot) && (
            <section className="bg-white/70 rounded-xl p-3">
              <h3 className="text-xs text-gray-500 mb-2 flex items-center gap-1">
                <span>⌛</span> 現貨法人近期方向
              </h3>
              <div className="space-y-1.5">
                {(["foreign", "trust", "dealer"] as const).map((key) => {
                  const label = key === "foreign" ? "外資" : key === "trust" ? "投信" : "自營商";
                  return (
                    <div key={key} className="flex items-center gap-2">
                      <span className="text-xs text-gray-600 w-12 shrink-0">{label}</span>
                      <div className="flex gap-1">
                        {dirHistory.map((h) => (
                          <MiniChip key={h.date} dir={dirOfSpot(h.spot?.[key])} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function RetailDirectionStrip({ history }: { history: ChipSnapshot[] }) {
  // 散戶方向：retail_ratio > 0 → 多, < 0 → 空
  const list = history.map((h) => (h.tmf.retail_ratio >= 0 ? "long" : "short") as Direction);
  // 計算結尾連續做空/多天數
  const last = list[list.length - 1];
  let streak = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] === last) streak += 1;
    else break;
  }
  const streakLabel = last === "short" ? "做空" : "做多";

  return (
    <div className="bg-emerald-50 rounded-xl p-3 mt-2">
      <p className="text-xs text-emerald-700 font-medium mb-2">
        近{history.length}個交易日，連續{streakLabel} {streak} 天
      </p>
      <div className="flex gap-1">
        {list.map((dir, i) => (
          <MiniChip key={i} dir={dir} />
        ))}
      </div>
    </div>
  );
}

/* ============================ Card 2: 微台散戶多空比詳細 ============================ */

function RetailDetailCard({
  snap,
  history,
}: {
  snap: ChipSnapshot;
  history: ChipSnapshot[];
}) {
  const { tmf } = snap;
  // 第一筆記錄僅作為 retail_ratio_change 的基準，不納入統計區間
  const series = history.slice(1);
  const ratios = series.map((h) => h.tmf.retail_ratio);
  const max = ratios.length ? Math.max(...ratios) : 0;
  const min = ratios.length ? Math.min(...ratios) : 0;

  const chartData = series.map((h) => ({
    date: h.date.slice(5).replace("-", "/"),
    ratio: h.tmf.retail_ratio,
    close: h.tmf.close,
  }));

  const dirHistory = history.slice(-10);
  const ratioPct = tmf.retail_ratio_change !== undefined && tmf.retail_ratio !== 0
    ? Math.abs(tmf.retail_ratio_change / (tmf.retail_ratio - tmf.retail_ratio_change) * 100)
    : null;

  return (
    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-blue-600 font-medium mb-1">📅 {snap.date}</p>
          <h2 className="text-2xl font-bold text-gray-900">微台散戶多空比</h2>
        </div>
        <span className="text-xs px-2.5 py-1 rounded-full bg-orange-50 text-orange-500 font-medium">
          ● 籌碼面
        </span>
      </div>

      {/* 散戶多空比 + 收盤價 */}
      <div className="space-y-3">
        <div className="bg-white border border-gray-200 rounded-2xl p-4 flex items-center justify-between">
          <span className="font-semibold text-gray-800 flex items-center gap-2">
            <span className={`w-1.5 h-6 rounded-full ${tmf.retail_ratio >= 0 ? "bg-rose-500" : "bg-emerald-500"}`}></span>
            ⚖️ 散戶多空比
          </span>
          <div className="text-right">
            <div className={`text-3xl font-bold ${tmf.retail_ratio >= 0 ? "text-rose-500" : "text-emerald-600"}`}>
              {tmf.retail_ratio.toFixed(2)}
            </div>
            <div className="text-xs">
              {tmf.retail_ratio_change !== undefined && (
                <span className={`font-medium ${tmf.retail_ratio_change >= 0 ? "text-rose-500" : "text-emerald-600"}`}>
                  {tmf.retail_ratio_change >= 0 ? "▲" : "▼"} {Math.abs(tmf.retail_ratio_change).toFixed(2)}
                  {ratioPct !== null && ` (${ratioPct.toFixed(2)}%)`}
                </span>
              )}
            </div>
          </div>
        </div>
        {tmf.close !== null && tmf.change !== null && (
          <div className="bg-white border border-gray-200 rounded-2xl p-4 flex items-center justify-between">
            <span className="font-semibold text-gray-800 flex items-center gap-2">
              <span className={`w-1.5 h-6 rounded-full ${tmf.change >= 0 ? "bg-rose-500" : "bg-emerald-500"}`}></span>
              📉 收盤價
            </span>
            <div className="text-right">
              <div className={`text-3xl font-bold ${tmf.change >= 0 ? "text-rose-500" : "text-emerald-600"}`}>
                {tmf.close.toLocaleString()}
              </div>
              <div className="text-xs">
                <span className={`font-medium ${tmf.change >= 0 ? "text-rose-500" : "text-emerald-600"}`}>
                  {tmf.change >= 0 ? "▲" : "▼"} {Math.abs(tmf.change).toFixed(0)}
                  {tmf.change_pct !== null && ` (${Math.abs(tmf.change_pct).toFixed(2)}%)`}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 最高/最低 + 散戶口數 */}
      <div className="grid grid-cols-2 gap-3">
        <Stat label="最高多空比" value={max.toFixed(2)} positive />
        <Stat label="最低多空比" value={min.toFixed(2)} positive={false} />
        <Stat label="散戶做多" value={tmf.retail_long.toLocaleString()} positive />
        <Stat label="散戶做空" value={tmf.retail_short.toLocaleString()} positive={false} />
      </div>

      {/* 近 10 日方向 strip */}
      {dirHistory.length > 0 && <RetailDirectionStrip history={dirHistory} />}

      {/* 雙軸圖表 */}
      {chartData.length > 1 && <RetailChart data={chartData} />}
    </div>
  );
}

function Stat({ label, value, positive }: { label: string; value: string; positive: boolean }) {
  return (
    <div className="text-center bg-gray-50 rounded-xl py-3">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-xl font-bold ${positive ? "text-rose-500" : "text-emerald-600"}`}>{value}</p>
    </div>
  );
}

function RetailChart({
  data,
}: {
  data: { date: string; ratio: number; close: number | null }[];
}) {
  return (
    <div className="bg-gray-50 rounded-xl p-3">
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="date" stroke="#9ca3af" fontSize={11} />
          <YAxis
            yAxisId="ratio"
            stroke="#9ca3af"
            fontSize={11}
            label={{ value: "多空比", angle: -90, position: "insideLeft", fontSize: 11 }}
          />
          <YAxis
            yAxisId="close"
            orientation="right"
            stroke="#9ca3af"
            fontSize={11}
            domain={["dataMin - 200", "dataMax + 200"]}
            label={{ value: "收盤價", angle: 90, position: "insideRight", fontSize: 11 }}
          />
          <Tooltip
            contentStyle={{ borderRadius: 8, fontSize: 12 }}
            formatter={(value, name) => {
              const v = Number(value);
              const label = name === "ratio" ? "多空比" : "收盤價";
              return [name === "ratio" ? v.toFixed(2) : v.toLocaleString(), label];
            }}
          />
          <Bar yAxisId="ratio" dataKey="ratio">
            {data.map((d, i) => (
              <Cell key={i} fill={d.ratio >= 0 ? "#f43f5e" : "#10b981"} />
            ))}
          </Bar>
          <Line
            yAxisId="close"
            type="monotone"
            dataKey="close"
            stroke="#1f2937"
            strokeWidth={2}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ============================ 大盤技術分析 Card ============================ */

function MarketTechCard() {
  const [kline, setKline] = useState<KlineResponse | null>(null);
  const [klineLoading, setKlineLoading] = useState(true);
  const klineTs = useRef<ITimeScaleApi<UTCTimestamp> | null>(null);
  const kdjTs   = useRef<ITimeScaleApi<UTCTimestamp> | null>(null);
  const syncing  = useRef(false);

  useEffect(() => {
    stocksApi.market_kline("taiex")
      .then(setKline)
      .catch(() => {})
      .finally(() => setKlineLoading(false));
  }, []);

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

  const formatPrice = (n: number) =>
    n.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-6 space-y-4">
      <h2 className="text-xl font-bold text-gray-900">📊 加權指數技術分析</h2>

      {/* K 線 */}
      <div className="rounded-xl overflow-hidden border border-[#1e3a5f]">
        <div className="px-4 py-2.5 bg-[#0B1E3D] flex items-center justify-between">
          <span className="text-[13px] font-bold text-white">日 K 線</span>
          <div className="flex items-center gap-3 text-[11px] text-white/70">
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
            if (kdjTs.current) { syncCharts(ts, kdjTs.current); syncCharts(kdjTs.current, ts); }
          }} />
        ) : (
          <div className="h-[300px] flex items-center justify-center bg-[#122548] text-white/40 text-sm">
            無法載入 K 線資料
          </div>
        )}
      </div>

      {/* KDJ */}
      {!klineLoading && kline && kline.kdj_k.length > 0 && (
        <div className="rounded-xl overflow-hidden border border-[#1e3a5f]">
          <div className="px-4 py-2.5 bg-[#0B1E3D] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-bold text-white">KDJ</span>
              <span className="text-[11px] text-white/50">RSV=89 · K權重 1/9 · D權重 1/12</span>
            </div>
            <div className="flex items-center gap-3 text-[11px]">
              {([["K", kline.kdj_cur_k, "#3B82F6"], ["D", kline.kdj_cur_d, "#F59E0B"], ["J", kline.kdj_cur_j, "#A78BFA"]] as [string, number | null, string][]).map(([lbl, val, color]) => (
                <span key={lbl} style={{ color }}>
                  {lbl} <span className={`font-mono font-bold ${val == null ? "text-white/40" : val >= 80 ? "text-[#EF4444]" : val <= 20 ? "text-[#22C55E]" : "text-white"}`}>
                    {val != null ? val.toFixed(1) : "—"}
                  </span>
                </span>
              ))}
            </div>
          </div>
          <KdjChart
            kdj_k={kline.kdj_k} kdj_d={kline.kdj_d} kdj_j={kline.kdj_j}
            onTimeScaleReady={(ts) => {
              kdjTs.current = ts;
              if (klineTs.current) { syncCharts(ts, klineTs.current); syncCharts(klineTs.current, ts); }
            }}
          />
          {kline.kdj_k20_price != null && kline.kdj_k80_price != null && (
            <div className="grid grid-cols-3 gap-3 px-4 py-3 bg-[#0B1E3D] border-t border-[#1e3a5f] text-center text-[12px]">
              <div>
                <div className="text-[10px] text-white/50 mb-0.5">K=20 支撐估價</div>
                <div className="font-bold text-[#22C55E] tabular-nums text-[14px]">{formatPrice(kline.kdj_k20_price)}</div>
              </div>
              <div className="border-x border-[#1e3a5f]">
                <div className="text-[10px] text-white/50 mb-0.5">80-20 差距</div>
                <div className="font-semibold text-white tabular-nums">{formatPrice(kline.kdj_k80_price - kline.kdj_k20_price)}</div>
              </div>
              <div>
                <div className="text-[10px] text-white/50 mb-0.5">K=80 壓力估價</div>
                <div className="font-bold text-[#EF4444] tabular-nums text-[14px]">{formatPrice(kline.kdj_k80_price)}</div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================ Page ============================ */

export default function ChipsPage() {
  const [latest, setLatest] = useState<ChipSnapshot | null>(null);
  const [history, setHistory] = useState<ChipSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([chipsApi.latest().catch(() => null), chipsApi.history(15).catch(() => [])])
      .then(([l, h]) => {
        if (l) setLatest(l);
        setHistory(h);
        setError(l ? null : "尚無籌碼面資料，請先點擊「立即抓取」");
      })
      .catch((e) => setError(e?.message ?? "載入失敗"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await chipsApi.refresh();
      load();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? e?.message ?? "抓取失敗");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-800">籌碼面</h1>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          {refreshing ? "抓取中…" : "立即抓取"}
        </button>
      </div>

      {/* 大盤技術分析（獨立載入，不受籌碼資料影響） */}
      <MarketTechCard />

      {loading ? (
        <p className="text-gray-400">載入中…</p>
      ) : error && !latest ? (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm text-yellow-800">
          {error}
        </div>
      ) : latest ? (
        <div className="space-y-6">
          <OverviewCard snap={latest} history={history} />
          <RetailDetailCard snap={latest} history={history} />
        </div>
      ) : null}
    </div>
  );
}

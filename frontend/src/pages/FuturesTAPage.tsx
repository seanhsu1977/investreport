import { useState } from "react";
import { futuresTAApi, type FuturesAnalysis } from "../api/client";

type Direction = "long" | "short";

function Badge({ text, color }: { text: string; color: "green" | "red" | "yellow" | "blue" | "gray" }) {
  const cls: Record<string, string> = {
    green:  "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    red:    "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    yellow: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
    blue:   "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    gray:   "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  };
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${cls[color]}`}>{text}</span>;
}

function MetricCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-800/60 rounded-xl p-3">
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</p>
      <p className={`text-xl font-semibold ${color ?? "text-gray-900 dark:text-white"}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function LevelBar({
  entry, stop, targets, supports, resistances, direction,
}: {
  entry: number; stop: number;
  targets: FuturesAnalysis["targets"];
  supports: number[]; resistances: number[];
  direction: Direction;
}) {
  const allPrices = [entry, stop, ...targets.map(t => t.price), ...supports, ...resistances];
  const minP = Math.min(...allPrices);
  const maxP = Math.max(...allPrices);
  const range = maxP - minP || 1;
  const pct = (p: number) => ((p - minP) / range) * 100;

  const items: { price: number; label: string; color: string; dot: string }[] = [
    { price: entry, label: "進場", color: "text-blue-600 dark:text-blue-400", dot: "bg-blue-500" },
    { price: stop,  label: "停損", color: "text-red-600 dark:text-red-400",  dot: "bg-red-500"  },
    ...targets.map((t, i) => ({
      price: t.price, label: `目標${i + 1}`, color: "text-green-600 dark:text-green-400", dot: "bg-green-500",
    })),
    ...supports.map(s => ({ price: s, label: "支撐", color: "text-orange-500", dot: "bg-orange-400" })),
    ...resistances.map(r => ({ price: r, label: "壓力", color: "text-purple-500", dot: "bg-purple-400" })),
  ];

  // 依價格排序後，交錯分配上下層，避免重疊
  const sorted = [...items].sort((a, b) => a.price - b.price);
  const ROW_THRESHOLD = 4; // 相鄰兩點差距 < 總範圍 4% 時交錯
  const rows: number[] = new Array(sorted.length).fill(0); // 0=上, 1=下, 2=更上
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i].price - sorted[i - 1].price) / range * 100;
    if (gap < ROW_THRESHOLD) {
      // 與前一個不同層
      const prev = rows[i - 1];
      rows[i] = prev === 0 ? 1 : prev === 1 ? 2 : 0;
    }
  }

  const rowOffsetTop: Record<number, string> = { 0: "0px", 1: "22px", 2: "-22px" };
  const labelAbove: Record<number, boolean> = { 0: true, 1: false, 2: true };

  return (
    <div className="relative my-6" style={{ height: "80px" }}>
      <div className="absolute inset-x-0" style={{ top: "38px", height: "2px" }} >
        <div className="w-full h-full bg-gray-200 dark:bg-gray-700 rounded-full" />
      </div>
      {sorted.map((item, i) => {
        const row = rows[i];
        const topBase = 38; // px — horizontal line position
        const dotTop = topBase - 5 + parseInt(rowOffsetTop[row] ?? "0");
        const above = labelAbove[row] ?? true;
        return (
          <div
            key={i}
            className="absolute flex flex-col items-center"
            style={{ left: `${pct(item.price)}%`, transform: "translateX(-50%)", top: `${dotTop}px` }}
          >
            {above && (
              <span className={`text-[10px] whitespace-nowrap leading-none mb-0.5 ${item.color}`}>
                {item.label}
              </span>
            )}
            <div className={`w-2.5 h-2.5 rounded-full border-2 border-white dark:border-gray-900 ${item.dot}`} />
            {!above && (
              <span className={`text-[10px] whitespace-nowrap leading-none mt-0.5 ${item.color}`}>
                {item.label}
              </span>
            )}
            <span className={`text-[10px] whitespace-nowrap leading-none ${above ? "mt-0.5" : "mt-0.5"} ${item.color} opacity-75`}>
              {item.price.toLocaleString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function FuturesTAPage() {
  const [direction, setDirection] = useState<Direction>("long");
  const [entryInput, setEntryInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FuturesAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const price = parseFloat(entryInput);
    if (!price || price < 1000 || price > 100000) {
      setError("請輸入合理的台指期點位（1000 ~ 100000）");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await futuresTAApi.analyze(direction, price);
      setResult(data);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? "分析失敗，請確認後端服務正常");
    } finally {
      setLoading(false);
    }
  }

  const verdictColor = result
    ? result.verdict.includes("有利") ? "text-green-600 dark:text-green-400"
    : result.verdict.includes("不利") ? "text-red-500 dark:text-red-400"
    : "text-yellow-600 dark:text-yellow-400"
    : "";

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <h1 className="text-xl font-semibold text-gray-900 dark:text-white mb-1">期貨技術分析</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">輸入多空方向與進場價，即時計算停損、目標與技術訊號</p>

      {/* 輸入表單 */}
      <form onSubmit={handleSubmit} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-5 mb-6">
        <div className="flex gap-3 mb-4">
          <button
            type="button"
            onClick={() => setDirection("long")}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition border ${
              direction === "long"
                ? "bg-green-500 text-white border-green-500"
                : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-green-400"
            }`}
          >
            做多 Long ▲
          </button>
          <button
            type="button"
            onClick={() => setDirection("short")}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition border ${
              direction === "short"
                ? "bg-red-500 text-white border-red-500"
                : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-red-400"
            }`}
          >
            做空 Short ▼
          </button>
        </div>

        <div className="flex gap-3">
          <input
            type="number"
            value={entryInput}
            onChange={e => setEntryInput(e.target.value)}
            placeholder="進場價格（例：22000）"
            className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <button
            type="submit"
            disabled={loading}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl text-sm font-medium transition"
          >
            {loading ? "分析中…" : "分析"}
          </button>
        </div>

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      </form>

      {result && (
        <div className="space-y-4">
          {/* 綜合判斷 */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-5">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">綜合判斷</p>
            <p className={`text-base font-semibold ${verdictColor}`}>{result.verdict}</p>
            <div className="flex gap-2 flex-wrap mt-2">
              <Badge text={result.direction === "long" ? "做多" : "做空"} color={result.direction === "long" ? "green" : "red"} />
              <Badge text={`進場 ${result.entry_price.toLocaleString()}`} color="blue" />
              <Badge text={`目前 ${result.current_price.toLocaleString()}`} color="gray" />
              {result.risk_reward && (
                <Badge text={`風報比 1:${result.risk_reward}`} color={result.risk_reward >= 1.5 ? "green" : result.risk_reward >= 1 ? "yellow" : "red"} />
              )}
            </div>
          </div>

          {/* 關鍵指標 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard label="ATR（日均波動）" value={`${result.atr} 點`} sub={`約 ${result.atr_pct}%`} />
            <MetricCard
              label="建議停損"
              value={`${result.stop_loss.toLocaleString()}`}
              sub={`${result.stop_loss_pct}%（2x ATR）`}
              color="text-red-500 dark:text-red-400"
            />
            <MetricCard label="RSI(14)" value={result.rsi != null ? String(result.rsi) : "—"} sub={result.rsi != null ? (result.rsi > 70 ? "超買" : result.rsi < 30 ? "超賣" : "中性") : ""} />
            <MetricCard
              label="量能比"
              value={result.volume_ratio != null ? `${result.volume_ratio}x` : "—"}
              sub="vs 20日均量"
              color={result.volume_ratio != null ? (result.volume_ratio >= 1.5 ? "text-green-600 dark:text-green-400" : result.volume_ratio < 0.7 ? "text-red-500" : undefined) : undefined}
            />
          </div>

          {/* 價位圖 */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-5">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">價位分佈</p>
            <LevelBar
              entry={result.entry_price}
              stop={result.stop_loss}
              targets={result.targets}
              supports={result.supports}
              resistances={result.resistances}
              direction={result.direction as Direction}
            />
            <div className="mt-6 space-y-1.5">
              {result.targets.map((t, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-gray-500 dark:text-gray-400">目標 {i + 1}（{t.label}）</span>
                  <span className="font-medium text-green-600 dark:text-green-400">
                    {t.price.toLocaleString()} <span className="text-xs">(+{Math.abs(t.pct_from_entry).toFixed(1)}%)</span>
                  </span>
                </div>
              ))}
              <div className="flex justify-between text-sm pt-1 border-t border-gray-100 dark:border-gray-800">
                <span className="text-gray-500 dark:text-gray-400">停損（2x ATR）</span>
                <span className="font-medium text-red-500 dark:text-red-400">
                  {result.stop_loss.toLocaleString()} <span className="text-xs">({result.stop_loss_pct}%)</span>
                </span>
              </div>
            </div>
          </div>

          {/* 技術訊號 */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-5">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-3">技術訊號</p>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-gray-500 dark:text-gray-400 shrink-0">RSI</span>
                <span className="text-gray-800 dark:text-gray-200 text-right">{result.rsi_signal}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-gray-500 dark:text-gray-400 shrink-0">KDJ</span>
                <span className="text-gray-800 dark:text-gray-200 text-right">
                  K={result.kdj_k ?? "—"} D={result.kdj_d ?? "—"} J={result.kdj_j ?? "—"} — {result.kdj_signal}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-gray-500 dark:text-gray-400 shrink-0">布林通道</span>
                <span className="text-gray-800 dark:text-gray-200 text-right">
                  {result.bollinger_upper && result.bollinger_lower
                    ? `${result.bollinger_lower.toLocaleString()} ~ ${result.bollinger_upper.toLocaleString()}${result.bb_signal ? `（${result.bb_signal}）` : ""}`
                    : "—"}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-gray-500 dark:text-gray-400 shrink-0">均線</span>
                <span className="text-gray-800 dark:text-gray-200 text-right">{result.ma_signal}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-gray-500 dark:text-gray-400 shrink-0">MA5/20/60</span>
                <span className="text-gray-800 dark:text-gray-200 text-right">
                  {result.ma5?.toLocaleString() ?? "—"} / {result.ma20?.toLocaleString() ?? "—"} / {result.ma60?.toLocaleString() ?? "—"}
                </span>
              </div>
            </div>
          </div>

          {/* 操作建議 */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-5">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-3">操作建議</p>
            <ol className="space-y-2">
              {result.advice.map((a, i) => (
                <li key={i} className="flex gap-2.5 text-sm">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-xs flex items-center justify-center font-medium">{i + 1}</span>
                  <span className="text-gray-700 dark:text-gray-300">{a}</span>
                </li>
              ))}
            </ol>
          </div>

          {/* 支撐壓力 */}
          {(result.supports.length > 0 || result.resistances.length > 0) && (
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-5">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-3">關鍵支撐 / 壓力</p>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-gray-400 mb-1.5">壓力位</p>
                  {result.resistances.length > 0
                    ? result.resistances.map((r, i) => (
                        <p key={i} className="text-purple-600 dark:text-purple-400 font-medium">{r.toLocaleString()}</p>
                      ))
                    : <p className="text-gray-400">—</p>}
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1.5">支撐位</p>
                  {result.supports.length > 0
                    ? result.supports.map((s, i) => (
                        <p key={i} className="text-orange-600 dark:text-orange-400 font-medium">{s.toLocaleString()}</p>
                      ))
                    : <p className="text-gray-400">—</p>}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

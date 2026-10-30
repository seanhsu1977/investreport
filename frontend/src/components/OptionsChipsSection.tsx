import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  chipsApi,
  type ChipSnapshot,
  type FuturesCurve,
  type LargeTraderRow,
  type PcrRow,
} from "../api/client";

const UP = "#f43f5e";
const DOWN = "#10b981";
const BLUE = "#2563eb";
const GOLD = "#b8912f";

function n0(v: number | null | undefined): string {
  return v == null ? "–" : Math.round(v).toLocaleString("en-US");
}
function sgn(v: number, d = 0): string {
  const a = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return (v > 0 ? "+" : v < 0 ? "−" : "") + a;
}
function tone(v: number): string {
  return v > 0 ? "text-red-500" : v < 0 ? "text-emerald-600" : "text-gray-500";
}

function Seg<T extends string | number>({
  value, options, onChange,
}: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex bg-gray-100 rounded-lg p-0.5 gap-0.5">
      {options.map((o) => (
        <button
          key={String(o.v)}
          onClick={() => onChange(o.v)}
          aria-pressed={value === o.v}
          className={`px-2.5 py-1 text-xs font-medium rounded-md transition ${
            value === o.v ? "bg-white text-gray-800 shadow-sm" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Card({ title, right, children, note }: {
  title: string; right?: React.ReactNode; children: React.ReactNode; note?: string;
}) {
  return (
    <section className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between flex-wrap gap-2 px-5 py-3 border-b border-gray-100">
        <h2 className="text-base font-bold text-gray-800">{title}</h2>
        {right}
      </div>
      <div className="p-5">{children}</div>
      {note && <p className="px-5 pb-4 -mt-2 text-xs text-gray-400 leading-relaxed">{note}</p>}
    </section>
  );
}

/* ========================= 選擇權 Put/Call Ratio ========================= */

function PcrCard() {
  const [days, setDays] = useState(60);
  const [mode, setMode] = useState<"both" | "oi" | "vol">("both");
  const [rows, setRows] = useState<PcrRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    chipsApi.pcr(days).then(setRows).catch(() => setRows([]));
  }, [days]);

  const data = useMemo(
    () => (rows ?? []).map((r) => ({ date: r.date.slice(5), oi: r.pcr_oi, vol: r.pcr_volume })),
    [rows],
  );
  const stats = useMemo(() => {
    if (data.length === 0) return null;
    const key = mode === "vol" ? "vol" : "oi";
    const vals = data.map((d) => d[key]);
    const cur = vals[vals.length - 1];
    return {
      name: mode === "vol" ? "成交量比" : "未平倉比",
      cur,
      min: Math.min(...vals),
      max: Math.max(...vals),
      pct: Math.round((vals.filter((v) => v <= cur).length / vals.length) * 100),
    };
  }, [data, mode]);

  return (
    <Card
      title="選擇權 Put/Call Ratio"
      right={
        <div className="flex gap-2 flex-wrap">
          <Seg value={days} onChange={setDays} options={[{ v: 20, label: "20 日" }, { v: 60, label: "60 日" }, { v: 120, label: "120 日" }]} />
          <Seg value={mode} onChange={setMode} options={[{ v: "both", label: "兩者" }, { v: "oi", label: "未平倉比" }, { v: "vol", label: "成交量比" }]} />
        </div>
      }
      note="比值低於 100% 代表買權比賣權多。百分位是最新值在所選區間內的相對位置，沒有固定的買賣門檻，請對照自己的歷史看。"
    >
      {rows === null ? (
        <p className="text-sm text-gray-400">載入中…</p>
      ) : data.length === 0 ? (
        <p className="text-sm text-gray-400">尚無資料，請先到後台執行選擇權資料回補。</p>
      ) : (
        <>
          <div className="flex gap-4 text-xs text-gray-500 mb-2">
            {mode !== "vol" && <span><b className="inline-block w-3 border-t-2 align-middle mr-1" style={{ borderColor: BLUE }} />未平倉比</span>}
            {mode !== "oi" && <span><b className="inline-block w-3 border-t-2 border-dashed align-middle mr-1" style={{ borderColor: GOLD }} />成交量比</span>}
          </div>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="date" stroke="#9ca3af" fontSize={11} minTickGap={24} />
              <YAxis stroke="#9ca3af" fontSize={11} domain={["auto", "auto"]} tickFormatter={(v) => `${v}%`} />
              <Tooltip
                contentStyle={{ borderRadius: 8, fontSize: 12 }}
                formatter={(v, name) => [`${Number(v).toFixed(2)}%`, name === "oi" ? "未平倉比" : "成交量比"]}
              />
              <ReferenceLine y={100} stroke="#9ca3af" strokeDasharray="4 3" />
              {mode !== "vol" && <Line type="monotone" dataKey="oi" stroke={BLUE} strokeWidth={2.2} dot={false} />}
              {mode !== "oi" && <Line type="monotone" dataKey="vol" stroke={GOLD} strokeWidth={1.6} strokeDasharray="5 3" dot={false} />}
            </LineChart>
          </ResponsiveContainer>
          {stats && (
            <div className="grid grid-cols-3 gap-3 mt-3">
              <div><div className="text-xs text-gray-400">最新{stats.name}</div><div className="text-base font-bold tabular-nums">{stats.cur.toFixed(2)}%</div></div>
              <div><div className="text-xs text-gray-400">區間</div><div className="text-base font-bold tabular-nums">{stats.min.toFixed(1)} – {stats.max.toFixed(1)}</div></div>
              <div><div className="text-xs text-gray-400">百分位</div><div className="text-base font-bold tabular-nums">{stats.pct}%</div></div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/* ========================= 大額交易人未平倉 ========================= */

function ShareBar({ label, v, oi, color, text }: { label: string; v: number; oi: number; color: string; text: string }) {
  const pct = oi > 0 ? (v / oi) * 100 : 0;
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)_132px] gap-2 items-center text-sm mb-1.5">
      <span className={text}>{label}</span>
      <div className="h-2.5 bg-gray-100 rounded">
        <div className="h-full rounded" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
      </div>
      <span className="text-right tabular-nums text-xs sm:text-sm">{n0(v)}（{pct.toFixed(1)}%）</span>
    </div>
  );
}

function LargeTradersCard({ nearMonth }: { nearMonth: string | null }) {
  const [scope, setScope] = useState<"all" | "near">("all");
  const [type, setType] = useState<0 | 1>(0);
  const [rows, setRows] = useState<LargeTraderRow[] | null>(null);
  const month = scope === "near" && nearMonth ? nearMonth : "all";

  useEffect(() => {
    setRows(null);
    chipsApi.largeTraders(60, month).then(setRows).catch(() => setRows([]));
  }, [month]);

  const series = useMemo(
    () => (rows ?? []).filter((r) => r.trader_type === type),
    [rows, type],
  );
  const latest = series[series.length - 1];
  const trend = useMemo(
    () => series.map((r) => ({ date: r.date.slice(5), net: r.top10_buy - r.top10_sell })),
    [series],
  );

  return (
    <Card
      title="大額交易人未平倉"
      right={
        <div className="flex gap-2 flex-wrap">
          {nearMonth && (
            <Seg value={scope} onChange={setScope} options={[{ v: "all", label: "所有契約" }, { v: "near", label: `近月 ${nearMonth}` }]} />
          )}
          <Seg value={type} onChange={setType} options={[{ v: 0, label: "全部交易人" }, { v: 1, label: "特定法人" }]} />
        </div>
      }
      note="口數為期交所折算後的大台口數（TX＋MTX÷4），百分比為占市場未平倉的比重。看買賣差的變化比看水位更有意義。"
    >
      {rows === null ? (
        <p className="text-sm text-gray-400">載入中…</p>
      ) : !latest ? (
        <p className="text-sm text-gray-400">尚無資料，請先到後台執行選擇權資料回補。</p>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-gray-400 tabular-nums">資料日期 {latest.date} · 市場未平倉 {n0(latest.oi_market)} 口</p>
          {([["前五大", latest.top5_buy, latest.top5_sell], ["前十大", latest.top10_buy, latest.top10_sell]] as const).map(([name, b, s]) => (
            <div key={name}>
              <div className="flex justify-between text-sm font-medium mb-1.5">
                <span>{name}</span>
                <span className={`tabular-nums ${tone(b - s)}`}>買 − 賣 {sgn(b - s)}</span>
              </div>
              <ShareBar label="買" v={b} oi={latest.oi_market} color={UP} text="text-red-500" />
              <ShareBar label="賣" v={s} oi={latest.oi_market} color={DOWN} text="text-emerald-600" />
            </div>
          ))}
          <div>
            <div className="text-xs text-gray-500 mb-1">前十大 買 − 賣（近 {trend.length} 個交易日）</div>
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={trend} margin={{ top: 6, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" stroke="#9ca3af" fontSize={11} minTickGap={28} />
                <YAxis stroke="#9ca3af" fontSize={11} tickFormatter={(v) => n0(v)} />
                <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} formatter={(v) => [sgn(Number(v)), "買 − 賣"]} />
                <ReferenceLine y={0} stroke="#9ca3af" strokeDasharray="4 3" />
                <Line type="monotone" dataKey="net" stroke={BLUE} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ========================= 近遠月價差與基差 ========================= */

function CurveCard({ curve, taiex }: { curve: FuturesCurve | null | undefined; taiex: ChipSnapshot["taiex"] }) {
  if (curve === undefined) {
    return <Card title="近遠月價差與基差"><p className="text-sm text-gray-400">載入中…</p></Card>;
  }
  if (!curve) {
    return <Card title="近遠月價差與基差"><p className="text-sm text-gray-400">期交所目前沒有行情資料。</p></Card>;
  }
  const near = curve.months[0];
  const settleBase = near.settle ?? null;
  const basis = taiex && taiex.date === curve.date && near.day_last != null ? near.day_last - taiex.close : null;
  const next = curve.months[1];
  const nextSpread = near.day_last != null && next?.day_last != null ? next.day_last - near.day_last : null;

  return (
    <Card
      title="近遠月價差與基差"
      right={<span className="text-xs text-gray-400 tabular-nums">資料日期 {curve.date} · 只有最新一天，不保存歷史</span>}
      note="夜盤是期交所報表的「盤後」時段。遠月成交量很小，價差僅供參考。"
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <div className="bg-gray-50 rounded-xl p-3">
          <div className="text-xs text-gray-400">基差（近月日盤收 − 加權）</div>
          {basis == null ? (
            <div className="text-sm text-gray-400 mt-1">加權指數日期與行情不同日</div>
          ) : (
            <div className={`text-lg font-bold tabular-nums ${tone(basis)}`}>
              {sgn(basis, 2)} <span className="text-xs font-normal">{basis > 0 ? "升水" : basis < 0 ? "貼水" : "平水"}</span>
            </div>
          )}
        </div>
        <div className="bg-gray-50 rounded-xl p-3">
          <div className="text-xs text-gray-400">近月對次月（日盤收）</div>
          <div className={`text-lg font-bold tabular-nums ${nextSpread == null ? "" : tone(nextSpread)}`}>
            {nextSpread == null ? "–" : `${sgn(nextSpread)} 點`}
          </div>
        </div>
        {curve.spread && (
          <div className="bg-gray-50 rounded-xl p-3">
            <div className="text-xs text-gray-400">價差商品 {curve.spread.pair}</div>
            <div className="text-lg font-bold tabular-nums">{curve.spread.last ?? "–"} 點</div>
            <div className="text-xs text-gray-400 tabular-nums">成交 {n0(curve.spread.volume)} 口</div>
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap tabular-nums">
          <thead className="text-xs text-gray-500">
            <tr className="border-b border-gray-100">
              <th className="py-2 pr-3 text-left font-medium">契約月</th>
              <th className="py-2 px-3 text-right font-medium">日盤收</th>
              <th className="py-2 px-3 text-right font-medium">夜盤收</th>
              <th className="py-2 px-3 text-right font-medium">結算價</th>
              <th className="py-2 px-3 text-right font-medium">較近月（結算價）</th>
              <th className="py-2 px-3 text-right font-medium">成交量</th>
              <th className="py-2 pl-3 text-right font-medium">未平倉</th>
            </tr>
          </thead>
          <tbody>
            {curve.months.map((m, i) => {
              const sp = m.settle != null && settleBase != null ? m.settle - settleBase : null;
              return (
                <tr key={m.month} className={`border-b border-gray-50 last:border-0 ${i === 0 ? "bg-amber-50/60" : ""}`}>
                  <td className="py-2 pr-3 text-left font-mono font-semibold">
                    {m.month}
                    {i === 0 && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-sans">近月</span>}
                  </td>
                  <td className="py-2 px-3 text-right">{n0(m.day_last)}</td>
                  <td className="py-2 px-3 text-right">{n0(m.night_last)}</td>
                  <td className="py-2 px-3 text-right">{n0(m.settle)}</td>
                  <td className={`py-2 px-3 text-right ${i && sp != null ? tone(sp) : ""}`}>{i && sp != null ? sgn(sp) : "–"}</td>
                  <td className="py-2 px-3 text-right">{n0(m.volume)}</td>
                  <td className="py-2 pl-3 text-right">{n0(m.oi)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ========================= 對外元件 ========================= */

export default function OptionsChipsSection({ taiex }: { taiex: ChipSnapshot["taiex"] }) {
  const [curve, setCurve] = useState<FuturesCurve | null | undefined>(undefined);

  useEffect(() => {
    chipsApi.futuresCurve().then(setCurve).catch(() => setCurve(null));
  }, []);

  return (
    <div className="space-y-6">
      <PcrCard />
      <LargeTradersCard nearMonth={curve?.months[0]?.month ?? null} />
      <CurveCard curve={curve} taiex={taiex} />
    </div>
  );
}

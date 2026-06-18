import { useEffect, useRef, useState } from "react";
import { stocksApi } from "../api/client";

// ── types ──────────────────────────────────────────────────────────────────

interface TrailPoint { date: string; x: number; y: number }
interface Sector {
  name: string;
  ticker: string;
  color: string;
  trail: TrailPoint[];
}
interface SectorRotationData {
  sectors: Sector[];
  benchmark: string;
  computed_at: string;
  days: number;
}

// ── RRG constants ──────────────────────────────────────────────────────────

const CHART_SIZE = 380;   // SVG inner chart area (square)
const PAD = { top: 28, right: 32, bottom: 36, left: 36 };

const Q_LABELS = [
  { x: 0.75, y: 0.25, text: "領先", sub: "Leading",   color: "#15803D", bg: "rgba(21,128,61,0.07)"  },
  { x: 0.25, y: 0.25, text: "改善", sub: "Improving", color: "#1D4ED8", bg: "rgba(29,78,216,0.07)"  },
  { x: 0.75, y: 0.75, text: "弱化", sub: "Weakening", color: "#B45309", bg: "rgba(180,83,9,0.07)"   },
  { x: 0.25, y: 0.75, text: "落後", sub: "Lagging",   color: "#B91C1C", bg: "rgba(185,28,28,0.07)"  },
];

// ── helpers ────────────────────────────────────────────────────────────────

function useAutoRange(sectors: Sector[], trailLen: number) {
  if (!sectors.length) return { minX: 97, maxX: 103, minY: 97, maxY: 103 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of sectors) {
    for (const p of s.trail.slice(-trailLen)) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const padX = Math.max((maxX - minX) * 0.15, 0.5);
  const padY = Math.max((maxY - minY) * 0.15, 0.5);
  return {
    minX: Math.min(minX - padX, 99.2),
    maxX: Math.max(maxX + padX, 100.8),
    minY: Math.min(minY - padY, 99.2),
    maxY: Math.max(maxY + padY, 100.8),
  };
}

// ── RRG Chart ──────────────────────────────────────────────────────────────

function RRGChart({ sectors, trailLen }: { sectors: Sector[]; trailLen: number }) {
  const { minX, maxX, minY, maxY } = useAutoRange(sectors, trailLen);
  const W = CHART_SIZE + PAD.left + PAD.right;
  const H = CHART_SIZE + PAD.top + PAD.bottom;

  const toSvgX = (v: number) => PAD.left + ((v - minX) / (maxX - minX)) * CHART_SIZE;
  const toSvgY = (v: number) => PAD.top + (1 - (v - minY) / (maxY - minY)) * CHART_SIZE;
  const cx = toSvgX(100);
  const cy = toSvgY(100);

  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; sector: Sector; point: TrailPoint } | null>(null);

  // Quadrant backgrounds
  const quads = [
    { x: cx, y: PAD.top,    w: W - cx - PAD.right,  h: cy - PAD.top,    color: "rgba(21,128,61,0.06)"  },  // Leading
    { x: PAD.left, y: PAD.top, w: cx - PAD.left, h: cy - PAD.top,    color: "rgba(29,78,216,0.06)"  },  // Improving
    { x: cx, y: cy,          w: W - cx - PAD.right,  h: H - cy - PAD.bottom, color: "rgba(180,83,9,0.06)"   },  // Weakening
    { x: PAD.left, y: cy,    w: cx - PAD.left, h: H - cy - PAD.bottom, color: "rgba(185,28,28,0.06)"  },  // Lagging
  ];

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      className="w-full max-w-full"
      style={{ fontFamily: "system-ui, sans-serif" }}
    >
      {/* Quadrant fills */}
      {quads.map((q, i) => (
        <rect key={i} x={q.x} y={q.y} width={q.w} height={q.h} fill={q.color} />
      ))}

      {/* Grid border */}
      <rect x={PAD.left} y={PAD.top} width={CHART_SIZE} height={CHART_SIZE}
        fill="none" stroke="#DDE2EC" strokeWidth="1" />

      {/* Center lines */}
      <line x1={cx} y1={PAD.top} x2={cx} y2={PAD.top + CHART_SIZE} stroke="#C8CEDB" strokeWidth="1" strokeDasharray="4 3" />
      <line x1={PAD.left} y1={cy} x2={PAD.left + CHART_SIZE} y2={cy} stroke="#C8CEDB" strokeWidth="1" strokeDasharray="4 3" />

      {/* Quadrant labels */}
      {Q_LABELS.map((q) => {
        const qx = PAD.left + q.x * CHART_SIZE;
        const qy = PAD.top + q.y * CHART_SIZE;
        return (
          <g key={q.text}>
            <text x={qx} y={qy - 8} textAnchor="middle" fontSize="11" fontWeight="700" fill={q.color} opacity="0.7">{q.text}</text>
            <text x={qx} y={qy + 5} textAnchor="middle" fontSize="9" fill={q.color} opacity="0.5">{q.sub}</text>
          </g>
        );
      })}

      {/* Axis ticks & labels */}
      {[minX, 100, maxX].map((v) => (
        <g key={v}>
          <line x1={toSvgX(v)} y1={PAD.top + CHART_SIZE} x2={toSvgX(v)} y2={PAD.top + CHART_SIZE + 4} stroke="#9CA3AF" strokeWidth="1" />
          <text x={toSvgX(v)} y={PAD.top + CHART_SIZE + 14} textAnchor="middle" fontSize="9" fill="#9CA3AF">{v.toFixed(1)}</text>
        </g>
      ))}
      {[minY, 100, maxY].map((v) => (
        <g key={v}>
          <line x1={PAD.left - 4} y1={toSvgY(v)} x2={PAD.left} y2={toSvgY(v)} stroke="#9CA3AF" strokeWidth="1" />
          <text x={PAD.left - 7} y={toSvgY(v) + 3.5} textAnchor="end" fontSize="9" fill="#9CA3AF">{v.toFixed(1)}</text>
        </g>
      ))}

      {/* Axis titles */}
      <text x={PAD.left + CHART_SIZE / 2} y={H - 2} textAnchor="middle" fontSize="10" fill="#6B7A99">RS-Ratio →</text>
      <text x={10} y={PAD.top + CHART_SIZE / 2} textAnchor="middle" fontSize="10" fill="#6B7A99"
        transform={`rotate(-90, 10, ${PAD.top + CHART_SIZE / 2})`}>RS-Momentum →</text>

      {/* Sector trails & bubbles */}
      {sectors.map((s) => {
        const pts = s.trail.slice(-trailLen);
        if (pts.length < 2) return null;
        const isHov = hovered === s.name;
        const last = pts[pts.length - 1];
        const lx = toSvgX(last.x);
        const ly = toSvgY(last.y);

        // build trail polyline segments with gradient opacity
        const segments = pts.slice(0, -1).map((p, i) => {
          const nx = pts[i + 1];
          const alpha = (i + 1) / pts.length;
          return (
            <line key={i}
              x1={toSvgX(p.x)} y1={toSvgY(p.y)}
              x2={toSvgX(nx.x)} y2={toSvgY(nx.y)}
              stroke={s.color}
              strokeWidth={isHov ? 2.5 : 1.5}
              strokeOpacity={alpha * (isHov ? 0.9 : 0.6)}
              strokeLinecap="round"
            />
          );
        });

        return (
          <g key={s.name}
            style={{ cursor: "pointer" }}
            onMouseEnter={() => setHovered(s.name)}
            onMouseLeave={() => { setHovered(null); setTooltip(null); }}
          >
            {segments}
            {/* Arrow indicating direction */}
            {pts.length >= 3 && (() => {
              const prev = pts[pts.length - 3];
              const dx = last.x - prev.x, dy = -(last.y - prev.y);
              const len = Math.sqrt(dx * dx + dy * dy);
              if (len < 0.001) return null;
              const nx2 = dx / len, ny2 = dy / len;
              const ax = lx - nx2 * 8, ay = ly - ny2 * 8;
              return (
                <line x1={ax} y1={ay} x2={lx} y2={ly}
                  stroke={s.color} strokeWidth={isHov ? 3 : 2} markerEnd="none" strokeOpacity="0.8" />
              );
            })()}
            {/* Current bubble */}
            <circle cx={lx} cy={ly} r={isHov ? 8 : 6}
              fill={s.color} fillOpacity={isHov ? 1 : 0.85}
              stroke="white" strokeWidth="1.5"
              onMouseMove={(e) => {
                const svgEl = (e.currentTarget as SVGElement).closest("svg")!;
                const rect = svgEl.getBoundingClientRect();
                setTooltip({
                  x: e.clientX - rect.left,
                  y: e.clientY - rect.top,
                  sector: s,
                  point: last,
                });
              }}
            />
            {/* Label */}
            <text
              x={lx + (last.x >= 100 ? 10 : -10)}
              y={ly - 8}
              textAnchor={last.x >= 100 ? "start" : "end"}
              fontSize={isHov ? "12" : "10"}
              fontWeight="700"
              fill={s.color}
              stroke="white" strokeWidth="3" paintOrder="stroke"
            >
              {s.name}
            </text>
          </g>
        );
      })}

      {/* Tooltip */}
      {tooltip && (() => {
        const { x, y, sector, point } = tooltip;
        const bx = Math.min(x + 10, W - 120);
        const by = Math.min(y - 10, H - 70);
        return (
          <g>
            <rect x={bx} y={by} width={115} height={58} rx="6" fill="white" stroke="#DDE2EC" strokeWidth="1" filter="drop-shadow(0 2px 4px rgba(0,0,0,0.1))" />
            <text x={bx + 8} y={by + 16} fontSize="11" fontWeight="700" fill={sector.color}>{sector.name}</text>
            <text x={bx + 8} y={by + 30} fontSize="10" fill="#6B7A99">{sector.ticker}</text>
            <text x={bx + 8} y={by + 43} fontSize="10" fill="#0D1B2A">RS比 {point.x.toFixed(2)}</text>
            <text x={bx + 8} y={by + 55} fontSize="10" fill="#0D1B2A">RS動 {point.y.toFixed(2)}</text>
          </g>
        );
      })()}
    </svg>
  );
}

// ── SectorRotationPage ─────────────────────────────────────────────────────

const PERIOD_OPTIONS = [
  { days: 30,  label: "1個月" },
  { days: 60,  label: "2個月" },
  { days: 90,  label: "3個月" },
  { days: 120, label: "6個月" },
];
const TRAIL_OPTIONS = [
  { len: 10, label: "10日" },
  { len: 20, label: "20日" },
  { len: 40, label: "40日" },
  { len: 60, label: "全部" },
];

export default function SectorRotationPage() {
  const [data, setData] = useState<SectorRotationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(60);
  const [trailLen, setTrailLen] = useState(20);
  const [refreshing, setRefreshing] = useState(false);

  const load = async (d: number, forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/stocks/sector-rotation?days=${d}`;
      const resp = await fetch(url + (forceRefresh ? `&_t=${Date.now()}` : ""), {
        headers: { Authorization: `Bearer ${localStorage.getItem("auth_token")}` },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setData(await resp.json());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "載入失敗");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(days); }, [days]);

  const handleRefresh = () => {
    setRefreshing(true);
    load(days, true);
  };

  const quadrantOf = (s: Sector) => {
    const last = s.trail[s.trail.length - 1];
    if (!last) return null;
    if (last.x >= 100 && last.y >= 100) return { label: "領先", color: "#15803D" };
    if (last.x >= 100 && last.y < 100)  return { label: "弱化", color: "#B45309" };
    if (last.x < 100  && last.y >= 100) return { label: "改善", color: "#1D4ED8" };
    return { label: "落後", color: "#B91C1C" };
  };

  return (
    <div className="min-h-screen bg-[#F0F2F6]">
      {/* Header */}
      <div className="bg-[#0D1B2A] px-4 pt-12 pb-5">
        <h1 className="text-[20px] font-extrabold text-white">類股輪動圖</h1>
        <p className="text-[12px] text-white/50 mt-1">
          RRG — 以 ETF 為代理，相對強弱（RS-Ratio）× 動能（RS-Momentum），基準 {data?.benchmark ?? "0050.TW"}
        </p>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        {/* Controls */}
        <div className="bg-white border border-[#DDE2EC] rounded-2xl px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-[#6B7A99]">區間</span>
            {PERIOD_OPTIONS.map((o) => (
              <button key={o.days}
                onClick={() => setDays(o.days)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${days === o.days ? "bg-[#1B6FD8] text-white" : "bg-[#F5F7FC] text-[#6B7A99] hover:bg-[#E8ECF4]"}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-[#6B7A99]">尾跡</span>
            {TRAIL_OPTIONS.map((o) => (
              <button key={o.len}
                onClick={() => setTrailLen(o.len)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${trailLen === o.len ? "bg-[#6B7A99] text-white" : "bg-[#F5F7FC] text-[#6B7A99] hover:bg-[#E8ECF4]"}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing || loading}
            className="ml-auto text-[11px] text-[#6B7A99] hover:text-[#0D1B2A] disabled:opacity-40 flex items-center gap-1"
          >
            <svg className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            重整
          </button>
        </div>

        {/* RRG Chart */}
        <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#DDE2EC] flex items-center justify-between">
            <h2 className="text-[13px] font-bold text-[#0D1B2A]">相對旋轉圖</h2>
            <span className="text-[10px] text-[#6B7A99]">順時針：領先 → 弱化 → 落後 → 改善</span>
          </div>
          <div className="p-2">
            {loading ? (
              <div className="h-[400px] flex flex-col items-center justify-center gap-3">
                <svg className="animate-spin w-8 h-8 text-[#1B6FD8]" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                <p className="text-[12px] text-[#6B7A99]">計算中，首次載入需約 10 秒…</p>
              </div>
            ) : error ? (
              <div className="h-[300px] flex items-center justify-center text-[#E53935] text-sm">{error}</div>
            ) : data ? (
              <RRGChart sectors={data.sectors} trailLen={trailLen} />
            ) : null}
          </div>
        </div>

        {/* Sector status table */}
        {data && !loading && (
          <div className="bg-white border border-[#DDE2EC] rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#DDE2EC]">
              <h2 className="text-[13px] font-bold text-[#0D1B2A]">類股狀態</h2>
            </div>
            <div className="divide-y divide-[#F5F7FC]">
              {data.sectors.map((s) => {
                const last = s.trail[s.trail.length - 1];
                const prev = s.trail[s.trail.length - 4] ?? s.trail[0];
                const dxDir = last.x - prev.x > 0 ? "→" : "←";
                const dyDir = last.y - prev.y > 0 ? "↑" : "↓";
                const q = quadrantOf(s);
                return (
                  <div key={s.name} className="flex items-center px-4 py-2.5 gap-3">
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold text-[#0D1B2A]">{s.name}</span>
                        {q && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ color: q.color, background: q.color + "18" }}>
                            {q.label}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-[#6B7A99] mt-0.5">{s.ticker}</div>
                    </div>
                    <div className="text-right tabular-nums">
                      <div className="text-[12px] font-semibold text-[#0D1B2A]">
                        {last.x.toFixed(2)} <span className="text-[#6B7A99] text-[10px]">{dxDir}</span>
                      </div>
                      <div className="text-[11px] text-[#6B7A99]">
                        動能 {last.y.toFixed(2)} <span>{dyDir}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-4 py-2 border-t border-[#F5F7FC] text-[10px] text-[#6B7A99]">
              更新：{data.computed_at ? new Date(data.computed_at + "Z").toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "—"}
            </div>
          </div>
        )}

        {/* Legend */}
        <div className="bg-white border border-[#DDE2EC] rounded-2xl p-4">
          <h3 className="text-[11px] font-bold text-[#0D1B2A] mb-3">象限說明</h3>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "領先 Leading",   color: "#15803D", desc: "相對強 + 動能強，持有偏多" },
              { label: "弱化 Weakening", color: "#B45309", desc: "相對強 + 動能轉弱，注意獲利了結" },
              { label: "改善 Improving", color: "#1D4ED8", desc: "相對弱 + 動能回升，潛在布局機會" },
              { label: "落後 Lagging",   color: "#B91C1C", desc: "相對弱 + 動能弱，避免進場" },
            ].map((q) => (
              <div key={q.label} className="flex items-start gap-2">
                <div className="w-2 h-2 rounded-full mt-1 shrink-0" style={{ background: q.color }} />
                <div>
                  <div className="text-[11px] font-semibold" style={{ color: q.color }}>{q.label}</div>
                  <div className="text-[10px] text-[#6B7A99] mt-0.5">{q.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-[#6B7A99] mt-3 leading-relaxed">
            資料以 ETF 為各類股代理：半導體(00929)、科技電子(0052)、金融(0055)、生技(00515)、
            高息傳產(0056)、航運(00895)、電動車(00893)。基準指數：0050（元大台灣50）。
          </p>
        </div>
      </div>
    </div>
  );
}

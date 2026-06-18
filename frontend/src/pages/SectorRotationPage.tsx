import { useCallback, useEffect, useRef, useState } from "react";
import { stocksApi } from "../api/client";

// ── types ──────────────────────────────────────────────────────────────────

interface Bubble {
  name: string;
  x: number;       // 20日累積成交量（相對）
  y: number;       // 加速度（5日均 - 20日均）
  size: number;    // 同 x
  amt_5d: number;  // 近5日量
  amt_20d: number; // 近20日量
  rt_amt: number;  // 今日成交金額（億元）
}

interface SectorChipData {
  bubbles: Bubble[];
  trading_days: number;
  latest_date: string;
  computed_at: string;
}

// ── chart constants ────────────────────────────────────────────────────────

const W = 560;
const H = 480;
const PAD = { top: 40, right: 24, bottom: 50, left: 58 };
const CW = W - PAD.left - PAD.right;
const CH = H - PAD.top - PAD.bottom;

const Q_META = [
  { label: "主力", desc: "資金加速流入", color: "#15803D", bg: "rgba(21,128,61,0.05)",  xSide: "right", ySide: "top"    },
  { label: "輪動", desc: "流入放緩",     color: "#B45309", bg: "rgba(180,83,9,0.05)",   xSide: "right", ySide: "bottom" },
  { label: "觀望", desc: "方向不明",     color: "#1D4ED8", bg: "rgba(29,78,216,0.05)",  xSide: "left",  ySide: "top"    },
  { label: "退潮", desc: "籌碼鬆動",     color: "#B91C1C", bg: "rgba(185,28,28,0.05)",  xSide: "left",  ySide: "bottom" },
];

function quadrant(b: Bubble) {
  if (b.x >= 0 && b.y >= 0) return 0; // 主力
  if (b.x >= 0 && b.y < 0)  return 1; // 輪動
  if (b.x < 0  && b.y >= 0) return 2; // 觀望
  return 3;                            // 退潮
}

function fmtK(v: number) {
  const abs = Math.abs(v);
  const sign = v >= 0 ? "+" : "-";
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}M`;
  return `${sign}${abs.toFixed(0)}K`;
}

// ── component ──────────────────────────────────────────────────────────────

export default function SectorRotationPage() {
  const [data, setData] = useState<SectorChipData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<Bubble | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [filter, setFilter] = useState<number | null>(null);

  // zoom / pan
  const svgRef = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState({ scale: 1, tx: 0, ty: 0 });
  const [dragging, setDragging] = useState(false);
  const dragOrigin = useRef({ clientX: 0, clientY: 0, tx0: 0, ty0: 0 });

  const resetZoom = () => setZoom({ scale: 1, tx: 0, ty: 0 });
  const isZoomed = zoom.scale !== 1 || zoom.tx !== 0 || zoom.ty !== 0;

  // non-passive wheel to allow preventDefault
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (W / rect.width);
    const my = (e.clientY - rect.top) * (H / rect.height);
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    setZoom(prev => {
      const newScale = Math.min(12, Math.max(0.4, prev.scale * factor));
      return {
        scale: newScale,
        tx: mx - (mx - prev.tx) * (newScale / prev.scale),
        ty: my - (my - prev.ty) * (newScale / prev.scale),
      };
    });
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  // stop drag on mouseup outside SVG
  useEffect(() => {
    const stop = () => setDragging(false);
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  const onSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    setDragging(true);
    dragOrigin.current = { clientX: e.clientX, clientY: e.clientY, tx0: zoom.tx, ty0: zoom.ty };
  };

  const onSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (!dragging) return;
    const ratio = W / rect.width;
    const dx = (e.clientX - dragOrigin.current.clientX) * ratio;
    const dy = (e.clientY - dragOrigin.current.clientY) * ratio;
    setZoom(z => ({ ...z, tx: dragOrigin.current.tx0 + dx, ty: dragOrigin.current.ty0 + dy }));
  };

  useEffect(() => {
    setLoading(true);
    stocksApi.sectorRotation()
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message ?? "載入失敗"); setLoading(false); });
  }, []);

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center text-gray-500">
      載入類股籌碼資料中…
    </div>
  );
  if (error) return (
    <div className="min-h-screen flex items-center justify-center text-red-500">{error}</div>
  );
  if (!data) return null;

  const bubbles = filter === null ? data.bubbles : data.bubbles.filter(b => quadrant(b) === filter);

  // axis ranges: symmetric around 0, pad by 20%
  const maxAbs = Math.max(...data.bubbles.map(b => Math.abs(b.x)), 1);
  const maxAbsY = Math.max(...data.bubbles.map(b => Math.abs(b.y)), 1);
  const xMin = -maxAbs * 1.2;
  const xMax =  maxAbs * 1.2;
  const yMin = -maxAbsY * 1.2;
  const yMax =  maxAbsY * 1.2;

  // bubble size: max radius = 26, min = 5
  const maxSize = Math.max(...data.bubbles.map(b => b.size), 1);
  const r = (b: Bubble) => 5 + (b.size / maxSize) * 21;

  const toSvgX = (v: number) => PAD.left + ((v - xMin) / (xMax - xMin)) * CW;
  const toSvgY = (v: number) => PAD.top  + ((yMax - v) / (yMax - yMin)) * CH;

  const ox = toSvgX(0);
  const oy = toSvgY(0);

  // quadrant counts
  const counts = [0, 1, 2, 3].map(q => data.bubbles.filter(b => quadrant(b) === q).length);

  const fmtDate = (s: string) => `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}`;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      {/* header */}
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">概念股籌碼輪動圖</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            依 nstock 概念股清單彙整成交金額 · 最新資料：{fmtDate(data.latest_date)} · {data.trading_days} 個交易日
          </p>
        </div>
        <div className="text-xs text-gray-400">
          橫軸 20日累積成交金額（十億） · 縱軸 加速度（近5日均 − 近20日均）· 泡泡大小 = 成交規模
        </div>
      </div>

      {/* quadrant filter pills */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilter(null)}
          className={`px-3 py-1 rounded-full text-sm font-medium border transition ${
            filter === null ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
          }`}
        >
          全部 ({data.bubbles.length})
        </button>
        {Q_META.map((q, i) => (
          <button
            key={q.label}
            onClick={() => setFilter(filter === i ? null : i)}
            className={`px-3 py-1 rounded-full text-sm font-medium border transition`}
            style={filter === i ? { background: q.color, color: "#fff", borderColor: q.color } : { background: "#fff", color: q.color, borderColor: q.color }}
          >
            {q.label} ({counts[i]})
          </button>
        ))}
      </div>

      {/* chart */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="relative overflow-x-auto">
          {isZoomed && (
            <button
              onClick={resetZoom}
              className="absolute top-2 right-2 z-10 px-2.5 py-1 text-xs font-medium bg-white border border-gray-300 rounded-lg shadow-sm hover:bg-gray-50 transition"
            >
              重設縮放
            </button>
          )}
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            style={{ minWidth: 320, cursor: dragging ? "grabbing" : "grab" }}
            onMouseDown={onSvgMouseDown}
            onMouseMove={onSvgMouseMove}
            onMouseLeave={() => { setDragging(false); setHovered(null); }}
          >
            <defs>
              <clipPath id="chart-clip">
                <rect x={PAD.left} y={PAD.top} width={CW} height={CH} />
              </clipPath>
            </defs>

            {/* fixed quadrant backgrounds (always fill correct quadrants) */}
            <rect x={ox} y={PAD.top} width={W - PAD.right - ox} height={oy - PAD.top} fill="rgba(21,128,61,0.04)" />
            <rect x={PAD.left} y={PAD.top} width={ox - PAD.left} height={oy - PAD.top} fill="rgba(29,78,216,0.04)" />
            <rect x={ox} y={oy} width={W - PAD.right - ox} height={H - PAD.bottom - oy} fill="rgba(180,83,9,0.04)" />
            <rect x={PAD.left} y={oy} width={ox - PAD.left} height={H - PAD.bottom - oy} fill="rgba(185,28,28,0.04)" />

            {/* fixed quadrant labels */}
            <text x={W - PAD.right - 6} y={PAD.top + 16} fontSize={11} fontWeight={700} fill="#15803D" textAnchor="end">主力</text>
            <text x={PAD.left + 6} y={PAD.top + 16} fontSize={11} fontWeight={700} fill="#1D4ED8">觀望</text>
            <text x={W - PAD.right - 6} y={H - PAD.bottom - 6} fontSize={11} fontWeight={700} fill="#B45309" textAnchor="end">輪動</text>
            <text x={PAD.left + 6} y={H - PAD.bottom - 6} fontSize={11} fontWeight={700} fill="#B91C1C">退潮</text>

            {/* fixed axis direction labels */}
            <text x={W - PAD.right - 2} y={PAD.top + 10} fontSize={9} fill="#6b7280" textAnchor="end">累積流入 →</text>
            <text x={PAD.left + 4} y={PAD.top + 10} fontSize={9} fill="#6b7280">加速 ↑</text>

            {/* zoomable + clipped chart content */}
            <g clipPath="url(#chart-clip)">
              <g transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`}>
                {/* grid lines */}
                {[-0.5, 0.5].map(f => (
                  <g key={f}>
                    <line x1={toSvgX(xMin + (xMax - xMin) * (0.5 + f * 0.5))} y1={PAD.top} x2={toSvgX(xMin + (xMax - xMin) * (0.5 + f * 0.5))} y2={H - PAD.bottom} stroke="#e5e7eb" strokeWidth={0.5 / zoom.scale} />
                    <line x1={PAD.left} y1={toSvgY(yMin + (yMax - yMin) * (0.5 + f * 0.5))} x2={W - PAD.right} y2={toSvgY(yMin + (yMax - yMin) * (0.5 + f * 0.5))} stroke="#e5e7eb" strokeWidth={0.5 / zoom.scale} />
                  </g>
                ))}

                {/* axes */}
                <line x1={PAD.left} y1={oy} x2={W - PAD.right} y2={oy} stroke="#9ca3af" strokeWidth={1 / zoom.scale} />
                <line x1={ox} y1={PAD.top} x2={ox} y2={H - PAD.bottom} stroke="#9ca3af" strokeWidth={1 / zoom.scale} />

                {/* x axis ticks */}
                {[-1, -0.5, 0.5, 1].map(f => {
                  const val = f * maxAbs;
                  const sx = toSvgX(val);
                  return (
                    <g key={f}>
                      <line x1={sx} y1={oy - 3 / zoom.scale} x2={sx} y2={oy + 3 / zoom.scale} stroke="#9ca3af" strokeWidth={1 / zoom.scale} />
                      <text x={sx} y={oy + 13 / zoom.scale} fontSize={8 / zoom.scale} fill="#9ca3af" textAnchor="middle">
                        {fmtK(val)}
                      </text>
                    </g>
                  );
                })}

                {/* y axis ticks */}
                {[-0.75, -0.25, 0.25, 0.75].map(f => {
                  const val = f * maxAbsY;
                  const sy = toSvgY(val);
                  return (
                    <g key={f}>
                      <line x1={ox - 3 / zoom.scale} y1={sy} x2={ox + 3 / zoom.scale} y2={sy} stroke="#9ca3af" strokeWidth={1 / zoom.scale} />
                      <text x={ox - 5 / zoom.scale} y={sy + 3 / zoom.scale} fontSize={8 / zoom.scale} fill="#9ca3af" textAnchor="end">
                        {fmtK(val)}
                      </text>
                    </g>
                  );
                })}

                {/* bubbles */}
                {bubbles.map(b => {
                  const q = quadrant(b);
                  const color = Q_META[q].color;
                  const bx = toSvgX(b.x);
                  const by = toSvgY(b.y);
                  const rad = r(b);
                  const isHov = hovered?.name === b.name;
                  return (
                    <g
                      key={b.name}
                      onMouseEnter={() => !dragging && setHovered(b)}
                      onMouseLeave={() => setHovered(null)}
                      style={{ cursor: dragging ? "grabbing" : "pointer" }}
                    >
                      <circle
                        cx={bx}
                        cy={by}
                        r={rad / zoom.scale}
                        fill={color}
                        fillOpacity={isHov ? 0.55 : 0.28}
                        stroke={color}
                        strokeWidth={(isHov ? 1.5 : 0.8) / zoom.scale}
                      />
                      {rad > 10 && (
                        <text
                          x={bx}
                          y={by + 3 / zoom.scale}
                          fontSize={(rad > 16 ? 9 : 8) / zoom.scale}
                          fill={color}
                          textAnchor="middle"
                          fontWeight={600}
                          pointerEvents="none"
                        >
                          {b.name.length > 5 ? b.name.slice(0, 5) + "…" : b.name}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </g>
          </svg>

          {/* tooltip */}
          {hovered && !dragging && (
            <div
              className="absolute pointer-events-none z-10 bg-white border border-gray-200 shadow-lg rounded-xl px-3 py-2 text-xs"
              style={{
                left: mousePos.x + 14,
                top: mousePos.y - 10,
                maxWidth: 200,
              }}
            >
              <div className="font-bold text-gray-900 mb-1">{hovered.name}</div>
              <div className="flex flex-col gap-0.5 text-gray-600">
                <span>狀態：<span style={{ color: Q_META[quadrant(hovered)].color }} className="font-semibold">{Q_META[quadrant(hovered)].label} ({Q_META[quadrant(hovered)].desc})</span></span>
                <span>今日成交金額：<span className="text-gray-900 font-medium">{hovered.rt_amt} 億元</span></span>
                <span>近20日累積金額：<span className="text-gray-900 font-medium">{hovered.amt_20d} 十億</span></span>
                <span>近5日累積金額：<span className="text-gray-900 font-medium">{hovered.amt_5d} 十億</span></span>
                <span>加速度：<span className={hovered.y >= 0 ? "text-red-600" : "text-green-700"}>{hovered.y >= 0 ? "+" : ""}{hovered.y}</span></span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* table */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-700">
          概念股列表（{bubbles.length} 個）
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 uppercase">
                <th className="text-left px-4 py-2">概念股</th>
                <th className="text-right px-4 py-2">狀態</th>
                <th className="text-right px-4 py-2">今日成交金額（億）</th>
                <th className="text-right px-4 py-2">20日累積金額（十億）</th>
                <th className="text-right px-4 py-2">加速度</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {bubbles
                .slice()
                .sort((a, b_) => b_.size - a.size)
                .map(b => {
                  const q = quadrant(b);
                  const color = Q_META[q].color;
                  return (
                    <tr
                      key={b.name}
                      className={`hover:bg-gray-50 transition ${hovered?.name === b.name ? "bg-blue-50" : ""}`}
                      onMouseEnter={() => setHovered(b)}
                      onMouseLeave={() => setHovered(null)}
                    >
                      <td className="px-4 py-2.5 text-gray-900 font-medium">{b.name}</td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: `${color}18`, color }}>
                          {Q_META[q].label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-gray-800">
                        {b.rt_amt}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-gray-800">
                        {b.amt_20d}
                      </td>
                      <td className={`px-4 py-2.5 text-right ${b.y >= 0 ? "text-red-500" : "text-green-600"}`}>
                        {b.y >= 0 ? "+" : ""}{b.y}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

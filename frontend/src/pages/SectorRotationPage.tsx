import { useCallback, useEffect, useRef, useState } from "react";
import { stocksApi } from "../api/client";

// ── types ──────────────────────────────────────────────────────────────────

interface StockBubble {
  code: string;
  name: string;
  x: number;
  y: number;
  size: number;
  amt_5d: number;
  amt_20d: number;
  rt_amt: number;
}

interface Bubble {
  name: string;
  x: number;
  y: number;
  size: number;
  amt_5d: number;
  amt_20d: number;
  rt_amt: number;
  stocks?: StockBubble[];
}

interface SectorChipData {
  bubbles: Bubble[];
  trading_days: number;
  latest_date: string;
  computing?: boolean;
  computed_at: string;
}

// ── chart constants ────────────────────────────────────────────────────────

const W = 620;
const H = 500;
const PAD = { top: 44, right: 32, bottom: 52, left: 62 };
const CW = W - PAD.left - PAD.right;
const CH = H - PAD.top - PAD.bottom;
const CHART_BG = "#0C1018";

const Q_META = [
  { label: "主力", desc: "資金加速流入", color: "#10B981", corner: "top-right"    },
  { label: "輪動", desc: "流入但放緩",   color: "#F59E0B", corner: "bottom-right" },
  { label: "觀望", desc: "資金匯聚",     color: "#818CF8", corner: "top-left"     },
  { label: "退潮", desc: "資金流出",     color: "#FB923C", corner: "bottom-left"  },
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
  const [hovered, setHovered] = useState<Bubble | StockBubble | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [filter, setFilter] = useState<number | null>(null);
  const [drillDown, setDrillDown] = useState<Bubble | null>(null); // 下鑽概念

  // zoom / pan
  const svgRef = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState({ scale: 1, tx: 0, ty: 0 });
  const [dragging, setDragging] = useState(false);
  const dragOrigin = useRef({ clientX: 0, clientY: 0, tx0: 0, ty0: 0 });
  // touch: track last pinch distance and midpoint
  const touchRef = useRef({ dist: 0, mx: 0, my: 0, tx0: 0, ty0: 0, scale0: 1 });

  const resetZoom = () => setZoom({ scale: 1, tx: 0, ty: 0 });
  const isZoomed = zoom.scale !== 1 || zoom.tx !== 0 || zoom.ty !== 0;

  const applyZoomAt = useCallback((mx: number, my: number, factor: number) => {
    setZoom(prev => {
      const newScale = Math.min(12, Math.max(0.4, prev.scale * factor));
      return {
        scale: newScale,
        tx: mx - (mx - prev.tx) * (newScale / prev.scale),
        ty: my - (my - prev.ty) * (newScale / prev.scale),
      };
    });
  }, []);

  // non-passive wheel (mouse scroll / trackpad)
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (W / rect.width);
    const my = (e.clientY - rect.top) * (H / rect.height);
    applyZoomAt(mx, my, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, [applyZoomAt]);

  // touch events: pinch-to-zoom + single-finger pan
  const handleTouchStart = useCallback((e: TouchEvent) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const ratio = W / rect.width;
    if (e.touches.length === 2) {
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const mx = ((t0.clientX + t1.clientX) / 2 - rect.left) * ratio;
      const my = ((t0.clientY + t1.clientY) / 2 - rect.top) * ratio;
      setZoom(prev => {
        touchRef.current = { dist, mx, my, tx0: prev.tx, ty0: prev.ty, scale0: prev.scale };
        return prev;
      });
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      setZoom(prev => {
        dragOrigin.current = { clientX: t.clientX, clientY: t.clientY, tx0: prev.tx, ty0: prev.ty };
        return prev;
      });
      setDragging(true);
    }
  }, []);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const ratio = W / rect.width;
    if (e.touches.length === 2) {
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const ref = touchRef.current;
      if (ref.dist === 0) return;
      const factor = dist / ref.dist;
      const newScale = Math.min(12, Math.max(0.4, ref.scale0 * factor));
      setZoom({
        scale: newScale,
        tx: ref.mx - (ref.mx - ref.tx0) * (newScale / ref.scale0),
        ty: ref.my - (ref.my - ref.ty0) * (newScale / ref.scale0),
      });
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      const dx = (t.clientX - dragOrigin.current.clientX) * ratio;
      const dy = (t.clientY - dragOrigin.current.clientY) * ratio;
      setZoom(z => ({ ...z, tx: dragOrigin.current.tx0 + dx, ty: dragOrigin.current.ty0 + dy }));
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    touchRef.current.dist = 0;
    setDragging(false);
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.addEventListener("wheel", handleWheel, { passive: false });
    svg.addEventListener("touchstart", handleTouchStart, { passive: false });
    svg.addEventListener("touchmove", handleTouchMove, { passive: false });
    svg.addEventListener("touchend", handleTouchEnd);
    return () => {
      svg.removeEventListener("wheel", handleWheel);
      svg.removeEventListener("touchstart", handleTouchStart);
      svg.removeEventListener("touchmove", handleTouchMove);
      svg.removeEventListener("touchend", handleTouchEnd);
    };
  }, [handleWheel, handleTouchStart, handleTouchMove, handleTouchEnd]);

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
    let cancelled = false;
    let retries = 0;
    const MAX_RETRIES = 10;

    const poll = () => {
      stocksApi.sectorRotation()
        .then(d => {
          if (cancelled) return;
          if (d.computing) {
            // 背景計算中，3 秒後再試
            setTimeout(poll, 3000);
          } else {
            setData(d);
            setLoading(false);
          }
        })
        .catch(() => {
          if (cancelled) return;
          // 冷啟動或暫時錯誤 → 最多重試 MAX_RETRIES 次
          retries++;
          if (retries < MAX_RETRIES) {
            setTimeout(poll, 4000);
          } else {
            setError("伺服器無回應，請稍後再試");
            setLoading(false);
          }
        });
    };
    poll();
    return () => { cancelled = true; };
  }, []);

  if (loading) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-2 text-gray-500">
      <div className="text-base">概念股籌碼資料計算中…</div>
      <div className="text-sm text-gray-400">首次載入需等待 30–90 秒，請稍候</div>
    </div>
  );
  if (error) return (
    <div className="min-h-screen flex items-center justify-center text-red-500">{error}</div>
  );
  if (!data) return null;

  // 下鑽時用個股清單，否則用概念清單
  const activeBubbles: (Bubble | StockBubble)[] = drillDown
    ? (drillDown.stocks ?? [])
    : (filter === null ? data.bubbles : data.bubbles.filter(b => quadrant(b) === filter));

  // axis ranges: symmetric around 0, pad by 20%
  const allB = drillDown ? (drillDown.stocks ?? []) : data.bubbles;
  const maxAbs  = Math.max(...allB.map(b => Math.abs(b.x)), 1);
  const maxAbsY = Math.max(...allB.map(b => Math.abs(b.y)), 1);
  const xMin = -maxAbs * 1.2;
  const xMax =  maxAbs * 1.2;
  const yMin = -maxAbsY * 1.2;
  const yMax =  maxAbsY * 1.2;

  // bubble size: max radius = 26, min = 5
  const maxSize = Math.max(...allB.map(b => b.size), 1);
  const r = (b: Bubble | StockBubble) => 5 + (b.size / maxSize) * 21;

  const toSvgX = (v: number) => PAD.left + ((v - xMin) / (xMax - xMin)) * CW;
  const toSvgY = (v: number) => PAD.top  + ((yMax - v) / (yMax - yMin)) * CH;

  const ox = toSvgX(0);
  const oy = toSvgY(0);

  // quadrant counts (概念層）
  const counts = [0, 1, 2, 3].map(q => data.bubbles.filter(b => quadrant(b) === q).length);

  const fmtDate = (s: string) => s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : "—";
  // 概念層 x 單位為十億，×10 顯示億；個股層 x 已是億
  const fmtAmt = (x: number) => `${x >= 0 ? "+" : ""}${(drillDown ? x : x * 10).toFixed(1)}億`;

  const handleBubbleClick = (b: Bubble | StockBubble) => {
    if (dragging) return;
    if (!drillDown && "stocks" in b && b.stocks?.length) {
      setDrillDown(b as Bubble);
      resetZoom();
      setFilter(null);
      setHovered(null);
    }
  };

  const handleBackToConcepts = () => {
    setDrillDown(null);
    resetZoom();
    setHovered(null);
  };

  const DARK = "rgba(255,255,255,";
  const gridColor = `${DARK}0.07)`;
  const axisColor = `${DARK}0.22)`;
  const tickColor = `${DARK}0.38)`;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
      {/* ── 標題列 ── */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            {drillDown ? (
              <>
                <button onClick={handleBackToConcepts} className="text-sm text-blue-500 hover:underline">← 概念股輪動</button>
                <span className="text-gray-300">/</span>
                <span className="text-lg font-bold text-gray-900">{drillDown.name}</span>
              </>
            ) : (
              <h1 className="text-xl font-bold text-gray-900">台股概念股輪動</h1>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            資料日期：{fmtDate(data.latest_date)} · {data.trading_days} 個交易日 · nstock 概念股清單
          </p>
        </div>
        <p className="text-xs text-gray-400">
          {drillDown ? "橫軸 個股20日累積金額（億）· 縱軸 5日均 − 20日均加速度" : "橫軸 概念20日累積金額 · 縱軸 加速度 · 泡泡大小 ∝ 成交量"}
        </p>
      </div>

      {/* ── 深色主卡：sidebar + 圖表 ── */}
      <div className="rounded-2xl overflow-hidden flex" style={{ background: CHART_BG, border: "1px solid rgba(255,255,255,0.08)" }}>

        {/* 左側象限統計（概念層才顯示） */}
        {!drillDown && (
          <div className="w-[120px] shrink-0 flex flex-col" style={{ borderRight: "1px solid rgba(255,255,255,0.08)" }}>
            {Q_META.map((q, i) => (
              <button
                key={q.label}
                onClick={() => setFilter(filter === i ? null : i)}
                className="flex-1 px-3 py-4 text-left transition-colors"
                style={{
                  borderLeft: `3px solid ${filter === i ? q.color : "transparent"}`,
                  background: filter === i ? `${q.color}15` : "transparent",
                }}
              >
                <div className="text-2xl font-black leading-none" style={{ color: q.color }}>{counts[i]}</div>
                <div className="text-xs font-semibold mt-1" style={{ color: "rgba(255,255,255,0.8)" }}>{q.label}</div>
                <div className="text-[10px] leading-tight mt-0.5" style={{ color: "rgba(255,255,255,0.35)" }}>{q.desc}</div>
              </button>
            ))}
            {/* 篩選中說明 */}
            {filter !== null && (
              <button
                onClick={() => setFilter(null)}
                className="py-2 text-[10px] text-center transition-colors hover:text-white"
                style={{ color: "rgba(255,255,255,0.3)", borderTop: "1px solid rgba(255,255,255,0.08)" }}
              >
                清除篩選
              </button>
            )}
          </div>
        )}

        {/* 圖表區 */}
        <div className="flex-1 relative min-w-0">
          {/* 縮放控制按鈕 */}
          <div className="absolute top-2.5 right-2.5 z-10 flex items-center gap-1">
            <button
              onClick={() => setZoom(prev => {
                const cx = W / 2, cy = H / 2;
                const newScale = Math.min(12, prev.scale * 1.4);
                return { scale: newScale, tx: cx - (cx - prev.tx) * (newScale / prev.scale), ty: cy - (cy - prev.ty) * (newScale / prev.scale) };
              })}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-base font-bold transition"
              style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)" }}
              title="放大"
            >+</button>
            <button
              onClick={() => setZoom(prev => {
                const cx = W / 2, cy = H / 2;
                const newScale = Math.max(0.4, prev.scale / 1.4);
                return { scale: newScale, tx: cx - (cx - prev.tx) * (newScale / prev.scale), ty: cy - (cy - prev.ty) * (newScale / prev.scale) };
              })}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-base font-bold transition"
              style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)" }}
              title="縮小"
            >−</button>
            {isZoomed && (
              <button
                onClick={resetZoom}
                className="px-2.5 h-7 text-xs font-medium rounded-lg transition"
                style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)" }}
              >重設</button>
            )}
          </div>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            style={{ minWidth: 300, cursor: dragging ? "grabbing" : "grab", display: "block" }}
            onMouseDown={onSvgMouseDown}
            onMouseMove={onSvgMouseMove}
            onMouseLeave={() => { setDragging(false); setHovered(null); }}
          >
            <defs>
              <clipPath id="chart-clip">
                <rect x={PAD.left} y={PAD.top} width={CW} height={CH} />
              </clipPath>
            </defs>

            {/* 深色背景 */}
            <rect width={W} height={H} fill={CHART_BG} />

            {/* 固定：象限角落標籤 */}
            <text x={PAD.left + 6} y={PAD.top + 16} fontSize={10} fill={Q_META[2].color} fontWeight={700}>觀望</text>
            <text x={W - PAD.right - 6} y={PAD.top + 16} fontSize={10} fill={Q_META[0].color} fontWeight={700} textAnchor="end">主力加速流入 ★</text>
            <text x={PAD.left + 6} y={H - PAD.bottom - 7} fontSize={10} fill={Q_META[3].color} fontWeight={700}>退潮</text>
            <text x={W - PAD.right - 6} y={H - PAD.bottom - 7} fontSize={10} fill={Q_META[1].color} fontWeight={700} textAnchor="end">輪動</text>

            {/* 固定：軸方向標籤 */}
            <text x={W - PAD.right} y={H - PAD.bottom + 38} fontSize={8.5} fill={tickColor} textAnchor="end">資金流入（億）→</text>
            <text x={PAD.left} y={H - PAD.bottom + 38} fontSize={8.5} fill={tickColor}>← 資金流出（億）</text>
            <text x={ox < PAD.left + 20 ? PAD.left + 4 : ox + 4} y={PAD.top + 28} fontSize={8} fill={tickColor}>加速 ↑</text>

            {/* 可縮放內容 */}
            <g clipPath="url(#chart-clip)">
              <g transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`}>

                {/* 格線 */}
                {[-0.75, -0.5, -0.25, 0.25, 0.5, 0.75].map(f => {
                  const xv = toSvgX(xMin + (xMax - xMin) * (0.5 + f * 0.5));
                  const yv = toSvgY(yMin + (yMax - yMin) * (0.5 + f * 0.5));
                  return (
                    <g key={f}>
                      <line x1={xv} y1={PAD.top} x2={xv} y2={H - PAD.bottom} stroke={gridColor} strokeWidth={1 / zoom.scale} />
                      <line x1={PAD.left} y1={yv} x2={W - PAD.right} y2={yv} stroke={gridColor} strokeWidth={1 / zoom.scale} />
                    </g>
                  );
                })}

                {/* 軸線 */}
                <line x1={PAD.left} y1={oy} x2={W - PAD.right} y2={oy} stroke={axisColor} strokeWidth={1.5 / zoom.scale} />
                <line x1={ox} y1={PAD.top} x2={ox} y2={H - PAD.bottom} stroke={axisColor} strokeWidth={1.5 / zoom.scale} />

                {/* X 軸刻度 */}
                {[-1, -0.5, 0.5, 1].map(f => {
                  const val = f * maxAbs;
                  const sx = toSvgX(val);
                  const label = drillDown
                    ? `${val >= 0 ? "+" : ""}${val.toFixed(0)}億`
                    : `${val >= 0 ? "+" : ""}${(val * 10).toFixed(0)}億`;
                  return (
                    <g key={f}>
                      <line x1={sx} y1={oy - 4 / zoom.scale} x2={sx} y2={oy + 4 / zoom.scale} stroke={axisColor} strokeWidth={1 / zoom.scale} />
                      <text x={sx} y={oy + 14 / zoom.scale} fontSize={8 / zoom.scale} fill={tickColor} textAnchor="middle">{label}</text>
                    </g>
                  );
                })}

                {/* Y 軸刻度 */}
                {[-0.75, -0.25, 0.25, 0.75].map(f => {
                  const val = f * maxAbsY;
                  const sy = toSvgY(val);
                  return (
                    <g key={f}>
                      <line x1={ox - 4 / zoom.scale} y1={sy} x2={ox + 4 / zoom.scale} y2={sy} stroke={axisColor} strokeWidth={1 / zoom.scale} />
                      <text x={PAD.left - 4 / zoom.scale} y={sy + 3 / zoom.scale} fontSize={8 / zoom.scale} fill={tickColor} textAnchor="end">
                        {val >= 0 ? "+" : ""}{val.toFixed(1)}
                      </text>
                    </g>
                  );
                })}

                {/* 泡泡 */}
                {activeBubbles.map(b => {
                  const q = quadrant(b);
                  const color = Q_META[q].color;
                  const bx = toSvgX(b.x);
                  const by = toSvgY(b.y);
                  const rad = r(b);
                  const scaledR = rad / zoom.scale;
                  const isHov = hovered?.name === b.name;
                  const canDrill = !drillDown && "stocks" in b && (b.stocks?.length ?? 0) > 0;

                  // 字體大小：隨泡泡縮放，保持在泡泡內部合理
                  const fs1 = Math.min(11, scaledR * 0.42);
                  const fs2 = Math.min(9.5, scaledR * 0.36);
                  const showTwoLine = scaledR > 20;
                  const showOneLine = scaledR > 11;

                  return (
                    <g
                      key={b.name}
                      onMouseEnter={() => !dragging && setHovered(b)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => handleBubbleClick(b)}
                      style={{ cursor: dragging ? "grabbing" : canDrill ? "zoom-in" : "default" }}
                    >
                      {/* 光暈環 */}
                      <circle cx={bx} cy={by} r={scaledR * 1.18} fill={color} fillOpacity={isHov ? 0.15 : 0.07} />
                      {/* 主體 */}
                      <circle
                        cx={bx} cy={by} r={scaledR}
                        fill={color}
                        fillOpacity={isHov ? 0.88 : 0.68}
                        stroke={color}
                        strokeWidth={(isHov ? 2 : 1) / zoom.scale}
                        strokeOpacity={isHov ? 1 : 0.7}
                      />
                      {/* 概念名稱 */}
                      {showOneLine && (
                        <text
                          x={bx}
                          y={by + (showTwoLine ? -fs1 * 0.6 : fs1 * 0.35)}
                          fontSize={fs1}
                          fill="white"
                          textAnchor="middle"
                          fontWeight={700}
                          pointerEvents="none"
                          style={{ textShadow: "0 1px 3px rgba(0,0,0,0.5)" }}
                        >
                          {b.name.length > 6 ? b.name.slice(0, 5) + "…" : b.name}
                        </text>
                      )}
                      {/* 金額 */}
                      {showTwoLine && (
                        <text
                          x={bx}
                          y={by + fs1 * 0.85}
                          fontSize={fs2}
                          fill="rgba(255,255,255,0.82)"
                          textAnchor="middle"
                          fontWeight={500}
                          pointerEvents="none"
                        >
                          {fmtAmt(b.x)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </g>
          </svg>

          {/* Tooltip */}
          {hovered && !dragging && (
            <div
              className="absolute pointer-events-none z-10 rounded-xl px-3 py-2.5 text-xs"
              style={{
                left: Math.min(mousePos.x + 14, 320),
                top: mousePos.y - 10,
                maxWidth: 210,
                background: "rgba(10,14,22,0.95)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "white",
                backdropFilter: "blur(8px)",
              }}
            >
              <div className="font-bold text-sm mb-1.5">
                {"code" in hovered
                  ? <><span className="font-mono text-gray-400 text-xs">{(hovered as StockBubble).code} </span>{hovered.name}</>
                  : hovered.name}
              </div>
              <div className="flex flex-col gap-1" style={{ color: "rgba(255,255,255,0.65)" }}>
                <div className="flex justify-between gap-3">
                  <span>狀態</span>
                  <span style={{ color: Q_META[quadrant(hovered)].color }} className="font-semibold">
                    {Q_META[quadrant(hovered)].label}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>今日成交</span>
                  <span className="text-white font-medium">{hovered.rt_amt} 億</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>20日累積</span>
                  <span className="text-white font-medium">
                    {"code" in hovered ? `${hovered.amt_20d} 億` : `${hovered.amt_20d} 十億`}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>加速度</span>
                  <span style={{ color: hovered.y >= 0 ? "#10B981" : "#FB923C" }} className="font-semibold">
                    {hovered.y >= 0 ? "+" : ""}{hovered.y}
                  </span>
                </div>
                {!drillDown && "stocks" in hovered && (hovered.stocks?.length ?? 0) > 0 && (
                  <div className="pt-1 text-blue-400 text-[10px]">🔍 點擊查看 {(hovered as Bubble).stocks!.length} 支成分股</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 下方表格 ── */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        {drillDown ? (
          <>
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-800">
                {drillDown.name} 成分股（{drillDown.stocks?.length ?? 0} 支）
              </span>
              <button onClick={handleBackToConcepts} className="text-xs text-blue-500 hover:underline">
                ← 返回概念股列表
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500">
                    <th className="text-left px-4 py-2.5 font-medium">代號</th>
                    <th className="text-left px-4 py-2.5 font-medium">名稱</th>
                    <th className="text-right px-4 py-2.5 font-medium">狀態</th>
                    <th className="text-right px-4 py-2.5 font-medium">今日成交（億）</th>
                    <th className="text-right px-4 py-2.5 font-medium">20日累積（億）</th>
                    <th className="text-right px-4 py-2.5 font-medium">加速度</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {(drillDown.stocks ?? []).map(s => {
                    const q = quadrant(s);
                    const color = Q_META[q].color;
                    return (
                      <tr
                        key={s.code}
                        className={`transition ${hovered?.name === s.name ? "bg-gray-50" : "hover:bg-gray-50"}`}
                        onMouseEnter={() => setHovered(s)}
                        onMouseLeave={() => setHovered(null)}
                      >
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-400">{s.code}</td>
                        <td className="px-4 py-2.5 text-gray-900 font-medium">{s.name}</td>
                        <td className="px-4 py-2.5 text-right">
                          <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: `${color}18`, color }}>
                            {Q_META[q].label}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-gray-800">{s.rt_amt}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-gray-800">{s.amt_20d}</td>
                        <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${s.y >= 0 ? "text-emerald-600" : "text-orange-500"}`}>
                          {s.y >= 0 ? "+" : ""}{s.y}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-800">
                概念股列表（{activeBubbles.length} 個）
              </span>
              <span className="text-xs text-gray-400">點擊列或泡泡可下鑽查看個股</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500">
                    <th className="text-left px-4 py-2.5 font-medium">概念股</th>
                    <th className="text-right px-4 py-2.5 font-medium">狀態</th>
                    <th className="text-right px-4 py-2.5 font-medium">今日成交（億）</th>
                    <th className="text-right px-4 py-2.5 font-medium">20日累積（十億）</th>
                    <th className="text-right px-4 py-2.5 font-medium">加速度</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {(activeBubbles as Bubble[]).slice().sort((a, z) => z.size - a.size).map(b => {
                    const q = quadrant(b);
                    const color = Q_META[q].color;
                    const canDrill = (b.stocks?.length ?? 0) > 0;
                    return (
                      <tr
                        key={b.name}
                        className={`transition ${hovered?.name === b.name ? "bg-gray-50" : "hover:bg-gray-50"} ${canDrill ? "cursor-pointer" : ""}`}
                        onMouseEnter={() => setHovered(b)}
                        onMouseLeave={() => setHovered(null)}
                        onClick={() => canDrill && handleBubbleClick(b)}
                      >
                        <td className="px-4 py-2.5 text-gray-900 font-medium">
                          {b.name}
                          {canDrill && <span className="ml-1.5 text-[10px] text-gray-400">({b.stocks!.length}支 ↗)</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: `${color}18`, color }}>
                            {Q_META[q].label}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-gray-800">{b.rt_amt}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-gray-800">{b.amt_20d}</td>
                        <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${b.y >= 0 ? "text-emerald-600" : "text-orange-500"}`}>
                          {b.y >= 0 ? "+" : ""}{b.y}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

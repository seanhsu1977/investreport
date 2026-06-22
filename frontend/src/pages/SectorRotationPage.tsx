import { useCallback, useEffect, useRef, useState } from "react";
import { stocksApi } from "../api/client";

// ── types ──────────────────────────────────────────────────────────────────

interface StockBubble {
  code: string; name: string; x: number; y: number; size: number;
  amt_5d: number; amt_20d: number; rt_amt: number;
}
interface Bubble {
  name: string; x: number; y: number; size: number;
  amt_5d: number; amt_20d: number; rt_amt: number;
  stocks?: StockBubble[];
}
interface SectorChipData {
  bubbles: Bubble[]; trading_days: number; latest_date: string;
  computing?: boolean; computed_at: string;
}

// ── chart constants ────────────────────────────────────────────────────────

const W = 620;
const H = 500;
const PAD = { top: 44, right: 32, bottom: 52, left: 62 };
const CW = W - PAD.left - PAD.right;
const CH = H - PAD.top - PAD.bottom;
const CHART_BG = "#0C1018";

const Q_META = [
  { label: "主力", desc: "錢正大力進場",   plain: "資金加速流入，最強勢", color: "#10B981" },
  { label: "輪動", desc: "熱度開始轉移",   plain: "資金持續流入但放緩",   color: "#F59E0B" },
  { label: "觀望", desc: "資金來但沒人接", plain: "動能回升，留意轉強",   color: "#818CF8" },
  { label: "退潮", desc: "資金流出，別追", plain: "資金持續流出，避開",   color: "#FB923C" },
];

function quadrant(b: { x: number; y: number }) {
  if (b.x >= 0 && b.y >= 0) return 0;
  if (b.x >= 0 && b.y < 0)  return 1;
  if (b.x < 0  && b.y >= 0) return 2;
  return 3;
}

// ── component ──────────────────────────────────────────────────────────────

export default function SectorRotationPage() {
  const [data, setData] = useState<SectorChipData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<Bubble | StockBubble | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [filter, setFilter] = useState<number | null>(null);
  const [drillDown, setDrillDown] = useState<Bubble | null>(null);
  const [search, setSearch] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [viewMode, setViewMode] = useState<"concepts" | "rankings">("concepts");

  // zoom / pan
  const svgRef = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState({ scale: 1, tx: 0, ty: 0 });
  const zoomRef = useRef(zoom);          // always up-to-date, readable from native event handlers
  zoomRef.current = zoom;               // sync on every render
  const [dragging, setDragging] = useState(false);
  const dragOrigin = useRef({ clientX: 0, clientY: 0, tx0: 0, ty0: 0 });
  const touchRef = useRef({ dist: 0, mx: 0, my: 0, tx0: 0, ty0: 0, scale0: 1 });

  const resetZoom = () => setZoom({ scale: 1, tx: 0, ty: 0 });
  const isZoomed = zoom.scale !== 1 || zoom.tx !== 0 || zoom.ty !== 0;

  // 防止 pan 超出範圍：始終保留至少 80px 的圖表在視窗內
  const clampPan = (tx: number, ty: number, s: number) => ({
    tx: Math.max(-W * s + 80, Math.min(W - 80, tx)),
    ty: Math.max(-H * s + 80, Math.min(H - 80, ty)),
  });

  const applyZoomAt = useCallback((mx: number, my: number, factor: number) => {
    setZoom(prev => {
      const newScale = Math.min(12, Math.max(0.4, prev.scale * factor));
      const raw = {
        tx: mx - (mx - prev.tx) * (newScale / prev.scale),
        ty: my - (my - prev.ty) * (newScale / prev.scale),
      };
      return { scale: newScale, ...clampPan(raw.tx, raw.ty, newScale) };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const svg = svgRef.current; if (!svg) return;
    const rect = svg.getBoundingClientRect();
    applyZoomAt((e.clientX - rect.left) * (W / rect.width), (e.clientY - rect.top) * (H / rect.height), e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, [applyZoomAt]);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    e.preventDefault();
    const svg = svgRef.current; if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const ratio = W / rect.width;
    const cz = zoomRef.current;           // read current zoom synchronously from ref
    if (e.touches.length === 2) {
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const mx = ((t0.clientX + t1.clientX) / 2 - rect.left) * ratio;
      const my = ((t0.clientY + t1.clientY) / 2 - rect.top) * ratio;
      touchRef.current = { dist, mx, my, tx0: cz.tx, ty0: cz.ty, scale0: cz.scale };
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      dragOrigin.current = { clientX: t.clientX, clientY: t.clientY, tx0: cz.tx, ty0: cz.ty };
      setDragging(true);
    }
  }, []);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    e.preventDefault();
    const svg = svgRef.current; if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const ratio = W / rect.width;
    if (e.touches.length === 2) {
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const ref = touchRef.current; if (ref.dist === 0) return;
      const factor = dist / ref.dist;
      const newScale = Math.min(12, Math.max(0.4, ref.scale0 * factor));
      const rawTx = ref.mx - (ref.mx - ref.tx0) * (newScale / ref.scale0);
      const rawTy = ref.my - (ref.my - ref.ty0) * (newScale / ref.scale0);
      setZoom({ scale: newScale, ...clampPan(rawTx, rawTy, newScale) });
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      const dx = (t.clientX - dragOrigin.current.clientX) * ratio;
      const dy = (t.clientY - dragOrigin.current.clientY) * ratio;
      setZoom(z => ({ ...z, ...clampPan(dragOrigin.current.tx0 + dx, dragOrigin.current.ty0 + dy, z.scale) }));
    }
  }, []);

  const handleTouchEnd = useCallback(() => { touchRef.current.dist = 0; setDragging(false); }, []);

  useEffect(() => {
    const svg = svgRef.current; if (!svg) return;
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
    setZoom(z => { const tx = dragOrigin.current.tx0 + (e.clientX - dragOrigin.current.clientX) * ratio; const ty = dragOrigin.current.ty0 + (e.clientY - dragOrigin.current.clientY) * ratio; return { ...z, ...clampPan(tx, ty, z.scale) }; });
  };

  useEffect(() => {
    let cancelled = false, retries = 0;
    const poll = () => {
      stocksApi.sectorRotation()
        .then(d => { if (cancelled) return; if (d.computing) setTimeout(poll, 3000); else { setData(d); setLoading(false); } })
        .catch(() => { if (cancelled) return; retries++; if (retries < 10) setTimeout(poll, 4000); else { setError("伺服器無回應，請稍後再試"); setLoading(false); } });
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
  if (error) return <div className="min-h-screen flex items-center justify-center text-red-500">{error}</div>;
  if (!data) return null;

  // ── derived data ──────────────────────────────────────────────────────────

  const sq = search.trim().toLowerCase();
  const allConcepts = filter === null ? data.bubbles : data.bubbles.filter(b => quadrant(b) === filter);
  const activeBubbles: (Bubble | StockBubble)[] = drillDown ? (drillDown.stocks ?? []) : allConcepts;

  const allB = drillDown ? (drillDown.stocks ?? []) : data.bubbles;
  const maxAbs  = Math.max(...allB.map(b => Math.abs(b.x)), 1);
  const maxAbsY = Math.max(...allB.map(b => Math.abs(b.y)), 1);
  const xMin = -maxAbs * 1.2, xMax = maxAbs * 1.2;
  const yMin = -maxAbsY * 1.2, yMax = maxAbsY * 1.2;

  const maxSize = Math.max(...allB.map(b => b.size), 1);
  const r = (b: Bubble | StockBubble) => 5 + (b.size / maxSize) * 21;

  const toSvgX = (v: number) => PAD.left + ((v - xMin) / (xMax - xMin)) * CW;
  const toSvgY = (v: number) => PAD.top  + ((yMax - v) / (yMax - yMin)) * CH;
  const ox = toSvgX(0), oy = toSvgY(0);

  const counts = [0, 1, 2, 3].map(q => data.bubbles.filter(b => quadrant(b) === q).length);

  // CP 值排行：資金流入（x>0）但加速度偏低 → 補漲機會
  const cpRanking = data.bubbles
    .filter(b => b.x > 0)
    .map(b => ({ b, score: b.amt_20d * (1 - Math.max(0, b.y) / (maxAbsY || 1)) }))
    .sort((a, z) => z.score - a.score)
    .slice(0, 5);

  // 抄底偵測：資金流出但動能回升（觀望象限，x<0 y>0）
  const dipRanking = data.bubbles
    .filter(b => quadrant(b) === 2)
    .sort((a, z) => z.y - a.y)
    .slice(0, 4);

  const fmtDate = (s: string) => s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : "—";
  const fmtAmt = (x: number) => `${x >= 0 ? "+" : ""}${(drillDown ? x : x * 10).toFixed(1)}億`;

  const handleBubbleClick = (b: Bubble | StockBubble) => {
    if (dragging) return;
    if (!drillDown && "stocks" in b && b.stocks?.length) {
      setDrillDown(b as Bubble); resetZoom(); setFilter(null); setHovered(null); setSearch("");
    }
  };
  const handleBackToConcepts = () => { setDrillDown(null); resetZoom(); setHovered(null); };

  const DARK = "rgba(255,255,255,";
  const gridColor = `${DARK}0.07)`, axisColor = `${DARK}0.22)`, tickColor = `${DARK}0.38)`;

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">

      {/* ── 標題列 ── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            {drillDown ? (
              <>
                <button onClick={handleBackToConcepts} className="text-sm text-blue-500 hover:underline">← 概念股輪動</button>
                <span className="text-gray-400">/</span>
                <span className="text-xl font-bold text-gray-900">{drillDown.name}</span>
              </>
            ) : (
              <h1 className="text-xl font-bold text-gray-900">台股概念股輪動</h1>
            )}
          </div>
          {/* 更新時間 - 放大顯示 */}
          <div className="flex items-center gap-2 mt-1">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2">
              <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
            </svg>
            <span className="text-sm font-medium text-gray-600">最後更新 {fmtDate(data.latest_date)}</span>
            <span className="text-xs text-gray-400">· {data.trading_days} 個交易日</span>
          </div>
        </div>

        {/* 控制列 */}
        {!drillDown && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowHelp(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition ${showHelp ? "bg-blue-50 text-blue-600 border border-blue-200" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
              怎麼看這張圖
            </button>
          </div>
        )}
      </div>

      {/* ── 新手引導 ── */}
      {showHelp && !drillDown && (
        <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "#0e1e35", border: "1px solid rgba(45,212,191,0.25)", color: "rgba(255,255,255,0.8)" }}>
          <div className="font-semibold mb-1.5" style={{ color: "#5eead4" }}>怎麼看這張圖</div>
          <div className="grid gap-1.5 text-xs" style={{ color: "rgba(255,255,255,0.65)" }}>
            <div><span style={{ color: "#5eead4" }}>橫軸（左右）</span>＝資金流入／流出，越右代表錢越多</div>
            <div><span style={{ color: "#5eead4" }}>縱軸（上下）</span>＝加速度（近5日均 − 近20日均），越上代表資金在加速流入</div>
            <div><span style={{ color: "#5eead4" }}>泡泡大小</span>＝成交規模，單位統一為「億元」</div>
            <div className="pt-1 flex flex-wrap gap-x-4 gap-y-1">
              {Q_META.map(q => (
                <span key={q.label}><span style={{ color: q.color }}>● {q.label}</span>：{q.plain}</span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── 搜尋列（概念層才顯示） ── */}
      {!drillDown && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-gray-200 shadow-sm">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜尋概念股名稱…"
            className="flex-1 text-sm outline-none text-gray-700 placeholder-gray-400 bg-transparent"
          />
          {sq && <button onClick={() => setSearch("")} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>}
        </div>
      )}

      {/* ── 主深色卡：左側圖表 + 右側排行面板 ── */}
      <div className="rounded-2xl overflow-hidden" style={{ background: CHART_BG, border: "1px solid rgba(255,255,255,0.08)" }}>
        <div className="flex flex-col lg:flex-row">

        {/* 左側：象限 sidebar + 圖表/榜單 */}
        <div className="flex flex-1 min-w-0">
      {true && (
        <div className="flex flex-1 min-w-0">

          {/* 左側象限統計（桌機顯示，手機隱藏）*/}
          <div className="hidden lg:flex w-[110px] shrink-0 flex-col" style={{ borderRight: "1px solid rgba(255,255,255,0.08)" }}>
            {drillDown ? (
              /* 下鑽模式：顯示概念股名稱 + 返回按鈕 */
              <div className="flex flex-col items-center justify-center flex-1 gap-3 px-2 text-center">
                <div className="text-[10px] font-semibold leading-tight" style={{ color: "rgba(255,255,255,0.5)" }}>{drillDown.name}</div>
                <div className="text-2xl font-black leading-none" style={{ color: "rgba(255,255,255,0.85)" }}>{drillDown.stocks?.length ?? 0}</div>
                <div className="text-[10px]" style={{ color: "rgba(255,255,255,0.3)" }}>支成分股</div>
                <button onClick={handleBackToConcepts}
                  className="mt-2 text-[10px] px-2 py-1 rounded transition hover:text-white"
                  style={{ color: "rgba(99,179,237,0.7)", border: "1px solid rgba(99,179,237,0.25)" }}>
                  ← 返回
                </button>
              </div>
            ) : (
              /* 概念股模式：象限統計 */
              <>
                {Q_META.map((q, i) => (
                  <button
                    key={q.label}
                    onClick={() => setFilter(filter === i ? null : i)}
                    className="flex-1 px-3 py-3 text-left transition-colors"
                    style={{ borderLeft: `3px solid ${filter === i ? q.color : "transparent"}`, background: filter === i ? `${q.color}15` : "transparent" }}
                  >
                    <div className="text-2xl font-black leading-none" style={{ color: q.color }}>{counts[i]}</div>
                    <div className="text-xs font-semibold mt-1" style={{ color: "rgba(255,255,255,0.8)" }}>{q.label}</div>
                    <div className="text-[10px] leading-tight mt-0.5" style={{ color: "rgba(255,255,255,0.35)" }}>{q.desc}</div>
                  </button>
                ))}
                {filter !== null && (
                  <button onClick={() => setFilter(null)} className="py-2 text-[10px] text-center hover:text-white" style={{ color: "rgba(255,255,255,0.3)", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                    清除篩選
                  </button>
                )}
              </>
            )}
          </div>

          {/* 圖表區 */}
          <div className="flex-1 min-w-0 flex flex-col">

          {/* 手機版象限計數橫排（桌機由左側 sidebar 顯示）*/}
          {!drillDown && (
            <div className="flex lg:hidden shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              {Q_META.map((q, i) => (
                <button key={q.label} onClick={() => setFilter(filter === i ? null : i)}
                  className="flex-1 flex flex-col items-center py-2.5 transition"
                  style={{ borderBottom: `2px solid ${filter === i ? q.color : "transparent"}`, background: filter === i ? `${q.color}12` : "transparent" }}>
                  <span className="text-lg font-black leading-none" style={{ color: q.color }}>{counts[i]}</span>
                  <span className="text-[10px] mt-0.5 font-medium" style={{ color: "rgba(255,255,255,0.6)" }}>{q.label}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex-1 relative min-w-0">
            {/* 縮放按鈕：圖表右上角（手機桌機都顯示）*/}
            <div className="absolute top-2.5 right-2.5 z-10 flex items-center gap-1">
              <button onClick={() => setZoom(prev => { const cx = W/2, cy = H/2, ns = Math.min(12, prev.scale*1.4); return { scale: ns, ...clampPan(cx-(cx-prev.tx)*(ns/prev.scale), cy-(cy-prev.ty)*(ns/prev.scale), ns) }; })}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-base font-bold" style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)" }}>+</button>
              <button onClick={() => setZoom(prev => { const cx = W/2, cy = H/2, ns = Math.max(0.4, prev.scale/1.4); return { scale: ns, ...clampPan(cx-(cx-prev.tx)*(ns/prev.scale), cy-(cy-prev.ty)*(ns/prev.scale), ns) }; })}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-base font-bold" style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)" }}>−</button>
              {isZoomed && <button onClick={resetZoom} className="px-2.5 h-7 text-xs font-medium rounded-lg" style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)" }}>重設</button>}
            </div>

            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 300, cursor: dragging ? "grabbing" : "grab", display: "block", touchAction: "none" }}
              onMouseDown={onSvgMouseDown} onMouseMove={onSvgMouseMove} onMouseLeave={() => { setDragging(false); setHovered(null); }}>
              <defs><clipPath id="chart-clip"><rect x={PAD.left} y={PAD.top} width={CW} height={CH} /></clipPath></defs>
              <rect width={W} height={H} fill={CHART_BG} />

              {/* 固定象限標籤 + 白話說明 */}
              <text x={PAD.left + 6} y={PAD.top + 14} fontSize={10} fill={Q_META[2].color} fontWeight={700}>觀望</text>
              <text x={PAD.left + 6} y={PAD.top + 26} fontSize={8.5} fill={Q_META[2].color} fillOpacity={0.55}>{Q_META[2].desc}</text>
              <text x={W - PAD.right - 6} y={PAD.top + 14} fontSize={10} fill={Q_META[0].color} fontWeight={700} textAnchor="end">主力加速流入 ★</text>
              <text x={W - PAD.right - 6} y={PAD.top + 26} fontSize={8.5} fill={Q_META[0].color} fillOpacity={0.55} textAnchor="end">{Q_META[0].desc}</text>
              <text x={PAD.left + 6} y={H - PAD.bottom - 14} fontSize={10} fill={Q_META[3].color} fontWeight={700}>退潮</text>
              <text x={PAD.left + 6} y={H - PAD.bottom - 3} fontSize={8.5} fill={Q_META[3].color} fillOpacity={0.55}>{Q_META[3].desc}</text>
              <text x={W - PAD.right - 6} y={H - PAD.bottom - 14} fontSize={10} fill={Q_META[1].color} fontWeight={700} textAnchor="end">輪動</text>
              <text x={W - PAD.right - 6} y={H - PAD.bottom - 3} fontSize={8.5} fill={Q_META[1].color} fillOpacity={0.55} textAnchor="end">{Q_META[1].desc}</text>

              {/* 軸方向 */}
              <text x={W - PAD.right} y={H - PAD.bottom + 38} fontSize={8.5} fill={tickColor} textAnchor="end">資金流入（億）→</text>
              <text x={PAD.left} y={H - PAD.bottom + 38} fontSize={8.5} fill={tickColor}>← 資金流出（億）</text>

              <g clipPath="url(#chart-clip)">
                <g transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`}>
                  {/* 格線 */}
                  {[-0.75, -0.5, -0.25, 0.25, 0.5, 0.75].map(f => {
                    const xv = toSvgX(xMin + (xMax - xMin) * (0.5 + f * 0.5));
                    const yv = toSvgY(yMin + (yMax - yMin) * (0.5 + f * 0.5));
                    return <g key={f}>
                      <line x1={xv} y1={PAD.top} x2={xv} y2={H - PAD.bottom} stroke={gridColor} strokeWidth={1 / zoom.scale} />
                      <line x1={PAD.left} y1={yv} x2={W - PAD.right} y2={yv} stroke={gridColor} strokeWidth={1 / zoom.scale} />
                    </g>;
                  })}
                  {/* 軸線 */}
                  <line x1={PAD.left} y1={oy} x2={W - PAD.right} y2={oy} stroke={axisColor} strokeWidth={1.5 / zoom.scale} />
                  <line x1={ox} y1={PAD.top} x2={ox} y2={H - PAD.bottom} stroke={axisColor} strokeWidth={1.5 / zoom.scale} />
                  {/* X 軸刻度 */}
                  {[-1, -0.5, 0.5, 1].map(f => {
                    const val = f * maxAbs, sx = toSvgX(val);
                    const lbl = drillDown ? `${val>=0?"+":""}${val.toFixed(0)}億` : `${val>=0?"+":""}${(val*10).toFixed(0)}億`;
                    return <g key={f}>
                      <line x1={sx} y1={oy - 4/zoom.scale} x2={sx} y2={oy + 4/zoom.scale} stroke={axisColor} strokeWidth={1/zoom.scale} />
                      <text x={sx} y={oy + 14/zoom.scale} fontSize={8/zoom.scale} fill={tickColor} textAnchor="middle">{lbl}</text>
                    </g>;
                  })}
                  {/* Y 軸刻度 */}
                  {[-0.75, -0.25, 0.25, 0.75].map(f => {
                    const val = f * maxAbsY, sy = toSvgY(val);
                    return <g key={f}>
                      <line x1={ox - 4/zoom.scale} y1={sy} x2={ox + 4/zoom.scale} y2={sy} stroke={axisColor} strokeWidth={1/zoom.scale} />
                      <text x={PAD.left - 4/zoom.scale} y={sy + 3/zoom.scale} fontSize={8/zoom.scale} fill={tickColor} textAnchor="end">{val>=0?"+":""}{val.toFixed(1)}</text>
                    </g>;
                  })}
                  {/* 泡泡 */}
                  {activeBubbles.map(b => {
                    const q = quadrant(b), color = Q_META[q].color;
                    const bx = toSvgX(b.x), by = toSvgY(b.y), rad = r(b);
                    const visualR = rad * zoom.scale;
                    const isHov = hovered?.name === b.name;
                    const canDrill = !drillDown && "stocks" in b && (b.stocks?.length ?? 0) > 0;
                    const isMatch = !sq || b.name.toLowerCase().includes(sq);
                    const fs1 = Math.min(rad * 0.42, 11 / zoom.scale);
                    const fs2 = Math.min(rad * 0.36, 9.5 / zoom.scale);
                    return (
                      <g key={b.name} onMouseEnter={() => !dragging && setHovered(b)} onMouseLeave={() => setHovered(null)}
                        onClick={() => handleBubbleClick(b)} style={{ cursor: dragging ? "grabbing" : canDrill ? "zoom-in" : "default" }}>
                        <circle cx={bx} cy={by} r={rad * 1.18} fill={color} fillOpacity={(isHov ? 0.15 : 0.07) * (isMatch ? 1 : 0.3)} />
                        <circle cx={bx} cy={by} r={rad} fill={color} fillOpacity={(isHov ? 0.88 : 0.68) * (isMatch ? 1 : 0.15)}
                          stroke={color} strokeWidth={(isHov ? 2 : 1)/zoom.scale} strokeOpacity={isMatch ? (isHov ? 1 : 0.7) : 0.2} />
                        {visualR > 11 && isMatch && (
                          <text x={bx} y={by + (visualR > 20 ? -fs1 * 0.6 : fs1 * 0.35)} fontSize={fs1} fill="white"
                            textAnchor="middle" fontWeight={700} pointerEvents="none">
                            {b.name.length > 6 ? b.name.slice(0, 5) + "…" : b.name}
                          </text>
                        )}
                        {visualR > 20 && isMatch && (
                          <text x={bx} y={by + fs1 * 0.85} fontSize={fs2} fill="rgba(255,255,255,0.82)"
                            textAnchor="middle" fontWeight={500} pointerEvents="none">
                            {fmtAmt(b.x)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              </g>
            </svg>

            {/* 圖例 */}
            <div className="flex items-center gap-3 px-4 py-2 text-xs flex-wrap" style={{ borderTop: "1px solid rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.4)" }}>
              <span>圖例：</span>
              {Q_META.map(q => (
                <span key={q.label} className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: q.color }} />
                  <span style={{ color: "rgba(255,255,255,0.6)" }}>{q.label}</span>
                </span>
              ))}
              {/* 移動按鈕：拖曳的替代操作 */}
              <div className="ml-auto flex items-center gap-1">
                {(["←","↑","↓","→"] as const).map((arrow) => {
                  const step = 80;
                  const dx = arrow === "←" ? step : arrow === "→" ? -step : 0;
                  const dy = arrow === "↑" ? step : arrow === "↓" ? -step : 0;
                  return (
                    <button key={arrow}
                      onClick={() => setZoom(z => ({ ...z, ...clampPan(z.tx + dx, z.ty + dy, z.scale) }))}
                      className="w-7 h-7 flex items-center justify-center rounded-lg text-sm" style={{background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.2)",color:"rgba(255,255,255,0.8)"}}>
                      {arrow}
                    </button>
                  );
                })}
                {isZoomed && <button onClick={resetZoom} className="px-2 h-7 text-xs font-medium rounded-lg ml-1" style={{background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.2)",color:"rgba(255,255,255,0.8)"}}>重設</button>}
              </div>
            </div>

            {/* Tooltip */}
            {hovered && !dragging && (
              <div className="absolute pointer-events-none z-10 rounded-xl px-3 py-2.5 text-xs"
                style={{ left: Math.min(mousePos.x + 14, 320), top: mousePos.y - 10, maxWidth: 210, background: "rgba(10,14,22,0.95)", border: "1px solid rgba(255,255,255,0.12)", color: "white", backdropFilter: "blur(8px)" }}>
                <div className="font-bold text-sm mb-1.5">
                  {"code" in hovered ? <><span className="font-mono text-gray-400 text-xs">{(hovered as StockBubble).code} </span>{hovered.name}</> : hovered.name}
                </div>
                <div className="flex flex-col gap-1" style={{ color: "rgba(255,255,255,0.65)" }}>
                  <div className="flex justify-between gap-3"><span>狀態</span><span style={{ color: Q_META[quadrant(hovered)].color }} className="font-semibold">{Q_META[quadrant(hovered)].label} · {Q_META[quadrant(hovered)].desc}</span></div>
                  <div className="flex justify-between gap-3"><span>今日成交</span><span className="text-white font-medium">{hovered.rt_amt} 億</span></div>
                  <div className="flex justify-between gap-3"><span>20日累積</span><span className="text-white font-medium">{"code" in hovered ? `${hovered.amt_20d} 億` : `${hovered.amt_20d} 十億`}</span></div>
                  <div className="flex justify-between gap-3"><span>加速度</span><span style={{ color: hovered.y >= 0 ? "#10B981" : "#FB923C" }} className="font-semibold">{hovered.y >= 0 ? "+" : ""}{hovered.y}</span></div>
                  {!drillDown && "stocks" in hovered && (hovered.stocks?.length ?? 0) > 0 && <div className="pt-1 text-blue-400 text-[10px]">🔍 點擊查看 {(hovered as Bubble).stocks!.length} 支成分股</div>}
                </div>
              </div>
            )}
          </div>
          </div>{/* /圖表區 flex-col wrapper */}
        </div>
      )}
        </div>{/* /左側 flex */}

        {/* 右側：概念股列表面板 */}
        <div className="lg:w-[300px] shrink-0 flex flex-col" style={{ borderTop: "1px solid rgba(255,255,255,0.08)", borderLeft: "none" }}
          // eslint-disable-next-line react/no-unknown-property
          {...({ "data-panel": true } as object)}>
          <style>{`@media (min-width: 1024px) { [data-panel] { border-left: 1px solid rgba(255,255,255,0.08); border-top: none; } }`}</style>

          {/* 頂列：標題 + 視圖切換 */}
          <div className="flex items-center justify-between px-4 py-2.5 shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <span className="text-xs font-semibold" style={{ color: "rgba(255,255,255,0.4)" }}>
              {drillDown
                ? `${drillDown.name} 成分股（${drillDown.stocks?.length ?? 0}）`
                : viewMode === "concepts" ? `概念股（${allConcepts.length}）` : "排行榜"
              }
            </span>
            {!drillDown && (
              <div className="flex rounded-lg overflow-hidden text-xs" style={{ border: "1px solid rgba(255,255,255,0.12)" }}>
                <button onClick={() => setViewMode("concepts")}
                  className="px-3 py-1.5 transition"
                  style={{ background: viewMode === "concepts" ? "rgba(255,255,255,0.12)" : "transparent", color: viewMode === "concepts" ? "white" : "rgba(255,255,255,0.5)" }}>
                  概念股
                </button>
                <button onClick={() => setViewMode("rankings")}
                  className="px-3 py-1.5 transition"
                  style={{ background: viewMode === "rankings" ? "rgba(255,255,255,0.12)" : "transparent", color: viewMode === "rankings" ? "white" : "rgba(255,255,255,0.5)" }}>
                  排行榜
                </button>
              </div>
            )}
          </div>

          {/* 列表本體（可捲動） */}
          <div className="flex-1 overflow-y-auto" style={{ maxHeight: 460 }}>
            {drillDown ? (
              /* 成分股列表 */
              (drillDown.stocks ?? []).map(s => {
                const q = quadrant(s), color = Q_META[q].color;
                return (
                  <div key={s.code}
                    className="flex items-center gap-2 px-4 py-2.5 cursor-default transition"
                    style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", background: hovered?.name === s.name ? "rgba(255,255,255,0.05)" : "transparent" }}
                    onMouseEnter={() => setHovered(s)} onMouseLeave={() => setHovered(null)}>
                    <span className="font-mono text-[10px] shrink-0 w-10" style={{ color: "rgba(255,255,255,0.3)" }}>{s.code}</span>
                    <span className="flex-1 text-sm font-medium truncate" style={{ color: hovered?.name === s.name ? "white" : "rgba(255,255,255,0.8)" }}>{s.name}</span>
                    <span className={`text-xs tabular-nums font-medium shrink-0 ${s.y >= 0 ? "text-emerald-400" : "text-orange-400"}`}>{s.y >= 0 ? "+" : ""}{s.y}</span>
                    <span className="text-xs font-semibold shrink-0" style={{ color }}>{Q_META[q].label}</span>
                  </div>
                );
              })
            ) : viewMode === "concepts" ? (
              /* 概念股列表 */
              (allConcepts as Bubble[])
                .filter(b => !sq || b.name.toLowerCase().includes(sq))
                .slice().sort((a, z) => z.size - a.size)
                .map(b => {
                  const q = quadrant(b), color = Q_META[q].color, canDrill = (b.stocks?.length ?? 0) > 0;
                  return (
                    <div key={b.name}
                      className={`flex items-center gap-2 px-4 py-2.5 transition ${canDrill ? "cursor-pointer" : ""}`}
                      style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", background: hovered?.name === b.name ? "rgba(255,255,255,0.05)" : "transparent" }}
                      onMouseEnter={() => setHovered(b)} onMouseLeave={() => setHovered(null)}
                      onClick={() => canDrill && handleBubbleClick(b)}>
                      <span className="flex-1 text-sm font-medium truncate" style={{ color: hovered?.name === b.name ? "white" : "rgba(255,255,255,0.8)" }}>
                        {b.name}{canDrill && <span className="ml-1 text-[10px]" style={{ color: "rgba(255,255,255,0.25)" }}>↗</span>}
                      </span>
                      <span className="text-xs tabular-nums shrink-0" style={{ color: "rgba(255,255,255,0.3)" }}>{b.rt_amt}</span>
                      <span className={`text-xs tabular-nums font-medium shrink-0 ${b.y >= 0 ? "text-emerald-400" : "text-orange-400"}`}>{b.y >= 0 ? "+" : ""}{b.y}</span>
                      <span className="text-xs font-semibold shrink-0" style={{ color }}>{Q_META[q].label}</span>
                    </div>
                  );
                })
            ) : (
              /* 排行榜：CP值排行 + 抄底偵測 */
              <>
                {/* CP 值排行 */}
                <div className="px-4 pt-3 pb-2">
                  <div className="flex items-center gap-2 mb-2">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="#fde047"><path d="M12 2l2 6h6l-5 4 2 7-7-4-7 4 2-7-5-4h6z"/></svg>
                    <span className="text-xs font-semibold" style={{ color: "rgba(255,255,255,0.9)" }}>CP 值排行</span>
                    <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.3)" }}>· 補漲機會</span>
                  </div>
                  {cpRanking.map(({ b }, i) => {
                    const q = quadrant(b), color = Q_META[q].color;
                    return (
                      <div key={b.name}
                        className="flex items-center gap-2 py-2 cursor-pointer rounded px-1 -mx-1 transition"
                        style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", background: hovered?.name === b.name ? "rgba(255,255,255,0.05)" : "transparent" }}
                        onMouseEnter={() => setHovered(b)} onMouseLeave={() => setHovered(null)}
                        onClick={() => { if (b.stocks?.length) handleBubbleClick(b); }}>
                        <span className="text-xs tabular-nums w-4 shrink-0" style={{ color: "rgba(255,255,255,0.3)" }}>{i + 1}</span>
                        <span className="flex-1 text-sm font-medium truncate" style={{ color: hovered?.name === b.name ? "white" : "rgba(255,255,255,0.8)" }}>{b.name}</span>
                        <span className="text-xs tabular-nums shrink-0" style={{ color: "rgba(255,255,255,0.35)" }}>{(b.amt_20d * 10).toFixed(0)}億</span>
                        <span className="text-xs font-semibold shrink-0" style={{ color }}>{Q_META[q].label}</span>
                      </div>
                    );
                  })}
                  {cpRanking.length === 0 && <div className="text-xs py-2" style={{ color: "rgba(255,255,255,0.3)" }}>暫無資料</div>}
                </div>

                {/* 抄底偵測 */}
                <div className="px-4 pt-3 pb-2" style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="flex items-center gap-2 mb-2">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.5"><path d="M12 22V8M5 12l7-7 7 7"/></svg>
                    <span className="text-xs font-semibold" style={{ color: "rgba(255,255,255,0.9)" }}>抄底偵測</span>
                    <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.3)" }}>· 動能回升</span>
                  </div>
                  {dipRanking.map(b => (
                    <div key={b.name}
                      className="flex items-center gap-2 py-2 cursor-pointer rounded px-1 -mx-1 transition"
                      style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", background: hovered?.name === b.name ? "rgba(255,255,255,0.05)" : "transparent" }}
                      onMouseEnter={() => setHovered(b)} onMouseLeave={() => setHovered(null)}
                      onClick={() => { if (b.stocks?.length) handleBubbleClick(b); }}>
                      <span className="flex-1 text-sm font-medium truncate" style={{ color: hovered?.name === b.name ? "white" : "rgba(255,255,255,0.8)" }}>{b.name}</span>
                      <span className="text-xs font-semibold tabular-nums" style={{ color: "#34d399" }}>逆勢買 +{b.y}</span>
                    </div>
                  ))}
                  {dipRanking.length === 0 && <div className="text-xs py-2" style={{ color: "rgba(255,255,255,0.3)" }}>目前無觀望象限資料</div>}
                </div>
              </>
            )}
          </div>
        </div>

        </div>{/* /flex row */}
      </div>{/* /主深色卡 */}


    </div>
  );
}

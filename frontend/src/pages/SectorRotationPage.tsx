import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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
const CHART_BG = "#F1F5F9";

const Q_META = [
  { label: "主力", desc: "錢正大力進場",   plain: "資金加速流入，最強勢", color: "#059669" },
  { label: "輪動", desc: "熱度開始轉移",   plain: "資金持續流入但放緩",   color: "#D97706" },
  { label: "觀望", desc: "資金來但沒人接", plain: "動能回升，留意轉強",   color: "#6366F1" },
  { label: "退潮", desc: "資金流出，別追", plain: "資金持續流出，避開",   color: "#EA580C" },
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
  const [viewType, setViewType] = useState<"bubble" | "heatmap" | "bars" | "matrix">("bubble");
  const [matrixSort, setMatrixSort] = useState<{ col: "x" | "y" | "rt_amt" | "size"; dir: 1 | -1 }>({ col: "x", dir: -1 });
  const navigate = useNavigate();
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.innerWidth < 640);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  // QA
  const [qaOpen, setQaOpen] = useState(false);
  const [qaMessages, setQaMessages] = useState<{ role: "user" | "ai"; text: string }[]>([]);
  const [qaInput, setQaInput] = useState("");
  const [qaLoading, setQaLoading] = useState(false);
  const qaBodyRef = useRef<HTMLDivElement>(null);


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

  useEffect(() => {
    if (qaBodyRef.current) qaBodyRef.current.scrollTop = qaBodyRef.current.scrollHeight;
  }, [qaMessages]);

  // 碰撞分離：必須在 early return 之前（Rules of Hooks）

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
  // 除以 √zoom：放大時泡泡等比成長（視覺 = base×√zoom），但增速慢於間距，不重疊
  const r = (b: Bubble | StockBubble) => (8 + (b.size / maxSize) * 38) / Math.sqrt(zoom.scale);

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

  const sendQA = async (question?: string) => {
    const q = (question ?? qaInput).trim();
    if (!q || qaLoading) return;
    setQaInput("");
    setQaLoading(true);
    setQaMessages(prev => [...prev, { role: "user", text: q }]);
    setQaMessages(prev => [...prev, { role: "ai", text: "" }]);
    try {
      const token = localStorage.getItem("auth_token");
      const resp = await fetch("/api/stocks/sector-rotation/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ question: q }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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
          if (payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload);
            if (obj.text) {
              setQaMessages(prev => {
                const msgs = [...prev];
                msgs[msgs.length - 1] = { role: "ai", text: msgs[msgs.length - 1].text + obj.text };
                return msgs;
              });
            }
            if (obj.error) {
              setQaMessages(prev => {
                const msgs = [...prev];
                msgs[msgs.length - 1] = { role: "ai", text: `錯誤：${obj.error}` };
                return msgs;
              });
            }
          } catch {}
        }
      }
    } catch (e: any) {
      setQaMessages(prev => {
        const msgs = [...prev];
        msgs[msgs.length - 1] = { role: "ai", text: `錯誤：${e.message}` };
        return msgs;
      });
    } finally {
      setQaLoading(false);
    }
  };

  const handleBubbleClick = (b: Bubble | StockBubble) => {
    if (dragging) return;
    if (!drillDown && "stocks" in b && b.stocks?.length) {
      setDrillDown(b as Bubble); resetZoom(); setFilter(null); setHovered(null); setSearch("");
    }
  };
  const handleBackToConcepts = () => { setDrillDown(null); resetZoom(); setHovered(null); };

  const gridColor = "rgba(0,0,0,0.11)", axisColor = "rgba(0,0,0,0.35)", tickColor = "rgba(0,0,0,0.6)";

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
        <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", color: "rgba(15,23,42,0.75)" }}>
          <div className="font-semibold mb-1.5" style={{ color: "#1D4ED8" }}>怎麼看這張圖</div>
          <div className="grid gap-1.5 text-xs" style={{ color: "rgba(15,23,42,0.6)" }}>
            <div><span style={{ color: "#1D4ED8" }}>橫軸（左右）</span>＝資金流入／流出，越右代表錢越多</div>
            <div><span style={{ color: "#1D4ED8" }}>縱軸（上下）</span>＝加速度（近5日均 − 近20日均），越上代表資金在加速流入</div>
            <div><span style={{ color: "#1D4ED8" }}>泡泡大小</span>＝成交規模，單位統一為「億元」</div>
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

      {/* ── 視圖切換 ── */}
      {!drillDown && (
        <div className="flex items-center gap-1">
          {(["bubble", "heatmap", "bars", "matrix"] as const).map(v => {
            const LABELS = { bubble: "泡泡圖", heatmap: "方格熱圖", bars: "排行長條", matrix: "指標矩陣" };
            return (
              <button key={v} onClick={() => setViewType(v)}
                className="px-3 py-1.5 rounded-lg text-sm transition"
                style={{ background: viewType === v ? "white" : "transparent", border: `1.5px solid ${viewType === v ? "#64748B" : "transparent"}`, color: viewType === v ? "#0F172A" : "rgba(15,23,42,0.52)", fontWeight: viewType === v ? 600 : 400, boxShadow: viewType === v ? "0 2px 6px rgba(0,0,0,0.12)" : "none" }}>
                {LABELS[v]}
              </button>
            );
          })}
        </div>
      )}

      {/* ── 主卡 ── */}
      <div className="rounded-2xl overflow-hidden" style={{ background: CHART_BG, border: "1.5px solid #94A3B8", boxShadow: "0 2px 12px rgba(0,0,0,0.08)" }}>
        <div className="flex flex-col lg:flex-row" style={{ display: viewType === "bubble" ? "" : "none" }}>

        {/* 左側：象限 sidebar + 圖表/榜單 */}
        <div className="flex flex-1 min-w-0">
      {true && (
        <div className="flex flex-1 min-w-0">

          {/* 左側象限統計（桌機顯示，手機隱藏）*/}
          <div className="hidden lg:flex w-[110px] shrink-0 flex-col" style={{ borderRight: "1px solid #CBD5E1" }}>
            {drillDown ? (
              /* 下鑽模式：顯示概念股名稱 + 返回按鈕 */
              <div className="flex flex-col items-center justify-center flex-1 gap-3 px-2 text-center">
                <div className="text-[10px] font-semibold leading-tight" style={{ color: "rgba(15,23,42,0.45)" }}>{drillDown.name}</div>
                <div className="text-2xl font-black leading-none" style={{ color: "rgba(15,23,42,0.85)" }}>{drillDown.stocks?.length ?? 0}</div>
                <div className="text-[10px]" style={{ color: "rgba(15,23,42,0.3)" }}>支成分股</div>
                <button onClick={handleBackToConcepts}
                  className="mt-2 text-[10px] px-2 py-1 rounded transition hover:text-blue-700"
                  style={{ color: "#3B82F6", border: "1px solid #BFDBFE" }}>
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
                    <div className="text-xs font-semibold mt-1" style={{ color: "rgba(15,23,42,0.75)" }}>{q.label}</div>
                    <div className="text-[10px] leading-tight mt-0.5" style={{ color: "rgba(15,23,42,0.35)" }}>{q.desc}</div>
                  </button>
                ))}
                {filter !== null && (
                  <button onClick={() => setFilter(null)} className="py-2 text-[10px] text-center hover:text-gray-700" style={{ color: "rgba(15,23,42,0.35)", borderTop: "1px solid #E2E8F0" }}>
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
            <div className="flex lg:hidden shrink-0" style={{ borderBottom: "1px solid #E2E8F0" }}>
              {Q_META.map((q, i) => (
                <button key={q.label} onClick={() => setFilter(filter === i ? null : i)}
                  className="flex-1 flex flex-col items-center py-2.5 transition"
                  style={{ borderBottom: `2px solid ${filter === i ? q.color : "transparent"}`, background: filter === i ? `${q.color}12` : "transparent" }}>
                  <span className="text-lg font-black leading-none" style={{ color: q.color }}>{counts[i]}</span>
                  <span className="text-[10px] mt-0.5 font-medium" style={{ color: "rgba(15,23,42,0.55)" }}>{q.label}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex-1 relative min-w-0">
            {/* 縮放按鈕：圖表右上角 */}
            <div className="absolute top-2.5 right-2.5 z-10 flex items-center gap-1">
              {/* 縮放 */}
              <button onClick={() => setZoom(prev => { const cx = W/2, cy = H/2, ns = Math.min(12, prev.scale*1.4); return { scale: ns, ...clampPan(cx-(cx-prev.tx)*(ns/prev.scale), cy-(cy-prev.ty)*(ns/prev.scale), ns) }; })}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-base font-bold" style={{ background: "rgba(0,0,0,0.05)", border: "1px solid #CBD5E1", color: "rgba(0,0,0,0.6)" }}>+</button>
              <button onClick={() => setZoom(prev => { const cx = W/2, cy = H/2, ns = Math.max(0.4, prev.scale/1.4); return { scale: ns, ...clampPan(cx-(cx-prev.tx)*(ns/prev.scale), cy-(cy-prev.ty)*(ns/prev.scale), ns) }; })}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-base font-bold" style={{ background: "rgba(0,0,0,0.05)", border: "1px solid #CBD5E1", color: "rgba(0,0,0,0.6)" }}>−</button>
              <button onClick={resetZoom} className="px-2.5 h-7 text-xs font-medium rounded-lg" style={{ background: "rgba(0,0,0,0.05)", border: "1px solid #CBD5E1", color: "rgba(0,0,0,0.6)", visibility: isZoomed ? "visible" : "hidden" }}>重設</button>
            </div>

            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 300, cursor: dragging ? "grabbing" : "grab", display: "block", touchAction: "none" }}
              onMouseDown={onSvgMouseDown} onMouseMove={onSvgMouseMove} onMouseLeave={() => { setDragging(false); setHovered(null); }}>
              <defs><clipPath id="chart-clip"><rect x={PAD.left} y={PAD.top} width={CW} height={CH} /></clipPath></defs>
              <rect width={W} height={H} fill={CHART_BG} />

              {/* 固定象限標籤 + 白話說明 */}
              <text x={PAD.left + 6} y={PAD.top + 15} fontSize={11} fill={Q_META[2].color} fontWeight={800}>觀望</text>
              <text x={PAD.left + 6} y={PAD.top + 28} fontSize={9} fill={Q_META[2].color} fillOpacity={0.75}>{Q_META[2].desc}</text>
              <text x={W - PAD.right - 6} y={PAD.top + 15} fontSize={11} fill={Q_META[0].color} fontWeight={800} textAnchor="end">主力加速流入 ★</text>
              <text x={W - PAD.right - 6} y={PAD.top + 28} fontSize={9} fill={Q_META[0].color} fillOpacity={0.75} textAnchor="end">{Q_META[0].desc}</text>
              <text x={PAD.left + 6} y={H - PAD.bottom - 14} fontSize={11} fill={Q_META[3].color} fontWeight={800}>退潮</text>
              <text x={PAD.left + 6} y={H - PAD.bottom - 2} fontSize={9} fill={Q_META[3].color} fillOpacity={0.75}>{Q_META[3].desc}</text>
              <text x={W - PAD.right - 6} y={H - PAD.bottom - 14} fontSize={11} fill={Q_META[1].color} fontWeight={800} textAnchor="end">輪動</text>
              <text x={W - PAD.right - 6} y={H - PAD.bottom - 2} fontSize={9} fill={Q_META[1].color} fillOpacity={0.75} textAnchor="end">{Q_META[1].desc}</text>

              {/* 軸方向 */}
              <text x={W - PAD.right} y={H - PAD.bottom + 38} fontSize={8.5} fill={tickColor} textAnchor="end">資金流入（億）→</text>
              <text x={PAD.left} y={H - PAD.bottom + 38} fontSize={8.5} fill={tickColor}>← 資金流出（億）</text>

              <g clipPath="url(#chart-clip)">
                {/* 象限底色（固定不跟 zoom 走）*/}
                <rect x={ox} y={PAD.top} width={W - PAD.right - ox} height={oy - PAD.top} fill={Q_META[0].color} fillOpacity={0.06} />
                <rect x={ox} y={oy} width={W - PAD.right - ox} height={H - PAD.bottom - oy} fill={Q_META[1].color} fillOpacity={0.06} />
                <rect x={PAD.left} y={PAD.top} width={ox - PAD.left} height={oy - PAD.top} fill={Q_META[2].color} fillOpacity={0.06} />
                <rect x={PAD.left} y={oy} width={ox - PAD.left} height={H - PAD.bottom - oy} fill={Q_META[3].color} fillOpacity={0.06} />
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
                  {activeBubbles.map((b) => {
                    const q = quadrant(b), color = Q_META[q].color;
                    const bx = toSvgX(b.x);
                    const by = toSvgY(b.y);
                    const rad = r(b);
                    const visualR = rad * zoom.scale;
                    const isHov = hovered?.name === b.name;
                    const canDrill = !drillDown && "stocks" in b && (b.stocks?.length ?? 0) > 0;
                    const isMatch = !sq || b.name.toLowerCase().includes(sq);
                    const displayName = b.name.length > 6 ? b.name.slice(0, 5) + "…" : b.name;
                    const amtStr = fmtAmt(b.x);
                    // 依泡泡直徑自動適配：中文字約 1.05em，數字/ASCII 約 0.62em
                    const maxW = rad * 1.76; // 88% of diameter
                    const fs1 = Math.min(maxW / (displayName.length * 1.05), rad * 0.52);
                    const fs2 = Math.min(maxW / (amtStr.length * 0.62), fs1 * 0.82);
                    return (
                      <g key={b.name} onMouseEnter={() => !dragging && setHovered(b)} onMouseLeave={() => setHovered(null)}
                        onClick={() => handleBubbleClick(b)} style={{ cursor: dragging ? "grabbing" : canDrill ? "zoom-in" : "default" }}>
                        <circle cx={bx} cy={by} r={rad * 1.22} fill={color} fillOpacity={(isHov ? 0.25 : 0.14) * (isMatch ? 1 : 0.25)} />
                        <circle cx={bx} cy={by} r={rad} fill={color} fillOpacity={(isHov ? 0.97 : 0.90) * (isMatch ? 1 : 0.12)}
                          stroke={color} strokeWidth={(isHov ? 2.5 : 1.5)/zoom.scale} strokeOpacity={isMatch ? 1 : 0.15} />
                        {visualR > 11 && isMatch && (
                          <text x={bx} y={by + (visualR > 20 ? -fs1 * 0.6 : fs1 * 0.35)} fontSize={fs1} fill="white"
                            stroke="rgba(0,0,0,0.7)" strokeWidth={2 / zoom.scale} paintOrder="stroke"
                            textAnchor="middle" fontWeight={700} pointerEvents="none">
                            {displayName}
                          </text>
                        )}
                        {visualR > 20 && isMatch && (
                          <text x={bx} y={by + fs1 * 0.85} fontSize={fs2} fill="white"
                            stroke="rgba(0,0,0,0.6)" strokeWidth={1.5 / zoom.scale} paintOrder="stroke"
                            textAnchor="middle" fontWeight={600} pointerEvents="none">
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
            <div className="flex items-center gap-3 px-4 py-2 text-xs flex-wrap" style={{ borderTop: "1px solid #CBD5E1", color: "rgba(15,23,42,0.6)" }}>
              <span>圖例：</span>
              {Q_META.map(q => (
                <span key={q.label} className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: q.color }} />
                  <span style={{ color: "rgba(15,23,42,0.55)" }}>{q.label}</span>
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
                      className="w-7 h-7 flex items-center justify-center rounded-lg text-sm" style={{background:"rgba(0,0,0,0.05)",border:"1px solid #CBD5E1",color:"rgba(0,0,0,0.65)"}}>
                      {arrow}
                    </button>
                  );
                })}
                <button onClick={resetZoom} className="px-2 h-7 text-xs font-medium rounded-lg ml-1" style={{background:"rgba(0,0,0,0.05)",border:"1px solid #CBD5E1",color:"rgba(0,0,0,0.65)", visibility: isZoomed ? "visible" : "hidden"}}>重設</button>
              </div>
            </div>

            {/* Tooltip */}
            {hovered && !dragging && (() => {
              const cw = svgRef.current?.getBoundingClientRect().width ?? 400;
              const tipLeft = mousePos.x + 14 + 210 > cw ? Math.max(4, mousePos.x - 224) : mousePos.x + 14;
              return (
              <div className="absolute pointer-events-none z-10 rounded-xl px-3 py-2.5 text-xs"
                style={{ left: tipLeft, top: Math.max(4, mousePos.y - 10), maxWidth: 210, background: "rgba(255,255,255,0.98)", border: "1px solid #94A3B8", color: "#0F172A", backdropFilter: "blur(8px)", boxShadow: "0 6px 20px rgba(0,0,0,0.14)" }}>
                <div className="font-bold text-sm mb-1.5">
                  {"code" in hovered ? <><span className="font-mono text-gray-400 text-xs">{(hovered as StockBubble).code} </span>{hovered.name}</> : hovered.name}
                </div>
                <div className="flex flex-col gap-1" style={{ color: "rgba(15,23,42,0.55)" }}>
                  <div className="flex justify-between gap-3"><span>狀態</span><span style={{ color: Q_META[quadrant(hovered)].color }} className="font-semibold">{Q_META[quadrant(hovered)].label} · {Q_META[quadrant(hovered)].desc}</span></div>
                  <div className="flex justify-between gap-3"><span>今日成交</span><span className="font-medium text-gray-900">{hovered.rt_amt} 億</span></div>
                  <div className="flex justify-between gap-3"><span>20日累積</span><span className="font-medium text-gray-900">{"code" in hovered ? `${hovered.amt_20d} 億` : `${hovered.amt_20d} 十億`}</span></div>
                  <div className="flex justify-between gap-3"><span>加速度</span><span style={{ color: hovered.y >= 0 ? "#10B981" : "#FB923C" }} className="font-semibold">{hovered.y >= 0 ? "+" : ""}{hovered.y}</span></div>
                  {!drillDown && "stocks" in hovered && (hovered.stocks?.length ?? 0) > 0 && <div className="pt-1 text-blue-400 text-[10px]">🔍 點擊查看 {(hovered as Bubble).stocks!.length} 支成分股</div>}
                </div>
              </div>
              );
            })()}
          </div>
          </div>{/* /圖表區 flex-col wrapper */}
        </div>
      )}
        </div>{/* /左側 flex */}

        {/* 右側：概念股列表面板 */}
        <div className="lg:w-[300px] shrink-0 flex flex-col" style={{ borderTop: "1px solid #CBD5E1", borderLeft: "none" }}
          // eslint-disable-next-line react/no-unknown-property
          {...({ "data-panel": true } as object)}>
          <style>{`@media (min-width: 1024px) { [data-panel] { border-left: 1.5px solid #94A3B8; border-top: none; } }`}</style>

          {/* 頂列：標題 + 視圖切換 */}
          <div className="flex items-center justify-between px-4 py-2.5 shrink-0" style={{ borderBottom: "1px solid #CBD5E1" }}>
            <span className="text-xs font-semibold" style={{ color: "rgba(15,23,42,0.6)" }}>
              {drillDown
                ? `${drillDown.name} 成分股（${drillDown.stocks?.length ?? 0}）`
                : viewMode === "concepts" ? `概念股（${allConcepts.length}）` : "排行榜"
              }
            </span>
            {!drillDown && (
              <div className="flex rounded-lg overflow-hidden text-xs" style={{ border: "1px solid #CBD5E1" }}>
                <button onClick={() => setViewMode("concepts")}
                  className="px-3 py-1.5 transition"
                  style={{ background: viewMode === "concepts" ? "rgba(0,0,0,0.07)" : "transparent", color: viewMode === "concepts" ? "#0F172A" : "rgba(15,23,42,0.4)" }}>
                  概念股
                </button>
                <button onClick={() => setViewMode("rankings")}
                  className="px-3 py-1.5 transition"
                  style={{ background: viewMode === "rankings" ? "rgba(0,0,0,0.07)" : "transparent", color: viewMode === "rankings" ? "#0F172A" : "rgba(15,23,42,0.4)" }}>
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
                  <Link key={s.code} to={`/stocks/${s.code}`}
                    className="flex items-center gap-2 px-4 py-2.5 transition hover:bg-black/[0.04]"
                    style={{ borderBottom: "1px solid #F1F4F9" }}
                    onMouseEnter={() => setHovered(s)} onMouseLeave={() => setHovered(null)}>
                    <span className="font-mono text-[10px] shrink-0 w-10" style={{ color: "rgba(15,23,42,0.3)" }}>{s.code}</span>
                    <span className="flex-1 text-sm font-medium truncate" style={{ color: "rgba(15,23,42,0.75)" }}>{s.name}</span>
                    <span className={`text-xs tabular-nums font-medium shrink-0 ${s.y >= 0 ? "text-emerald-400" : "text-orange-400"}`}>{s.y >= 0 ? "+" : ""}{s.y}</span>
                    <span className="text-xs font-semibold shrink-0" style={{ color }}>{Q_META[q].label}</span>
                  </Link>
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
                      style={{ borderBottom: "1px solid #E2E8F0", background: hovered?.name === b.name ? "rgba(0,0,0,0.055)" : "transparent" }}
                      onMouseEnter={() => setHovered(b)} onMouseLeave={() => setHovered(null)}
                      onClick={() => canDrill && handleBubbleClick(b)}>
                      <span className="flex-1 text-sm font-medium truncate" style={{ color: hovered?.name === b.name ? "#0F172A" : "rgba(15,23,42,0.75)" }}>
                        {b.name}{canDrill && <span className="ml-1 text-[10px]" style={{ color: "rgba(15,23,42,0.25)" }}>↗</span>}
                      </span>
                      <span className="text-xs tabular-nums shrink-0" style={{ color: "rgba(15,23,42,0.3)" }}>{b.rt_amt}</span>
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
                    <span className="text-xs font-semibold" style={{ color: "rgba(15,23,42,0.85)" }}>CP 值排行</span>
                    <span className="text-[10px]" style={{ color: "rgba(15,23,42,0.3)" }}>· 補漲機會</span>
                  </div>
                  {cpRanking.map(({ b }, i) => {
                    const q = quadrant(b), color = Q_META[q].color;
                    return (
                      <div key={b.name}
                        className="flex items-center gap-2 py-2 cursor-pointer rounded px-1 -mx-1 transition"
                        style={{ borderBottom: "1px solid #E2E8F0", background: hovered?.name === b.name ? "rgba(0,0,0,0.055)" : "transparent" }}
                        onMouseEnter={() => setHovered(b)} onMouseLeave={() => setHovered(null)}
                        onClick={() => { if (b.stocks?.length) handleBubbleClick(b); }}>
                        <span className="text-xs tabular-nums w-4 shrink-0" style={{ color: "rgba(15,23,42,0.3)" }}>{i + 1}</span>
                        <span className="flex-1 text-sm font-medium truncate" style={{ color: hovered?.name === b.name ? "#0F172A" : "rgba(15,23,42,0.75)" }}>{b.name}</span>
                        <span className="text-xs tabular-nums shrink-0" style={{ color: "rgba(15,23,42,0.35)" }}>{(b.amt_20d * 10).toFixed(0)}億</span>
                        <span className="text-xs font-semibold shrink-0" style={{ color }}>{Q_META[q].label}</span>
                      </div>
                    );
                  })}
                  {cpRanking.length === 0 && <div className="text-xs py-2" style={{ color: "rgba(15,23,42,0.3)" }}>暫無資料</div>}
                </div>

                {/* 抄底偵測 */}
                <div className="px-4 pt-3 pb-2" style={{ borderTop: "1px solid #E2E8F0" }}>
                  <div className="flex items-center gap-2 mb-2">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.5"><path d="M12 22V8M5 12l7-7 7 7"/></svg>
                    <span className="text-xs font-semibold" style={{ color: "rgba(15,23,42,0.85)" }}>抄底偵測</span>
                    <span className="text-[10px]" style={{ color: "rgba(15,23,42,0.3)" }}>· 動能回升</span>
                  </div>
                  {dipRanking.map(b => (
                    <div key={b.name}
                      className="flex items-center gap-2 py-2 cursor-pointer rounded px-1 -mx-1 transition"
                      style={{ borderBottom: "1px solid #E2E8F0", background: hovered?.name === b.name ? "rgba(0,0,0,0.055)" : "transparent" }}
                      onMouseEnter={() => setHovered(b)} onMouseLeave={() => setHovered(null)}
                      onClick={() => { if (b.stocks?.length) handleBubbleClick(b); }}>
                      <span className="flex-1 text-sm font-medium truncate" style={{ color: hovered?.name === b.name ? "#0F172A" : "rgba(15,23,42,0.75)" }}>{b.name}</span>
                      <span className="text-xs font-semibold tabular-nums" style={{ color: "#34d399" }}>逆勢買 +{b.y}</span>
                    </div>
                  ))}
                  {dipRanking.length === 0 && <div className="text-xs py-2" style={{ color: "rgba(15,23,42,0.3)" }}>目前無觀望象限資料</div>}
                </div>
              </>
            )}
          </div>
        </div>

        </div>{/* /flex row */}

        {/* ── 方格熱圖 ── */}
        {viewType === "heatmap" && (() => {
          const isDD = drillDown !== null;
          const rawItems = isDD ? (drillDown.stocks ?? []) : data.bubbles;
          const items = rawItems.filter(b => !sq || b.name.toLowerCase().includes(sq));
          return (
            <div>
              {isDD && (
                <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: "1px solid #E2E8F0" }}>
                  <button onClick={handleBackToConcepts} className="text-sm text-blue-500 hover:underline">← 概念股</button>
                  <span style={{ color: "rgba(15,23,42,0.25)" }}>/</span>
                  <span className="text-sm font-semibold" style={{ color: "rgba(15,23,42,0.85)" }}>{drillDown.name}</span>
                  <span className="text-xs" style={{ color: "rgba(15,23,42,0.4)" }}>· {drillDown.stocks?.length ?? 0} 支成分股</span>
                </div>
              )}
              <div className="p-5">
                <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
                  {[0, 1, 2, 3].map(q => {
                    const qItems = items.filter(b => quadrant(b) === q).sort((a, z) => z.size - a.size);
                    return (
                      <div key={q}>
                        <div className="text-xs font-semibold px-2.5 py-1.5 rounded-lg mb-3 flex justify-between items-center"
                          style={{ background: `${Q_META[q].color}15`, color: Q_META[q].color }}>
                          <span>{Q_META[q].label}</span>
                          <span style={{ opacity: 0.6 }}>{qItems.length}</span>
                        </div>
                        {qItems.map(b => {
                          const code = "code" in b ? (b as StockBubble).code : null;
                          const hasChildren = !code && !!(b as Bubble).stocks?.length;
                          const tile = (
                            <div className="rounded-lg px-2 sm:px-3 py-1.5 sm:py-2 mb-1.5 transition"
                              style={{ background: hovered?.name === b.name ? `${Q_META[q].color}22` : `${Q_META[q].color}0e`, borderLeft: `2.5px solid ${Q_META[q].color}`, cursor: (code || hasChildren) ? "pointer" : "default" }}
                              onMouseEnter={() => setHovered(b)} onMouseLeave={() => setHovered(null)}
                              onClick={() => { if (!code && hasChildren) handleBubbleClick(b); }}>
                              <div className="text-xs sm:text-sm font-medium leading-snug line-clamp-2" style={{ color: "rgba(15,23,42,0.85)" }}>
                                {code && <span className="font-mono text-[9px] mr-0.5" style={{ color: "rgba(15,23,42,0.35)" }}>{code}</span>}
                                {b.name}
                                {hasChildren && <span className="ml-0.5 text-[9px]" style={{ color: "rgba(15,23,42,0.25)" }}>↗</span>}
                              </div>
                              <div className="text-[10px] sm:text-xs mt-0.5 flex gap-1" style={{ color: Q_META[q].color, opacity: 0.9 }}>
                                <span className="truncate">{fmtAmt(b.x)}</span>
                                <span className="ml-auto flex-shrink-0">{b.y >= 0 ? "▲" : "▼"}{Math.abs(b.y)}</span>
                              </div>
                            </div>
                          );
                          return code ? (
                            <Link key={b.name} to={`/stocks/${code}`} style={{ textDecoration: "none", display: "block" }}>{tile}</Link>
                          ) : (
                            <div key={b.name}>{tile}</div>
                          );
                        })}
                        {qItems.length === 0 && (
                          <div className="text-xs text-center py-6" style={{ color: "rgba(15,23,42,0.2)" }}>目前無資料</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── 排行長條 ── */}
        {viewType === "bars" && (() => {
          const isDD = drillDown !== null;
          const rawItems = isDD ? (drillDown.stocks ?? []) : data.bubbles;
          const items = rawItems.filter(b => !sq || b.name.toLowerCase().includes(sq));
          const sorted = [...items].sort((a, z) => z.x - a.x);
          const maxAbs = Math.max(...rawItems.map(b => Math.abs(b.x)), 1);
          const rowH = isMobile ? 26 : 28, padT = 28, padB = 16;
          const nameW = isMobile ? (isDD ? 100 : 86) : (isDD ? 152 : 128);
          const barZone = isMobile ? 180 : 340, valW = isMobile ? 58 : 72;
          const totalW = nameW + barZone + valW;
          const totalH = sorted.length * rowH + padT + padB;
          const zeroX = nameW + barZone / 2;
          const scale = (barZone / 2) / maxAbs;
          return (
            <div>
              {isDD && (
                <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: "1px solid #E2E8F0" }}>
                  <button onClick={handleBackToConcepts} className="text-sm text-blue-500 hover:underline">← 概念股</button>
                  <span style={{ color: "rgba(15,23,42,0.25)" }}>/</span>
                  <span className="text-sm font-semibold" style={{ color: "rgba(15,23,42,0.85)" }}>{drillDown.name}</span>
                  <span className="text-xs" style={{ color: "rgba(15,23,42,0.4)" }}>· {drillDown.stocks?.length ?? 0} 支成分股</span>
                </div>
              )}
              <div style={{ overflowY: "auto", maxHeight: 520, padding: "16px 20px 20px" }}>
                <svg viewBox={`0 0 ${totalW} ${totalH}`} style={{ width: "100%", height: "auto", display: "block" }}>
                  <text x={zeroX + 4} y={16} fontSize={9} fill="rgba(0,0,0,0.3)">資金流入 →</text>
                  <text x={zeroX - 4} y={16} fontSize={9} fill="rgba(0,0,0,0.3)" textAnchor="end">← 資金流出</text>
                  <line x1={zeroX} y1={padT - 8} x2={zeroX} y2={totalH - padB} stroke="rgba(0,0,0,0.1)" strokeWidth="1"/>
                  {sorted.map((b, i) => {
                    const q = quadrant(b), color = Q_META[q].color;
                    const cy = padT + i * rowH + rowH / 2;
                    const len = Math.max(Math.abs(b.x) * scale, 1);
                    const bx = b.x >= 0 ? zeroX : zeroX - len;
                    const isHov = hovered?.name === b.name;
                    const code = "code" in b ? (b as StockBubble).code : null;
                    const hasChildren = !code && !!(b as Bubble).stocks?.length;
                    return (
                      <g key={b.name} style={{ cursor: (code || hasChildren) ? "pointer" : "default" }}
                        onMouseEnter={() => setHovered(b)} onMouseLeave={() => setHovered(null)}
                        onClick={() => {
                          if (code) navigate(`/stocks/${code}`);
                          else if (hasChildren) handleBubbleClick(b);
                        }}>
                        {isHov && <rect x={0} y={cy - rowH/2} width={totalW} height={rowH} fill="rgba(0,0,0,0.03)" rx="3"/>}
                        <text x={nameW - 6} y={cy + 4} fontSize={11} fill={isHov ? "rgba(15,23,42,0.9)" : "rgba(15,23,42,0.65)"} textAnchor="end">
                          {code ? `${code} ${b.name}` : b.name}
                        </text>
                        <rect x={bx} y={cy - 8} width={len} height={16} fill={color} fillOpacity={isHov ? 0.85 : 0.68} rx="2"/>
                        <text x={b.x >= 0 ? zeroX + len + 4 : zeroX - len - 4} y={cy + 4} fontSize={10}
                          fill={color} textAnchor={b.x >= 0 ? "start" : "end"} fontWeight={isHov ? "500" : "normal"}>
                          {fmtAmt(b.x)}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            </div>
          );
        })()}

        {/* ── 指標矩陣 ── */}
        {viewType === "matrix" && (() => {
          const isDD = drillDown !== null;
          const rawItems = isDD ? (drillDown.stocks ?? []) : data.bubbles;
          const getVal = (b: Bubble | StockBubble) => {
            switch (matrixSort.col) {
              case "x": return b.x;
              case "y": return b.y;
              case "rt_amt": return b.rt_amt;
              case "size": return b.size;
            }
          };
          const sortedM = [...rawItems]
            .filter(b => !sq || b.name.toLowerCase().includes(sq))
            .sort((a, z) => (getVal(z) - getVal(a)) * matrixSort.dir);
          const maxAbs = Math.max(...rawItems.map(b => Math.abs(b.x)), 1);
          const SortBtn = ({ col, label }: { col: typeof matrixSort.col; label: string }) => (
            <button onClick={() => setMatrixSort(prev => prev.col === col ? { col, dir: (prev.dir === 1 ? -1 : 1) as 1 | -1 } : { col, dir: -1 })}
              className="flex items-center gap-0.5 text-xs transition"
              style={{ color: matrixSort.col === col ? "rgba(15,23,42,0.75)" : "rgba(15,23,42,0.4)" }}>
              {label}{matrixSort.col === col ? (matrixSort.dir === -1 ? " ↓" : " ↑") : ""}
            </button>
          );
          return (
            <div>
              {isDD && (
                <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: "1px solid #E2E8F0" }}>
                  <button onClick={handleBackToConcepts} className="text-sm text-blue-500 hover:underline">← 概念股</button>
                  <span style={{ color: "rgba(15,23,42,0.25)" }}>/</span>
                  <span className="text-sm font-semibold" style={{ color: "rgba(15,23,42,0.85)" }}>{drillDown.name}</span>
                  <span className="text-xs" style={{ color: "rgba(15,23,42,0.4)" }}>· {drillDown.stocks?.length ?? 0} 支成分股</span>
                </div>
              )}
              <div className="flex items-center gap-2 px-4 py-2" style={{ borderBottom: "1px solid #E2E8F0", background: "rgba(0,0,0,0.015)" }}>
                <span className="flex-1 text-xs font-semibold" style={{ color: "rgba(15,23,42,0.4)" }}>{isDD ? "個股" : "族群"}</span>
                <span className="w-12 text-center text-xs font-semibold" style={{ color: "rgba(15,23,42,0.4)" }}>狀態</span>
                <span className="flex justify-end pr-1 sm:w-40 w-24"><SortBtn col="x" label="資金流" /></span>
                <span className="hidden sm:flex justify-end pr-2 w-20"><SortBtn col="y" label="加速度" /></span>
                <span className="hidden sm:flex justify-end w-24"><SortBtn col="rt_amt" label="今日成交" /></span>
              </div>
              <div style={{ maxHeight: 480, overflowY: "auto" }}>
                {sortedM.map((b, i) => {
                  const q = quadrant(b), color = Q_META[q].color;
                  const barW = Math.abs(b.x) / maxAbs * 48;
                  const isHov = hovered?.name === b.name;
                  const code = "code" in b ? (b as StockBubble).code : null;
                  const hasChildren = !code && !!(b as Bubble).stocks?.length;
                  const rowStyle: React.CSSProperties = { borderBottom: "1px solid #E2E8F0", background: isHov ? "rgba(0,0,0,0.05)" : i % 2 === 0 ? "rgba(0,0,0,0.02)" : "transparent" };
                  const rowContent = (
                    <>
                      <span className="flex-1 min-w-0 text-sm font-medium truncate" style={{ color: "rgba(15,23,42,0.8)" }}>
                        {code && <span className="font-mono text-[10px] mr-1" style={{ color: "rgba(15,23,42,0.35)" }}>{code}</span>}
                        {b.name}
                        {hasChildren && <span className="ml-1 text-[10px]" style={{ color: "rgba(15,23,42,0.25)" }}>↗</span>}
                      </span>
                      <span className="w-12 text-center text-xs font-semibold flex-shrink-0" style={{ color }}>{Q_META[q].label}</span>
                      {/* 桌機：mini bar + 數字 */}
                      <div className="hidden sm:flex w-40 items-center justify-end gap-2 pr-2 flex-shrink-0">
                        <div className="h-1.5 rounded-full flex-shrink-0" style={{ width: barW, background: b.x >= 0 ? Q_META[0].color : Q_META[3].color, minWidth: 2 }} />
                        <span className="text-xs tabular-nums font-medium flex-shrink-0" style={{ color: b.x >= 0 ? Q_META[0].color : Q_META[3].color, minWidth: 56, textAlign: "right" }}>
                          {fmtAmt(b.x)}
                        </span>
                      </div>
                      {/* 手機：只顯示數字 */}
                      <span className="sm:hidden w-24 text-right text-xs tabular-nums font-semibold flex-shrink-0" style={{ color: b.x >= 0 ? Q_META[0].color : Q_META[3].color }}>
                        {fmtAmt(b.x)}
                      </span>
                      <span className="hidden sm:block w-20 text-right pr-2 text-xs tabular-nums font-medium flex-shrink-0" style={{ color: b.y >= 0 ? Q_META[0].color : Q_META[3].color }}>
                        {b.y >= 0 ? "+" : ""}{b.y}
                      </span>
                      <span className="hidden sm:block w-24 text-right text-xs tabular-nums flex-shrink-0" style={{ color: "rgba(15,23,42,0.45)" }}>
                        {b.rt_amt}億
                      </span>
                    </>
                  );
                  return code ? (
                    <Link key={b.name} to={`/stocks/${code}`} style={{ textDecoration: "none", display: "block" }}
                      onMouseEnter={() => setHovered(b)} onMouseLeave={() => setHovered(null)}>
                      <div className="flex items-center gap-2 px-4 py-2.5" style={rowStyle}>{rowContent}</div>
                    </Link>
                  ) : (
                    <div key={b.name} className="flex items-center gap-2 px-4 py-2.5 transition"
                      style={{ ...rowStyle, cursor: hasChildren ? "pointer" : "default" }}
                      onMouseEnter={() => setHovered(b)} onMouseLeave={() => setHovered(null)}
                      onClick={() => hasChildren && handleBubbleClick(b)}>
                      {rowContent}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

      </div>{/* /主卡 */}

      {/* ── QA 問輪動圖 ── */}
      <div className="rounded-2xl overflow-hidden" style={{ background: CHART_BG, border: "1.5px solid #94A3B8", boxShadow: "0 2px 12px rgba(0,0,0,0.08)" }}>
        <button
          onClick={() => setQaOpen(v => !v)}
          className="w-full flex items-center justify-between px-5 py-3.5 text-left transition hover:bg-black/[0.03]"
          style={{ borderBottom: qaOpen ? "1px solid #E2E8F0" : "none" }}
        >
          <div className="flex items-center gap-2.5">
            <span style={{ fontSize: 16 }}>💬</span>
            <span className="text-sm font-semibold" style={{ color: "rgba(15,23,42,0.85)" }}>問輪動圖</span>
            <span className="text-xs" style={{ color: "rgba(15,23,42,0.3)" }}>· 用 AI 解讀今日籌碼</span>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(15,23,42,0.35)" strokeWidth="2"
            style={{ transform: qaOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }}>
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </button>

        {qaOpen && (
          <div>
            {/* 快速問題 chips */}
            {qaMessages.length === 0 && (
              <div className="flex flex-wrap gap-2 px-5 py-3" style={{ borderBottom: "1px solid #EEF0F4" }}>
                {["主力資金在哪？", "哪些概念退燒了？", "有沒有剛啟動的？", "今日成交最大的是？"].map(q => (
                  <button key={q} onClick={() => sendQA(q)}
                    className="text-xs px-3 py-1.5 rounded-full transition"
                    style={{ background: "#F1F5F9", border: "1px solid #CBD5E1", color: "rgba(15,23,42,0.6)" }}>
                    {q}
                  </button>
                ))}
              </div>
            )}

            {/* 訊息列表 */}
            {qaMessages.length > 0 && (
              <div ref={qaBodyRef} className="flex flex-col gap-3 px-5 py-4 overflow-y-auto" style={{ maxHeight: 300 }}>
                {qaMessages.map((m, i) => (
                  <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className="text-sm leading-relaxed" style={{
                      maxWidth: "85%",
                      background: m.role === "user" ? "#1b6fd8" : "#F1F5F9",
                      color: m.role === "user" ? "#fff" : "rgba(15,23,42,0.8)",
                      border: m.role === "ai" ? "1px solid #E2E8F0" : "none",
                      borderRadius: m.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                      padding: "9px 14px",
                    }}>
                      {m.role === "ai" && m.text === "" && qaLoading && i === qaMessages.length - 1
                        ? <span style={{ color: "rgba(15,23,42,0.3)" }}>思考中…</span>
                        : m.text}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 輸入列 */}
            <div className="flex gap-2 px-4 py-3" style={{ borderTop: "1px solid #EEF0F4" }}>
              <input
                value={qaInput}
                onChange={e => setQaInput(e.target.value)}
                onKeyDown={undefined}
                placeholder="輸入問題，例如：AI伺服器還有行情嗎？"
                disabled={qaLoading}
                className="flex-1 min-w-0 text-sm rounded-xl px-3 py-2 outline-none"
                style={{
                  background: "#F8FAFC",
                  border: "1px solid #CBD5E1",
                  color: "rgba(15,23,42,0.85)",
                  fontFamily: "var(--font-sans)",
                }}
              />
              <button
                onClick={() => sendQA()}
                disabled={qaLoading || !qaInput.trim()}
                className="shrink-0 text-sm font-medium rounded-xl px-4 py-2 transition"
                style={{ background: "#1b6fd8", color: "#fff", opacity: (qaLoading || !qaInput.trim()) ? 0.5 : 1 }}
              >
                送出
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

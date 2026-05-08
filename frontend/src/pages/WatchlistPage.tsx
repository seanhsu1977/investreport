import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import { watchlistApi, watchlistGroupsApi, stocksApi, fundamentalsApi, type WatchlistItem, type StockSignal, type StockPriceData, type MarketIndex, type TowerSignal, type FundamentalSummary } from "../api/client";
import RecommendationBadge from "../components/RecommendationBadge";
import StockSearch from "../components/StockSearch";
import { useAuth } from "../contexts/AuthContext";

type ViewMode = "list" | "card";

interface Tab {
  id: string;
  name: string;
}

function SkeletonRow() {
  return (
    <div className="grid grid-cols-12 gap-2 px-4 py-3 items-center animate-pulse">
      <div className="col-span-3 flex items-center gap-2">
        <div className="bg-gray-200 rounded h-4 w-10" />
        <div className="bg-gray-100 rounded h-3 w-14" />
      </div>
      <div className="col-span-1 flex justify-center"><div className="bg-gray-200 rounded h-5 w-6" /></div>
      <div className="col-span-2 flex justify-end"><div className="bg-gray-200 rounded h-4 w-12" /></div>
      <div className="col-span-3 flex justify-end"><div className="bg-gray-100 rounded h-3 w-28" /></div>
      <div className="col-span-2 flex justify-end"><div className="bg-gray-100 rounded h-3 w-8" /></div>
      <div className="col-span-1" />
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 animate-pulse">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <div className="bg-gray-200 rounded h-5 w-12" />
          <div className="bg-gray-100 rounded h-4 w-16" />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="bg-gray-200 rounded h-5 w-12" />
        <div className="bg-gray-100 rounded h-4 w-20" />
      </div>
      <div className="mt-2 space-y-1.5">
        <div className="bg-gray-100 rounded h-3 w-full" />
        <div className="bg-gray-100 rounded h-3 w-4/5" />
      </div>
    </div>
  );
}

function EmptyState({ tabName }: { tabName?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16">
      <div className="w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center">
        <svg className="w-7 h-7 text-blue-400" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
        </svg>
      </div>
      <p className="font-semibold text-gray-700">
        {tabName ? `「${tabName}」還沒有股票` : "還沒有自選股"}
      </p>
      <p className="text-sm text-gray-400 text-center">
        {tabName
          ? "在股票列上點「分組」標籤即可加入此頁籤"
          : "在上方搜尋股票代碼或名稱，\n點「+ 加入」即可追蹤最新報告。"}
      </p>
    </div>
  );
}

const SUGGESTION_STYLE_MAP: Record<string, string> = {
  "量增價漲，偏多":           "bg-red-50 text-red-600 border-red-200",
  "多頭趨勢，量縮整理":       "bg-orange-50 text-orange-500 border-orange-200",
  "短線過熱，注意回檔":       "bg-yellow-50 text-yellow-600 border-yellow-200",
  "短線超賣，留意反彈":       "bg-blue-50 text-blue-600 border-blue-200",
  "量增價跌，注意風險":       "bg-green-50 text-green-700 border-green-200",
  "弱勢整理，觀望為主":       "bg-gray-50 text-gray-500 border-gray-200",
  "盤整，等待方向":            "bg-gray-50 text-gray-400 border-gray-200",
  "突破布林上軌，短線過熱":   "bg-purple-50 text-purple-600 border-purple-200",
  "跌破布林下軌，留意反彈":   "bg-indigo-50 text-indigo-600 border-indigo-200",
};

// 頁籤顏色池
const TAB_COLORS = [
  { pill: "bg-blue-100 text-blue-700 border-blue-200",   dot: "bg-blue-500"   },
  { pill: "bg-green-100 text-green-700 border-green-200", dot: "bg-green-500"  },
  { pill: "bg-purple-100 text-purple-700 border-purple-200", dot: "bg-purple-500" },
  { pill: "bg-orange-100 text-orange-700 border-orange-200", dot: "bg-orange-400" },
  { pill: "bg-pink-100 text-pink-700 border-pink-200",    dot: "bg-pink-500"   },
  { pill: "bg-teal-100 text-teal-700 border-teal-200",    dot: "bg-teal-500"   },
  { pill: "bg-indigo-100 text-indigo-700 border-indigo-200", dot: "bg-indigo-500" },
  { pill: "bg-red-100 text-red-700 border-red-200",       dot: "bg-red-400"    },
];

function tabColor(idx: number) {
  return TAB_COLORS[idx % TAB_COLORS.length];
}

// ── 分組選單（小浮層）──────────────────────────────────
function AssignMenu({ code, tabs, currentTabId, onAssign, onClose, anchorRect }: {
  code: string;
  tabs: Tab[];
  currentTabId: string | undefined;
  onAssign: (code: string, tabId: string | null) => void;
  onClose: () => void;
  anchorRect: DOMRect;
}) {
  const top = anchorRect.bottom + 4;
  const left = anchorRect.left;

  return (
    <>
      {/* 透明遮罩：點選選單外部關閉 */}
      <div className="fixed inset-0" style={{ zIndex: 199 }} onClick={onClose} />
      <div
        style={{ position: "fixed", top, left, zIndex: 200 }}
        className="bg-white border border-gray-200 rounded-xl shadow-lg py-1 min-w-[140px]"
      >
        <button
          onClick={() => { onAssign(code, null); onClose(); }}
          className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-gray-50 ${!currentTabId ? "text-blue-600 font-semibold" : "text-gray-500"}`}
        >
          <span className="w-2 h-2 rounded-full bg-gray-300 inline-block shrink-0" />
          無分組
        </button>
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            onClick={() => { onAssign(code, tab.id); onClose(); }}
            className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-gray-50 ${currentTabId === tab.id ? "text-blue-600 font-semibold" : "text-gray-700"}`}
          >
            <span className={`w-2 h-2 rounded-full inline-block shrink-0 ${tabColor(i).dot}`} />
            {tab.name}
          </button>
        ))}
      </div>
    </>
  );
}

function fmtNum(v: number): string {
  if (Math.abs(v) < 10) return v.toFixed(2);
  if (Math.abs(v) < 1000) return v.toFixed(1);
  return v.toLocaleString("zh-TW", { maximumFractionDigits: 0 });
}

function MarketOverview({ data, expanded, onToggle }: { data: Record<string, MarketIndex> | null; expanded: boolean; onToggle: () => void }) {
  if (!data || Object.keys(data).length === 0) return null;
  const entries = Object.entries(data);
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition"
      >
        <div className="grid gap-x-4 gap-y-1.5 flex-1 min-w-0" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
          {entries.map(([key, idx]) => {
            const up = idx.change >= 0;
            const c = up ? "text-red-500" : "text-green-600";
            return (
              <span key={key} className="flex items-center gap-1.5 text-sm min-w-0">
                <span className="text-gray-500 text-xs shrink-0">{idx.name}</span>
                <span className={`font-semibold tabular-nums ${c} shrink-0`}>{fmtNum(idx.current)}</span>
                <span className={`text-xs ${c} shrink-0`}>{up ? "▲" : "▼"}{Math.abs(idx.change_pct).toFixed(2)}%</span>
              </span>
            );
          })}
        </div>
        <svg className={`w-4 h-4 text-gray-400 shrink-0 ml-2 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 p-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {entries.map(([key, idx]) => {
            const up = idx.change >= 0;
            const color = up ? "text-red-500" : "text-green-600";
            const bgColor = up ? "bg-red-50" : "bg-green-50";
            const suggCls = SUGGESTION_STYLE_MAP[idx.suggestion] ?? "bg-gray-50 text-gray-400 border-gray-200";
            return (
              <div key={key} className="space-y-1.5">
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0">
                    <p className="text-xs text-gray-400 mb-0.5 truncate">{idx.name}</p>
                    <p className={`text-lg font-bold tabular-nums leading-tight ${color}`}>{fmtNum(idx.current)}</p>
                  </div>
                  <div className={`text-right px-1.5 py-0.5 rounded-lg shrink-0 ${bgColor}`}>
                    <p className={`text-xs font-semibold tabular-nums ${color}`}>{up ? "▲" : "▼"}{fmtNum(Math.abs(idx.change))}</p>
                    <p className={`text-xs font-medium ${color}`}>{up ? "+" : ""}{idx.change_pct.toFixed(2)}%</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={`inline-flex items-center px-1 py-0.5 rounded text-xs border ${suggCls}`}>{idx.suggestion}</span>
                  <TowerTag tower={idx.tower} />
                  <BbTag signal={idx.bb_signal} pctB={idx.bb_pct_b} />
                </div>
                {idx.rsi !== null && (
                  <p className="text-xs text-gray-400">RSI <span className="text-gray-600 font-medium">{idx.rsi}</span></p>
                )}
                {(idx.resistance.length > 0 || idx.support.length > 0) && (
                  <div className="flex items-center gap-1.5 flex-wrap text-xs text-gray-400">
                    {idx.resistance.length > 0 && (
                      <span className="flex items-center gap-0.5">壓 {idx.resistance.map((v) => (
                        <span key={v} className="px-1 py-0.5 rounded bg-red-50 text-red-500 border border-red-100 tabular-nums">{fmtNum(v)}</span>
                      ))}</span>
                    )}
                    {idx.support.length > 0 && (
                      <span className="flex items-center gap-0.5">撐 {idx.support.map((v) => (
                        <span key={v} className="px-1 py-0.5 rounded bg-green-50 text-green-700 border border-green-100 tabular-nums">{fmtNum(v)}</span>
                      ))}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PriceCell({ data }: { data?: StockPriceData }) {
  if (!data?.price) return <span className="text-gray-300 text-xs">—</span>;
  const up = (data.change ?? 0) >= 0;
  const color = up ? "text-red-500" : "text-green-600";
  return (
    <div className="leading-tight">
      <div className={`font-semibold tabular-nums text-sm ${color}`}>{data.price.toLocaleString()}</div>
      {data.change_pct !== null && (
        <div className={`text-xs ${color}`}>
          {up ? "▲" : "▼"}{Math.abs(data.change_pct).toFixed(2)}%
        </div>
      )}
    </div>
  );
}

function BbTag({ signal, pctB }: { signal?: string | null; pctB?: number | null }) {
  if (!signal || signal === "帶內整理") return null;
  const cls =
    signal === "突破上軌" ? "bg-purple-100 text-purple-700 border-purple-300" :
    signal === "近上軌"   ? "bg-purple-50 text-purple-500 border-purple-200" :
    signal === "跌破下軌" ? "bg-indigo-100 text-indigo-700 border-indigo-300" :
    signal === "近下軌"   ? "bg-indigo-50 text-indigo-500 border-indigo-200" :
                            "bg-gray-50 text-gray-400 border-gray-200";
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs border font-medium ${cls}`}>
      布林 {signal}
    </span>
  );
}

function TowerTag({ tower }: { tower?: TowerSignal | null }) {
  if (!tower) return null;
  const isYang = tower.color === "陽";
  const isReversal = tower.signal === "轉陽" || tower.signal === "轉陰";
  const cls = isReversal
    ? isYang ? "bg-red-500 text-white border-red-500" : "bg-green-600 text-white border-green-600"
    : isYang ? "bg-red-50 text-red-500 border-red-200" : "bg-green-50 text-green-700 border-green-200";
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs border font-medium ${cls}`}>
      寶塔 {tower.signal}{!isReversal && ` ${tower.count}根`}
    </span>
  );
}

function SignalTag({ signal, loading }: { signal?: StockSignal; loading: boolean }) {
  if (loading) return <div className="animate-pulse bg-gray-100 rounded h-4 w-20" />;
  if (!signal) return null;
  const cls = SUGGESTION_STYLE_MAP[signal.suggestion] ?? "bg-gray-50 text-gray-400 border-gray-200";
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border ${cls}`}>
      {signal.suggestion}
    </span>
  );
}

function SignalDetail({ signal }: { signal: StockSignal }) {
  const change = signal.price_change_5d;
  const changeStr = change !== null ? `${change >= 0 ? "+" : ""}${change}%` : null;
  const changeColor = change !== null ? (change >= 0 ? "text-red-500" : "text-green-600") : "text-gray-400";
  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-3 flex-wrap text-xs text-gray-400">
        {changeStr && <span>5日 <span className={`font-medium ${changeColor}`}>{changeStr}</span></span>}
        {signal.ma_position && <span className="font-medium text-gray-700">{signal.ma_position}</span>}
        <span className="text-gray-300">|</span>
        <span>MA5 <span className="text-gray-600">{signal.ma5}</span></span>
        {signal.ma10 != null && <span>MA10 <span className="text-gray-600">{signal.ma10}</span></span>}
        <span>MA20 <span className="text-gray-600">{signal.ma20}</span></span>
        {signal.ma60 != null && <span>MA60 <span className="text-gray-600">{signal.ma60}</span></span>}
        {signal.volume_signal && <span>{signal.volume_signal}</span>}
        {signal.rsi !== null && <span>RSI <span className="text-gray-600">{signal.rsi}</span></span>}
        <TowerTag tower={signal.tower} />
        <BbTag signal={signal.bb_signal} pctB={signal.bb_pct_b} />
      </div>
      {(signal.resistance.length > 0 || signal.support.length > 0) && (
        <div className="flex items-center gap-3 flex-wrap text-xs">
          {signal.resistance.length > 0 && (
            <span className="flex items-center gap-1 text-gray-400">
              壓力
              {signal.resistance.map((v) => (
                <span key={v} className="px-1.5 py-0.5 rounded bg-red-50 text-red-500 border border-red-100 font-medium tabular-nums">{v}</span>
              ))}
            </span>
          )}
          {signal.support.length > 0 && (
            <span className="flex items-center gap-1 text-gray-400">
              支撐
              {signal.support.map((v) => (
                <span key={v} className="px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-100 font-medium tabular-nums">{v}</span>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function fmtInst(n: number): string {
  return Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function FundRow({ fund }: { fund?: FundamentalSummary }) {
  if (!fund) return null;
  const r = fund.revenue;
  const inst = fund.inst_latest;
  if (!r && !inst) return null;
  return (
    <div className="flex items-center gap-2 flex-wrap text-xs text-gray-400 mt-1">
      {r?.yoy_pct !== undefined && r.yoy_pct !== null && (
        <span>
          營收YoY <span className={r.yoy_pct >= 0 ? "text-red-500 font-medium" : "text-green-600 font-medium"}>
            {r.yoy_pct >= 0 ? "+" : ""}{r.yoy_pct}%
          </span>
        </span>
      )}
      {inst && (
        <span>
          外資 <span className={inst.foreign >= 0 ? "text-red-500 font-medium" : "text-green-600 font-medium"}>
            {inst.foreign >= 0 ? "+" : ""}{fmtInst(inst.foreign)}
          </span>
        </span>
      )}
    </div>
  );
}

function ListSignalCell({ signal, loading, fund, expanded, onToggle }: { signal?: StockSignal; loading: boolean; fund?: FundamentalSummary; expanded: boolean; onToggle: () => void }) {
  if (loading) return <div className="space-y-1 animate-pulse"><div className="bg-gray-100 rounded h-4 w-24" /></div>;
  if (!signal) return <span className="text-gray-300 text-xs">—</span>;

  const change = signal.price_change_5d;
  const changeStr = change !== null ? `${change >= 0 ? "+" : ""}${change}%` : null;
  const changeColor = change !== null ? (change >= 0 ? "text-red-500" : "text-green-600") : "";
  const cls = SUGGESTION_STYLE_MAP[signal.suggestion] ?? "bg-gray-50 text-gray-400 border-gray-200";

  return (
    <div className="space-y-1">
      <div className="flex items-start gap-1">
        <div className="flex-1 flex items-center gap-1.5 flex-wrap">
          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs border ${cls}`}>
            {signal.suggestion}
          </span>
          {expanded && <>
            <TowerTag tower={signal.tower} />
            <BbTag signal={signal.bb_signal} pctB={signal.bb_pct_b} />
            {changeStr && <span className={`text-xs ${changeColor} font-medium`}>5日 {changeStr}</span>}
            {signal.rsi !== null && <span className="text-xs text-gray-400">RSI <span className="text-gray-600">{signal.rsi}</span></span>}
          </>}
        </div>
        <button onClick={onToggle} className="shrink-0 text-xs text-gray-300 hover:text-blue-400 transition leading-none pt-0.5">
          {expanded ? "▲" : "▼"}
        </button>
      </div>
      {expanded && <>
        {signal.ma_position && <div className="text-xs text-gray-500">{signal.ma_position}</div>}
        {(signal.resistance.length > 0 || signal.support.length > 0) && (
          <div className="flex items-center gap-2 flex-wrap text-xs text-gray-400">
            {signal.resistance.length > 0 && (
              <span className="flex items-center gap-1">
                壓 {signal.resistance.map((v) => (
                  <span key={v} className="px-1 py-0.5 rounded bg-red-50 text-red-500 border border-red-100 tabular-nums">{v}</span>
                ))}
              </span>
            )}
            {signal.support.length > 0 && (
              <span className="flex items-center gap-1">
                撐 {signal.support.map((v) => (
                  <span key={v} className="px-1 py-0.5 rounded bg-green-50 text-green-700 border border-green-100 tabular-nums">{v}</span>
                ))}
              </span>
            )}
          </div>
        )}
        <FundRow fund={fund} />
      </>}
    </div>
  );
}

function DragHandle() {
  return (
    <div className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-400 select-none px-0.5">
      <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
        <circle cx="3" cy="3" r="1.5"/><circle cx="7" cy="3" r="1.5"/>
        <circle cx="3" cy="8" r="1.5"/><circle cx="7" cy="8" r="1.5"/>
        <circle cx="3" cy="13" r="1.5"/><circle cx="7" cy="13" r="1.5"/>
      </svg>
    </div>
  );
}

// ── 分組標籤（行內小 pill）──────────────────────────────
function TabPill({ code, tabs, assigns, onOpen, showAdd = false }: {
  code: string;
  tabs: Tab[];
  assigns: Record<string, string>;
  onOpen: (code: string, rect: DOMRect) => void;
  showAdd?: boolean;
}) {
  if (tabs.length === 0) return null;
  const tabId = assigns[code];
  const tabIdx = tabs.findIndex(t => t.id === tabId);
  const tab = tabIdx >= 0 ? tabs[tabIdx] : null;
  if (!tab && !showAdd) return null;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onOpen(code, e.currentTarget.getBoundingClientRect()); }}
      className="shrink-0"
    >
      {tab ? (
        <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${tabColor(tabIdx).pill}`}>
          {tab.name}
        </span>
      ) : (
        <span className="text-xs text-gray-300 hover:text-gray-400 transition">＋分組</span>
      )}
    </button>
  );
}

function ListView({ items, onRemove, signals, signalsLoading, prices, fundamentals, expandedSignals, onToggleSignal, pinnedCodes, onTogglePin, onDragStart, onDragOver, onDragEnterEl, onDragLeaveEl, onDrop, onDragEnd, tabs, assigns, onOpenAssignMenu }: {
  items: WatchlistItem[];
  onRemove: (code: string) => void;
  signals: Record<string, StockSignal>;
  signalsLoading: boolean;
  prices: Record<string, StockPriceData>;
  fundamentals: Record<string, FundamentalSummary>;
  expandedSignals: Set<string>;
  onToggleSignal: (code: string) => void;
  pinnedCodes: Set<string>;
  onTogglePin: (code: string) => void;
  onDragStart: (e: React.DragEvent, i: number) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnterEl: (e: React.DragEvent) => void;
  onDragLeaveEl: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, i: number) => void;
  onDragEnd: (e: React.DragEvent) => void;
  tabs: Tab[];
  assigns: Record<string, string>;
  onOpenAssignMenu: (code: string, rect: DOMRect) => void;
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      <div className="grid grid-cols-12 gap-x-1 px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs text-gray-400 font-medium uppercase tracking-wide">
        <div className="col-span-1" />
        <div className="col-span-4 sm:col-span-2">股票</div>
        <div className="hidden sm:block sm:col-span-2 text-center">評等</div>
        <div className="col-span-3 sm:col-span-2">現價</div>
        <div className="hidden sm:block sm:col-span-2">目標價</div>
        <div className="col-span-3 sm:col-span-2">價量訊號</div>
        <div className="col-span-1" />
      </div>
      <div className="divide-y divide-gray-50">
        {items.map((item, idx) => (
          <div
            key={item.stock_code}
            data-draggable
            draggable
            onDragStart={(e) => onDragStart(e, idx)}
            onDragOver={onDragOver}
            onDragEnter={onDragEnterEl}
            onDragLeave={onDragLeaveEl}
            onDrop={(e) => onDrop(e, idx)}
            onDragEnd={onDragEnd}
            className={`grid grid-cols-12 gap-x-1 px-3 py-2 items-center hover:bg-gray-50 transition group ${pinnedCodes.has(item.stock_code) ? "bg-amber-50" : ""}`}
          >
            <div className="col-span-1 flex items-center gap-0.5 self-start pt-1.5">
              <button
                onClick={() => onTogglePin(item.stock_code)}
                className={`transition ${pinnedCodes.has(item.stock_code) ? "text-amber-400" : "text-gray-300 hover:text-amber-300 sm:opacity-0 sm:group-hover:opacity-100"}`}
                title={pinnedCodes.has(item.stock_code) ? "取消置頂" : "置頂"}
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1v8l2 4H6l2-4V1h8zm-4 18a2 2 0 01-2-2h4a2 2 0 01-2 2zM10 1h4"/></svg>
              </button>
              <DragHandle />
            </div>
            <div className="col-span-4 sm:col-span-2 flex flex-col justify-center min-w-0">
              <div className="flex items-center gap-1 min-w-0">
                <Link
                  to={`/stocks/${item.stock_code}`}
                  state={{ from: "/", label: "自選股" }}
                  className="font-mono font-bold text-sm text-blue-600 hover:underline leading-tight shrink-0"
                >
                  {item.stock_code}
                </Link>
                <TabPill code={item.stock_code} tabs={tabs} assigns={assigns} onOpen={onOpenAssignMenu} />
              </div>
              {item.stock_name && (
                <span className="text-xs text-gray-500 truncate leading-tight">{item.stock_name}</span>
              )}
            </div>
            <div className="hidden sm:flex sm:col-span-2 justify-center">
              <RecommendationBadge value={item.latest_report?.recommendation ?? null} compact />
            </div>
            <div className="col-span-3 sm:col-span-2 flex items-center">
              <PriceCell data={prices[item.stock_code]} />
            </div>
            <div className="hidden sm:flex sm:col-span-2 tabular-nums text-sm text-gray-600 items-center">
              {item.latest_report?.target_price ?? <span className="text-gray-300">—</span>}
            </div>
            <div className="col-span-3 sm:col-span-2 overflow-hidden">
              <ListSignalCell signal={signals[item.stock_code]} loading={signalsLoading} fund={fundamentals[item.stock_code]} expanded={expandedSignals.has(item.stock_code)} onToggle={() => onToggleSignal(item.stock_code)} />
            </div>
            <div className="col-span-1 flex justify-end self-start pt-1.5">
              <button
                onClick={() => onRemove(item.stock_code)}
                className="text-xs text-gray-300 hover:text-red-400 transition sm:opacity-0 sm:group-hover:opacity-100"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CardView({ items, onRemove, signals, signalsLoading, prices, fundamentals, expandedSignals, onToggleSignal, pinnedCodes, onTogglePin, onDragStart, onDragOver, onDragEnterEl, onDragLeaveEl, onDrop, onDragEnd, tabs, assigns, onOpenAssignMenu }: {
  items: WatchlistItem[];
  onRemove: (code: string) => void;
  signals: Record<string, StockSignal>;
  signalsLoading: boolean;
  prices: Record<string, StockPriceData>;
  fundamentals: Record<string, FundamentalSummary>;
  expandedSignals: Set<string>;
  onToggleSignal: (code: string) => void;
  pinnedCodes: Set<string>;
  onTogglePin: (code: string) => void;
  onDragStart: (e: React.DragEvent, i: number) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnterEl: (e: React.DragEvent) => void;
  onDragLeaveEl: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, i: number) => void;
  onDragEnd: (e: React.DragEvent) => void;
  tabs: Tab[];
  assigns: Record<string, string>;
  onOpenAssignMenu: (code: string, rect: DOMRect) => void;
}) {
  return (
    <div className="space-y-3">
      {items.map((item, idx) => {
        const tabId = assigns[item.stock_code];
        const tabIdx = tabs.findIndex(t => t.id === tabId);
        const tab = tabIdx >= 0 ? tabs[tabIdx] : null;
        return (
          <div
            key={item.stock_code}
            data-draggable
            draggable
            onDragStart={(e) => onDragStart(e, idx)}
            onDragOver={onDragOver}
            onDragEnter={onDragEnterEl}
            onDragLeave={onDragLeaveEl}
            onDrop={(e) => onDrop(e, idx)}
            onDragEnd={onDragEnd}
            className={`rounded-xl shadow-sm border p-5 ${pinnedCodes.has(item.stock_code) ? "bg-amber-50 border-amber-200" : "bg-white border-gray-200"}`}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2 flex-wrap">
                <Link
                  draggable={false}
                  to={`/stocks/${item.stock_code}`}
                  state={{ from: "/", label: "自選股" }}
                  className="font-mono font-bold text-lg text-blue-600 hover:underline"
                >
                  {item.stock_code}
                </Link>
                {item.stock_name && <span className="text-gray-600">{item.stock_name}</span>}
                {tab && (
                  <button
                    onClick={(e) => onOpenAssignMenu(item.stock_code, e.currentTarget.getBoundingClientRect())}
                    className={`text-xs px-1.5 py-0.5 rounded border font-medium ${tabColor(tabIdx).pill}`}
                  >
                    {tab.name}
                  </button>
                )}
                {!tab && tabs.length > 0 && (
                  <button
                    onClick={(e) => onOpenAssignMenu(item.stock_code, e.currentTarget.getBoundingClientRect())}
                    className="text-xs text-gray-300 hover:text-gray-400 transition"
                  >
                    ＋分組
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onTogglePin(item.stock_code)}
                  className={`transition ${pinnedCodes.has(item.stock_code) ? "text-amber-400" : "text-gray-300 hover:text-amber-300"}`}
                  title={pinnedCodes.has(item.stock_code) ? "取消置頂" : "置頂"}
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1v8l2 4H6l2-4V1h8zm-4 18a2 2 0 01-2-2h4a2 2 0 01-2 2zM10 1h4"/></svg>
                </button>
                <DragHandle />
                <button onClick={() => onRemove(item.stock_code)} className="text-xs text-gray-400 hover:text-red-500 transition">移除</button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              {prices[item.stock_code] && <PriceCell data={prices[item.stock_code]} />}
              {item.latest_report ? (
                <>
                  <RecommendationBadge value={item.latest_report.recommendation} />
                  {item.latest_report.target_price && (
                    <span className="text-sm text-gray-500">目標 <span className="font-semibold text-gray-700">{item.latest_report.target_price}</span></span>
                  )}
                  {item.latest_report.analyst && <span className="text-sm text-gray-400">{item.latest_report.analyst}</span>}
                  <span className="text-xs text-gray-400 ml-auto">
                    {(item.latest_report.report_date ?? item.latest_report.created_at)?.slice(0, 10)}
                  </span>
                </>
              ) : (
                <span className="text-sm text-gray-400">尚無報告</span>
              )}
            </div>

            {item.latest_report?.summary && (
              <p className="mt-2 text-sm text-gray-600 line-clamp-2">{item.latest_report.summary}</p>
            )}

            <div className="mt-2">
              <div className="flex items-center gap-2 flex-wrap">
                <SignalTag signal={signals[item.stock_code]} loading={signalsLoading} />
                {signals[item.stock_code] && (
                  <button onClick={() => onToggleSignal(item.stock_code)} className="text-xs text-gray-400 hover:text-blue-500 transition">
                    {expandedSignals.has(item.stock_code) ? "收合 ▲" : "詳情 ▼"}
                  </button>
                )}
              </div>
              {expandedSignals.has(item.stock_code) && signals[item.stock_code] && (
                <SignalDetail signal={signals[item.stock_code]} />
              )}
            </div>

            <FundRow fund={fundamentals[item.stock_code]} />

            <Link
              to={`/stocks/${item.stock_code}`}
              state={{ from: "/", label: "自選股" }}
              draggable={false}
              className="mt-2 inline-block text-xs text-blue-500 hover:underline"
            >
              查看所有報告 →
            </Link>
          </div>
        );
      })}
    </div>
  );
}

export default function WatchlistPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [parsing, setParsing] = useState(false);
  const [parsedStocks, setParsedStocks] = useState<{ code: string; name: string | null }[] | null>(null);
  const [adding, setAdding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [marketExpanded, setMarketExpanded] = useState(false);
  const [expandedSignals, setExpandedSignals] = useState<Set<string>>(new Set());
  const toggleSignal = (code: string) =>
    setExpandedSignals(prev => { const s = new Set(prev); s.has(code) ? s.delete(code) : s.add(code); return s; });
  const [signals, setSignals] = useState<Record<string, StockSignal>>({});
  const [signalsLoading, setSignalsLoading] = useState(false);
  const [prices, setPrices] = useState<Record<string, StockPriceData>>({});
  const [marketData, setMarketData] = useState<Record<string, MarketIndex> | null>(null);
  const [orderedCodes, setOrderedCodes] = useState<string[]>([]);
  const [fundamentals, setFundamentals] = useState<Record<string, FundamentalSummary>>({});
  const dragSrc = useRef<number | null>(null);

  const storageKey = user ? `watchlist_order_${user.email ?? (user as any).id ?? "default"}` : null;
  const pinKey     = user ? `watchlist_pin_${user.email ?? (user as any).id ?? "default"}` : null;

  // ── 頁籤狀態（後端同步）──────────────────────────────
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [assigns, setAssigns] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<string>("all");
  const [addingTab, setAddingTab] = useState(false);
  const [newTabName, setNewTabName] = useState("");
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // 分組選單
  const [assignMenu, setAssignMenu] = useState<{ code: string; rect: DOMRect } | null>(null);

  const loadGroups = () => {
    if (!user) return;
    watchlistGroupsApi.list().then(groups => {
      setTabs(groups.map(g => ({ id: String(g.id), name: g.name })));
    }).catch(() => {});
  };

  const handleAddTab = async () => {
    const name = newTabName.trim();
    if (!name) { setAddingTab(false); setNewTabName(""); return; }
    try {
      const g = await watchlistGroupsApi.create(name);
      setTabs(prev => [...prev, { id: String(g.id), name: g.name }]);
      setActiveTab(String(g.id));
    } catch {}
    setNewTabName("");
    setAddingTab(false);
  };

  const handleDeleteTab = async (tabId: string) => {
    try {
      await watchlistGroupsApi.delete(Number(tabId));
      setTabs(prev => prev.filter(t => t.id !== tabId));
      setAssigns(prev => {
        const next = { ...prev };
        Object.keys(next).forEach(c => { if (next[c] === tabId) delete next[c]; });
        return next;
      });
      if (activeTab === tabId) setActiveTab("all");
    } catch {}
  };

  const handleRenameTab = async (tabId: string) => {
    const name = renameValue.trim();
    setRenamingTabId(null);
    if (!name) return;
    try {
      await watchlistGroupsApi.rename(Number(tabId), name);
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, name } : t));
    } catch {}
  };

  const handleAssign = async (code: string, tabId: string | null) => {
    // 樂觀更新
    setAssigns(prev => {
      const next = { ...prev };
      if (tabId) next[code] = tabId; else delete next[code];
      return next;
    });
    try {
      await watchlistApi.assignGroup(code, tabId ? Number(tabId) : null);
    } catch {}
  };

  const openAssignMenu = (code: string, rect: DOMRect) => {
    setAssignMenu({ code, rect });
  };

  // ── 置頂 ──────────────────────────────────────────────
  const [pinnedCodes, setPinnedCodes] = useState<Set<string>>(new Set());
  // user 載入後才能讀到正確的 pinKey
  useEffect(() => {
    if (!pinKey) return;
    try { setPinnedCodes(new Set(JSON.parse(localStorage.getItem(pinKey) ?? "[]"))); } catch {}
  }, [pinKey]);
  const togglePin = (code: string) => {
    setPinnedCodes(prev => {
      const s = new Set(prev);
      s.has(code) ? s.delete(code) : s.add(code);
      if (pinKey) localStorage.setItem(pinKey, JSON.stringify([...s]));
      return s;
    });
  };

  const loadSignals = (codes: string[]) => {
    if (codes.length === 0) return;
    setSignalsLoading(true);
    stocksApi.batch_signals(codes).then(setSignals).catch(() => {}).finally(() => setSignalsLoading(false));
  };
  const loadPrices = (codes: string[]) => {
    if (codes.length === 0) return;
    stocksApi.batch_prices(codes).then(setPrices).catch(() => {});
  };
  const loadFundamentals = (codes: string[]) => {
    if (codes.length === 0) return;
    fundamentalsApi.batch(codes).then(setFundamentals).catch(() => {});
  };
  const loadMarket = () => { stocksApi.market_overview().then(setMarketData).catch(() => {}); };

  const load = () => {
    setLoading(true);
    watchlistApi.get().then((data) => {
      setItems(data);
      const codes = data.map((i) => i.stock_code);
      loadSignals(codes);
      loadPrices(codes);
      loadFundamentals(codes);
    }).finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!storageKey) return;
    const codes = items.map((i) => i.stock_code);
    const saved: string[] = (() => { try { return JSON.parse(localStorage.getItem(storageKey) ?? "[]"); } catch { return []; } })();
    setOrderedCodes([
      ...codes.filter((c) => !saved.includes(c)),
      ...saved.filter((c) => codes.includes(c)),
    ]);
  }, [items]);

  const baseItems = orderedCodes.length
    ? (orderedCodes.map((c) => items.find((i) => i.stock_code === c)).filter(Boolean) as WatchlistItem[])
    : items;
  const displayItems = [
    ...baseItems.filter(i => pinnedCodes.has(i.stock_code)),
    ...baseItems.filter(i => !pinnedCodes.has(i.stock_code)),
  ];
  const filteredItems = activeTab === "all"
    ? displayItems
    : displayItems.filter(i => assigns[i.stock_code] === activeTab);

  const handleDragStart = (e: React.DragEvent, i: number) => {
    dragSrc.current = i;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(i));
    (e.currentTarget as HTMLElement).style.opacity = "0.4";
  };
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; };
  const handleDragEnterEl = (e: React.DragEvent) => { (e.currentTarget as HTMLElement).style.borderTop = "2px solid #3b82f6"; };
  const handleDragLeaveEl = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node))
      (e.currentTarget as HTMLElement).style.borderTop = "";
  };
  const handleDrop = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).style.borderTop = "";
    const fromIdx = dragSrc.current;
    dragSrc.current = null;
    if (fromIdx === null || fromIdx === targetIdx) return;
    const fromCode = filteredItems[fromIdx]?.stock_code;
    const toCode = filteredItems[targetIdx]?.stock_code;
    if (!fromCode || !toCode) return;
    setOrderedCodes((prev) => {
      const allCodes = prev.length ? prev : items.map(i => i.stock_code);
      const next = [...allCodes];
      const fromPos = next.indexOf(fromCode);
      const toPos = next.indexOf(toCode);
      if (fromPos === -1 || toPos === -1) return prev;
      const [moved] = next.splice(fromPos, 1);
      next.splice(toPos, 0, moved);
      if (storageKey) localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  };
  const handleDragEnd = (e: React.DragEvent) => {
    dragSrc.current = null;
    (e.currentTarget as HTMLElement).style.opacity = "";
    document.querySelectorAll<HTMLElement>("[data-draggable]").forEach((el) => { el.style.borderTop = ""; });
  };

  // items 載入後同步 assigns
  useEffect(() => {
    const map: Record<string, string> = {};
    items.forEach(i => { if (i.group_id != null) map[i.stock_code] = String(i.group_id); });
    setAssigns(map);
  }, [items]);

  useAutoRefresh(load, 10000);
  useEffect(() => { loadMarket(); }, []);
  useEffect(() => { if (user) { load(); loadGroups(); } else setLoading(false); }, [user]);

  const handleRemove = async (code: string) => {
    await watchlistApi.remove(code);
    load();
  };

  const watchedCodes = new Set(items.map((i) => i.stock_code));

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setParsing(true);
    setParsedStocks(null);
    try {
      const res = await watchlistApi.parseImage(file);
      setParsedStocks(res.stocks);
    } catch {
      alert("圖片解析失敗，請再試一次");
    } finally {
      setParsing(false);
    }
  };

  const handleAddParsed = async () => {
    if (!parsedStocks) return;
    setAdding(true);
    const existing = watchedCodes;
    const toAdd = parsedStocks.filter((s) => !existing.has(s.code));
    for (const s of toAdd) {
      try { await watchlistApi.add(s.code, s.name ?? undefined); } catch {}
    }
    setParsedStocks(null);
    setAdding(false);
    load();
  };

  const activeTabName = activeTab === "all" ? undefined : tabs.find(t => t.id === activeTab)?.name;

  const sharedViewProps = {
    onRemove: handleRemove,
    signals, signalsLoading, prices, fundamentals,
    expandedSignals, onToggleSignal: toggleSignal,
    pinnedCodes, onTogglePin: togglePin,
    onDragStart: handleDragStart, onDragOver: handleDragOver,
    onDragEnterEl: handleDragEnterEl, onDragLeaveEl: handleDragLeaveEl,
    onDrop: handleDrop, onDragEnd: handleDragEnd,
    tabs, assigns, onOpenAssignMenu: openAssignMenu,
  };

  if (!user) {
    return (
      <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
        <MarketOverview data={marketData} expanded={marketExpanded} onToggle={() => setMarketExpanded(v => !v)} />
        <div className="text-center py-12">
          <p className="text-2xl mb-2">🔒</p>
          <p className="text-gray-600 font-medium mb-1">請先登入</p>
          <p className="text-sm text-gray-400">自選股依帳號儲存，登入後即可使用</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-4">
      {/* 分組選單浮層 */}
      {assignMenu && (
        <AssignMenu
          code={assignMenu.code}
          tabs={tabs}
          currentTabId={assigns[assignMenu.code]}
          onAssign={handleAssign}
          onClose={() => setAssignMenu(null)}
          anchorRect={assignMenu.rect}
        />
      )}

      {/* 黏性標題列 */}
      <div className="sticky top-16 z-10 bg-gray-50 -mx-4 px-4 border-b border-gray-200">
        <div className="py-2 flex items-center justify-between">
          <h1 className="text-lg font-bold text-gray-800">
            我的自選股
            {!loading && items.length > 0 && (
              <span className="ml-2 text-sm font-normal text-gray-400">{items.length} 支</span>
            )}
          </h1>
          {items.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
                <button
                  onClick={() => setViewMode("list")}
                  className={`px-2.5 py-1.5 flex items-center gap-1 transition ${viewMode === "list" ? "bg-blue-600 text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
                  列表
                </button>
                <button
                  onClick={() => setViewMode("card")}
                  className={`px-2.5 py-1.5 flex items-center gap-1 transition ${viewMode === "card" ? "bg-blue-600 text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
                  卡片
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 頁籤列 */}
        <div className="flex items-center gap-1 overflow-x-auto pb-2 -mx-1 px-1" style={{ scrollbarWidth: "none" }}>
          {/* 全部 */}
          <button
            onClick={() => setActiveTab("all")}
            className={`flex-shrink-0 px-3 py-1 rounded-full text-sm font-medium transition ${
              activeTab === "all" ? "bg-gray-800 text-white" : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
            }`}
          >
            全部{items.length > 0 && <span className="ml-1 opacity-60 text-xs">{items.length}</span>}
          </button>

          {/* 自訂頁籤 */}
          {tabs.map((tab, i) => {
            const count = items.filter(it => assigns[it.stock_code] === tab.id).length;
            const isActive = activeTab === tab.id;
            const color = tabColor(i);
            return (
              <div key={tab.id} className="flex-shrink-0 flex items-center">
                {renamingTabId === tab.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={() => handleRenameTab(tab.id)}
                    onKeyDown={e => {
                      if (e.key === "Enter") handleRenameTab(tab.id);
                      if (e.key === "Escape") setRenamingTabId(null);
                    }}
                    className="text-sm px-2 py-0.5 rounded border border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 w-24 bg-white"
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <button
                    onClick={() => setActiveTab(tab.id)}
                    onDoubleClick={() => { setRenamingTabId(tab.id); setRenameValue(tab.name); }}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium transition ${
                      isActive ? "bg-gray-800 text-white" : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full inline-block ${isActive ? "bg-white opacity-70" : color.dot}`} />
                    {tab.name}
                    {count > 0 && <span className="opacity-60 text-xs">{count}</span>}
                  </button>
                )}
                {isActive && renamingTabId !== tab.id && (
                  <button
                    onClick={() => handleDeleteTab(tab.id)}
                    className="ml-0.5 text-gray-400 hover:text-red-400 transition text-xs px-0.5"
                    title="刪除此頁籤"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}

          {/* 新增頁籤 */}
          {addingTab ? (
            <input
              autoFocus
              value={newTabName}
              onChange={e => setNewTabName(e.target.value)}
              onBlur={handleAddTab}
              onKeyDown={e => {
                if (e.key === "Enter") handleAddTab();
                if (e.key === "Escape") { setAddingTab(false); setNewTabName(""); }
              }}
              placeholder="頁籤名稱"
              className="flex-shrink-0 text-sm px-2 py-0.5 rounded border border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 w-24 bg-white"
            />
          ) : (
            <button
              onClick={() => setAddingTab(true)}
              className="flex-shrink-0 px-2 py-1 text-sm text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition"
              title="新增頁籤"
            >
              ＋
            </button>
          )}
        </div>
      </div>

      <MarketOverview data={marketData} expanded={marketExpanded} onToggle={() => setMarketExpanded(v => !v)} />

      {loading ? (
        viewMode === "list" ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden divide-y divide-gray-50">
            {[...Array(4)].map((_, i) => <SkeletonRow key={i} />)}
          </div>
        ) : (
          <div className="space-y-3">{[...Array(3)].map((_, i) => <SkeletonCard key={i} />)}</div>
        )
      ) : filteredItems.length === 0 ? (
        <EmptyState tabName={activeTabName} />
      ) : viewMode === "list" ? (
        <ListView items={filteredItems} {...sharedViewProps} />
      ) : (
        <CardView items={filteredItems} {...sharedViewProps} />
      )}

      {/* 浮動操作按鈕 */}
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
      <button
        onClick={() => { setShowAddPanel(v => !v); setParsedStocks(null); }}
        className="fixed bottom-6 left-6 z-50 w-12 h-12 rounded-full bg-blue-600 hover:bg-blue-700 text-white shadow-lg flex items-center justify-center transition"
        title="新增自選股"
      >
        <svg className={`w-5 h-5 transition-transform ${showAddPanel ? "rotate-45" : ""}`} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

      {showAddPanel && (
        <div className="fixed z-50 w-80 bg-white rounded-2xl shadow-2xl border border-gray-200 p-4 space-y-3" style={{ bottom: "5rem", left: "1.5rem" }}>
          <p className="text-sm font-semibold text-gray-700">新增自選股</p>
          <StockSearch onAdded={() => { load(); setShowAddPanel(false); }} watchedCodes={watchedCodes} />
          <div className="border-t border-gray-100 pt-3">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={parsing}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-dashed border-gray-300 text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 disabled:opacity-50 transition"
            >
              {parsing ? (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M16 8l-4-4-4 4M12 4v12"/></svg>
              )}
              {parsing ? "解析中…" : "上傳庫存截圖匯入"}
            </button>
          </div>
          {parsedStocks && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-gray-600">
                解析到 {parsedStocks.length} 檔
                {parsedStocks.filter(s => watchedCodes.has(s.code)).length > 0 && (
                  <span className="text-gray-400 ml-1">（{parsedStocks.filter(s => watchedCodes.has(s.code)).length} 檔已追蹤）</span>
                )}
              </p>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                {parsedStocks.map((s) => (
                  <span key={s.code} className={`text-xs px-2 py-1 rounded-full border ${watchedCodes.has(s.code) ? "bg-gray-50 text-gray-400 border-gray-200" : "bg-blue-50 text-blue-700 border-blue-200"}`}>
                    {s.code} {s.name}
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleAddParsed}
                  disabled={adding || parsedStocks.every(s => watchedCodes.has(s.code))}
                  className="flex-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg disabled:opacity-40 transition"
                >
                  {adding ? "加入中…" : `加入 ${parsedStocks.filter(s => !watchedCodes.has(s.code)).length} 檔`}
                </button>
                <button onClick={() => setParsedStocks(null)} className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-600">清除</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

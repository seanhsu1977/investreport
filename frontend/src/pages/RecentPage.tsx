import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { stocksApi, type Report, type RecentResponse } from "../api/client";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import RecommendationBadge from "../components/RecommendationBadge";
import ShareButton from "../components/ShareButton";
import StockLinkedText from "../components/StockLinkedText";
import { buildShareText, buildShareUrl } from "../utils/share";
import { useAuth } from "../contexts/AuthContext";

const PAGE_SIZE = 20;

function StockReportCard({ r, fromTab, selectable, selected, onToggle }: {
  r: Report; fromTab: string;
  selectable?: boolean; selected?: boolean; onToggle?: (id: number) => void;
}) {
  return (
    <div
      className={`bg-white rounded-xl shadow-sm border p-5 transition ${
        selectable && selected ? "border-blue-400 bg-blue-50" : "border-gray-200"
      }`}
      onClick={selectable ? () => onToggle?.(r.id) : undefined}
      style={selectable ? { cursor: "pointer" } : undefined}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          {selectable && (
            <input type="checkbox" checked={selected} onChange={() => onToggle?.(r.id)}
              onClick={(e) => e.stopPropagation()}
              className="accent-blue-600 w-4 h-4 shrink-0" />
          )}
          <Link to={`/stocks/${r.stock_code}`} state={{ from: "/recent", label: "近期消息", recentTab: fromTab }}
            className="font-mono font-bold text-blue-600 hover:underline"
            onClick={(e) => selectable && e.preventDefault()}>
            {r.stock_code}
          </Link>
          {r.stock_name && <span className="text-gray-600">{r.stock_name}</span>}
          <RecommendationBadge value={r.recommendation} />
          {r.target_price && (
            <span className="text-sm text-gray-500">目標價 <span className="font-semibold">{r.target_price}</span></span>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0 ml-2">
          <div className="text-xs text-gray-400 text-right space-y-0.5">
            {r.report_date && <div>報告日 {r.report_date.slice(0, 10)}</div>}
            {r.created_at && <div>加入 {r.created_at.slice(0, 10)}</div>}
            {r.analyst && <div>{r.analyst}</div>}
          </div>
          <ShareButton text={buildShareText(r)} url={buildShareUrl(r)} />
        </div>
      </div>
      {r.summary && <p className="text-sm text-gray-700 leading-relaxed mb-3">{r.summary}</p>}
      {r.key_points.length > 0 && (
        <ul className="space-y-1">
          {r.key_points.map((pt, i) => (
            <li key={i} className="text-sm text-gray-600 flex gap-2">
              <span className="text-blue-400 mt-0.5">▸</span><span>{pt}</span>
            </li>
          ))}
        </ul>
      )}
      {r.source_filename && (
        <p className="mt-2 pt-2 border-t border-gray-100 text-xs text-gray-400 truncate">📄 {r.source_filename}</p>
      )}
    </div>
  );
}

function NewsCard({ r, fromTab, selectable, selected, onToggle }: {
  r: Report & { mentioned_stocks?: string[] }; fromTab: string;
  selectable?: boolean; selected?: boolean; onToggle?: (id: number) => void;
}) {
  const mentioned = r.mentioned_stocks ?? [];
  const linkState = { from: "/recent", label: "近期消息", recentTab: fromTab };
  return (
    <div
      className={`bg-white rounded-xl shadow-sm border p-5 transition ${
        selectable && selected ? "border-blue-400 bg-blue-50" : "border-gray-200"
      }`}
      onClick={selectable ? () => onToggle?.(r.id) : undefined}
      style={selectable ? { cursor: "pointer" } : undefined}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          {selectable && (
            <input type="checkbox" checked={selected} onChange={() => onToggle?.(r.id)}
              onClick={(e) => e.stopPropagation()}
              className="accent-blue-600 w-4 h-4 shrink-0" />
          )}
          <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">市場新聞</span>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0 ml-2">
          <div className="text-xs text-gray-400 text-right space-y-0.5">
            {r.report_date && <div>報告日 {r.report_date.slice(0, 10)}</div>}
            {r.created_at && <div>加入 {r.created_at.slice(0, 10)}</div>}
          </div>
          <ShareButton text={buildShareText(r)} url={buildShareUrl(r)} />
        </div>
      </div>
      {r.summary && (
        <p className="text-sm text-gray-700 leading-relaxed mb-3">
          <StockLinkedText text={r.summary} mentionedStocks={mentioned} linkState={linkState} />
        </p>
      )}
      {r.key_points.length > 0 && (
        <ul className="space-y-1 mb-3">
          {r.key_points.map((pt, i) => (
            <li key={i} className="text-sm text-gray-600 flex gap-2">
              <span className="text-orange-400 mt-0.5">▸</span>
              <span><StockLinkedText text={pt} mentionedStocks={mentioned} linkState={linkState} /></span>
            </li>
          ))}
        </ul>
      )}
      {r.source_filename && (
        <p className="mb-2 text-xs text-gray-400 truncate">📄 {r.source_filename}</p>
      )}
      {mentioned.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-gray-100">
          <span className="text-xs text-gray-400">提及個股：</span>
          {[...new Set(mentioned)].map((entry) => {
            const m = entry.match(/^(\d{4})\s+(.+)$/);
            const code = m?.[1];
            const label = m ? `${m[1]} ${m[2]}` : entry;
            return code ? (
              <Link key={entry} to={`/stocks/${code}`} state={linkState}
                className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 transition">
                {label}
              </Link>
            ) : (
              <span key={entry} className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                {entry}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

type SortKey = "report_date" | "created_at";
type FilterRec = "all" | "買進" | "中立" | "賣出";
type TabKey = "stocks" | "news";

function sortReports(reports: Report[], sortKey: SortKey): Report[] {
  return [...reports].sort((a, b) => {
    const va = sortKey === "report_date" ? (a.report_date ?? a.created_at) : a.created_at;
    const vb = sortKey === "report_date" ? (b.report_date ?? b.created_at) : b.created_at;
    return (vb ?? "").localeCompare(va ?? "");
  });
}

function Pagination({ page, total, pageSize, onChange }: {
  page: number; total: number; pageSize: number; onChange: (p: number) => void;
}) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-2 pt-2">
      <button onClick={() => onChange(page - 1)} disabled={page === 1}
        className="px-3 py-1 rounded-lg border text-sm text-gray-600 border-gray-300 hover:bg-gray-50 disabled:opacity-40 transition">
        ‹ 上一頁
      </button>
      <span className="text-sm text-gray-500">
        第 <span className="font-semibold text-gray-700">{page}</span> / {totalPages} 頁
        <span className="ml-2 text-gray-400">（共 {total} 筆）</span>
      </span>
      <button onClick={() => onChange(page + 1)} disabled={page === totalPages}
        className="px-3 py-1 rounded-lg border text-sm text-gray-600 border-gray-300 hover:bg-gray-50 disabled:opacity-40 transition">
        下一頁 ›
      </button>
    </div>
  );
}

const BtnGroup = ({ label, options, value, onChange }: {
  label: string;
  options: { key: string; text: string }[];
  value: string;
  onChange: (v: string) => void;
}) => (
  <div className="flex items-center gap-1.5">
    <span className="text-xs text-gray-400">{label}</span>
    {options.map((o) => (
      <button key={o.key} onClick={() => onChange(o.key)}
        className={`px-2.5 py-1 rounded-lg border text-xs transition ${value === o.key ? "bg-blue-600 text-white border-blue-600" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}>
        {o.text}
      </button>
    ))}
  </div>
);

export default function RecentPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const restoredTab = (location.state as { tab?: TabKey } | null)?.tab;

  const [data, setData] = useState<RecentResponse | null>(null);
  const [days, setDays] = useState(3);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("report_date");
  const [filterRec, setFilterRec] = useState<FilterRec>("all");
  const [tab, setTab] = useState<TabKey>(restoredTab ?? "stocks");
  const [stockPage, setStockPage] = useState(1);
  const [newsPage, setNewsPage] = useState(1);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [keyword, setKeyword] = useState("");

  const toggleSelect = (id: number) =>
    setSelectedIds((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const exitSelect = () => { setSelectMode(false); setSelectedIds(new Set()); };

  const goToDraft = () =>
    navigate("/admin", { state: { tab: "publish", selectedIds: [...selectedIds] } });

  const fetchData = () => {
    stocksApi.recent(days).then(setData).catch(console.error);
  };

  useAutoRefresh(fetchData, 10000);

  useEffect(() => {
    setLoading(true);
    stocksApi.recent(days).then(setData).finally(() => setLoading(false));
    setStockPage(1);
    setNewsPage(1);
  }, [days]);

  // 切換篩選條件時重置頁碼
  useEffect(() => { setStockPage(1); }, [filterRec, sortKey, keyword]);
  useEffect(() => { setNewsPage(1); }, [keyword]);

  const kw = keyword.trim().toLowerCase();
  const matchReport = (r: Report) => {
    if (!kw) return true;
    return [r.stock_code, r.stock_name, r.analyst, r.summary, ...(r.key_points ?? [])]
      .some((v) => v?.toLowerCase().includes(kw));
  };

  const filteredReports = sortReports(
    (data?.stock_reports ?? []).filter(
      (r) => (filterRec === "all" || r.recommendation === filterRec) && matchReport(r)
    ),
    sortKey
  );
  const sortedNews = sortReports(
    (data?.market_news ?? []).filter(matchReport),
    sortKey
  );

  const pagedReports = filteredReports.slice((stockPage - 1) * PAGE_SIZE, stockPage * PAGE_SIZE);
  const pagedNews = sortedNews.slice((newsPage - 1) * PAGE_SIZE, newsPage * PAGE_SIZE);

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
      {/* 標題列 */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-800">近期重點消息</h1>
        <div className="flex items-center gap-3">
          <BtnGroup label="顯示近" options={[{key:"1",text:"1 天"},{key:"3",text:"3 天"},{key:"7",text:"7 天"}]}
            value={String(days)} onChange={(v) => setDays(Number(v))} />
          {user?.is_admin && (
            selectMode ? (
              <button onClick={exitSelect}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50 transition">
                取消選取
              </button>
            ) : (
              <button onClick={() => setSelectMode(true)}
                className="text-xs px-3 py-1.5 rounded-lg border border-blue-300 text-blue-600 hover:bg-blue-50 transition">
                選取報告
              </button>
            )
          )}
        </div>
      </div>

      {/* 頁籤 */}
      <div className="flex gap-1 border-b border-gray-200">
        {([
          { key: "stocks", label: "個股報告", count: data?.stock_reports.length ?? 0, color: "blue" },
          { key: "news",   label: "市場新聞",  count: data?.market_news.length ?? 0,   color: "orange" },
        ] as const).map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition -mb-px ${
              tab === t.key
                ? t.color === "blue"
                  ? "border-blue-500 text-blue-600"
                  : "border-orange-400 text-orange-500"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}>
            {t.label}
            <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
              tab === t.key
                ? t.color === "blue" ? "bg-blue-100 text-blue-600" : "bg-orange-100 text-orange-500"
                : "bg-gray-100 text-gray-400"
            }`}>{t.count}</span>
          </button>
        ))}
      </div>

      {/* 關鍵字搜尋 */}
      <div className="relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
        </svg>
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜尋股票代號、公司名稱、投顧、摘要…"
          className="w-full pl-9 pr-9 py-2 text-sm bg-white border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400 transition placeholder-gray-400"
        />
        {keyword && (
          <button onClick={() => setKeyword("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 transition">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        )}
      </div>

      {/* 篩選 & 排序列（僅個股報告頁籤顯示評等篩選） */}
      <div className="flex flex-wrap items-center gap-4 bg-white rounded-xl border border-gray-200 px-4 py-3">
        <BtnGroup label="排序" options={[{key:"report_date",text:"報告日期"},{key:"created_at",text:"加入時間"}]}
          value={sortKey} onChange={(v) => setSortKey(v as SortKey)} />
        {tab === "stocks" && (
          <>
            <div className="w-px h-4 bg-gray-200" />
            <BtnGroup label="評等" options={[{key:"all",text:"全部"},{key:"買進",text:"🟢 買進"},{key:"中立",text:"🟡 中立"},{key:"賣出",text:"🔴 賣出"}]}
              value={filterRec} onChange={(v) => setFilterRec(v as FilterRec)} />
          </>
        )}
      </div>

      {loading ? (
        <div className="space-y-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="bg-gray-200 rounded h-4 w-10" />
                  <div className="bg-gray-100 rounded h-4 w-16" />
                  <div className="bg-gray-200 rounded h-5 w-10" />
                </div>
                <div className="bg-gray-100 rounded h-3 w-16" />
              </div>
              <div className="space-y-1.5">
                <div className="bg-gray-100 rounded h-3 w-full" />
                <div className="bg-gray-100 rounded h-3 w-4/5" />
              </div>
            </div>
          ))}
        </div>
      ) : tab === "stocks" ? (
        <section className="space-y-4">
          {pagedReports.length === 0 ? (
            <p className="text-gray-400 text-sm">
              {kw ? `找不到包含「${keyword}」的報告` : filterRec !== "all" ? `沒有「${filterRec}」評等的報告` : `近 ${days} 天內沒有個股報告`}
            </p>
          ) : (
            <>
              {pagedReports.map((r) => (
                <StockReportCard key={r.id} r={r} fromTab={tab}
                  selectable={selectMode} selected={selectedIds.has(r.id)} onToggle={toggleSelect} />
              ))}
              <Pagination page={stockPage} total={filteredReports.length} pageSize={PAGE_SIZE} onChange={setStockPage} />
            </>
          )}
        </section>
      ) : (
        <section className="space-y-4">
          {pagedNews.length === 0 ? (
            <p className="text-gray-400 text-sm">{kw ? `找不到包含「${keyword}」的新聞` : `近 ${days} 天內沒有市場新聞`}</p>
          ) : (
            <>
              {pagedNews.map((r) => (
                <NewsCard key={r.id} r={r as any} fromTab={tab}
                  selectable={selectMode} selected={selectedIds.has(r.id)} onToggle={toggleSelect} />
              ))}
              <Pagination page={newsPage} total={sortedNews.length} pageSize={PAGE_SIZE} onChange={setNewsPage} />
            </>
          )}
        </section>
      )}

      {/* 浮動草稿列 */}
      {selectMode && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-white border border-gray-200 shadow-xl rounded-2xl px-5 py-3">
          <span className="text-sm text-gray-600">
            已選 <span className="font-semibold text-blue-600">{selectedIds.size}</span> 篇
          </span>
          <button onClick={exitSelect}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-400 hover:text-gray-600 transition">
            取消
          </button>
          <button
            onClick={goToDraft}
            disabled={selectedIds.size === 0}
            className="text-sm px-4 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-40 transition"
          >
            產生 Threads 草稿 →
          </button>
        </div>
      )}
    </div>
  );
}

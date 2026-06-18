import { useState } from "react";
import { Link } from "react-router-dom";
import { searchApi, type Report, type RecentResponse, type DirectStock } from "../api/client";
import RecommendationBadge from "../components/RecommendationBadge";
import ShareButton from "../components/ShareButton";
import StockLinkedText from "../components/StockLinkedText";
import { buildShareText, buildShareUrl } from "../utils/share";

type TabKey = "stocks" | "news";

/** 將文字中符合關鍵字的部分以黃底標注 */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-yellow-200 text-gray-900 rounded px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function StockReportCard({ r, tab, query }: { r: Report; tab: TabKey; query: string }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to={`/stocks/${r.stock_code}`}
            state={{ from: "/search", label: "搜尋結果", recentTab: tab }}
            className="font-mono font-bold text-blue-600 hover:underline"
          >
            <Highlight text={r.stock_code} query={query} />
          </Link>
          {r.stock_name && (
            <span className="text-gray-600">
              <Highlight text={r.stock_name} query={query} />
            </span>
          )}
          <RecommendationBadge value={r.recommendation} />
          {r.target_price && (
            <span className="text-sm text-gray-500">
              目標價 <span className="font-semibold">{r.target_price}</span>
            </span>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0 ml-2">
          <div className="text-xs text-gray-400 text-right space-y-0.5">
            {r.report_date && <div>報告日 {r.report_date.slice(0, 10)}</div>}
            {r.created_at && <div>加入 {r.created_at.slice(0, 10)}</div>}
            {r.analyst && (
              <div><Highlight text={r.analyst} query={query} /></div>
            )}
          </div>
          <ShareButton text={buildShareText(r)} url={buildShareUrl(r)} />
        </div>
      </div>
      {r.summary && (
        <p className="text-sm text-gray-700 leading-relaxed mb-3">
          <Highlight text={r.summary} query={query} />
        </p>
      )}
      {r.key_points.length > 0 && (
        <ul className="space-y-1">
          {r.key_points.map((pt, i) => (
            <li key={i} className="text-sm text-gray-600 flex gap-2">
              <span className="text-blue-400 mt-0.5">▸</span>
              <span><Highlight text={pt} query={query} /></span>
            </li>
          ))}
        </ul>
      )}
      {r.source_filename && (
        <p className="mt-2 pt-2 border-t border-gray-100 text-xs text-gray-400 truncate">
          📄 {r.source_filename}
        </p>
      )}
    </div>
  );
}

function NewsCard({ r, tab, query }: { r: Report & { mentioned_stocks?: string[] }; tab: TabKey; query: string }) {
  const mentioned = r.mentioned_stocks ?? [];
  const linkState = { from: "/search", label: "搜尋結果", recentTab: tab };
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">
            市場新聞
          </span>
          {r.analyst && (
            <span className="text-sm text-gray-500">
              <Highlight text={r.analyst} query={query} />
            </span>
          )}
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
              <span>
                <StockLinkedText text={pt} mentionedStocks={mentioned} linkState={linkState} />
              </span>
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
              <Link
                key={entry}
                to={`/stocks/${code}`}
                state={linkState}
                className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 transition"
              >
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

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState(""); // 實際套用高亮的關鍵字
  const [data, setData] = useState<RecentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [tab, setTab] = useState<TabKey>("stocks");

  const handleSearch = () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setSearched(false);
    searchApi
      .search(q)
      .then((res) => {
        setData(res);
        setAppliedQuery(q);
        setSearched(true);
        setTab("stocks");
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSearch();
  };

  const stockCount = data?.stock_reports.length ?? 0;
  const newsCount = data?.market_news.length ?? 0;
  const directStocks: DirectStock[] = data?.direct_stocks ?? [];

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">搜尋報告 / 新聞</h1>

      {/* 搜尋框 */}
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="輸入關鍵字（股票代號、名稱、分析師、摘要…）"
          className="flex-1 border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        <button
          onClick={handleSearch}
          disabled={loading}
          className="px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition disabled:opacity-50"
        >
          搜尋
        </button>
      </div>

      {/* 狀態提示 */}
      {loading && <p className="text-gray-400 text-sm">搜尋中…</p>}
      {!loading && !searched && (
        <p className="text-gray-400 text-sm">請輸入關鍵字後按搜尋或 Enter</p>
      )}
      {!loading && searched && stockCount === 0 && newsCount === 0 && directStocks.length === 0 && (
        <p className="text-gray-500 text-sm">找不到相關報告、新聞或個股</p>
      )}

      {/* 無報告個股快速跳轉 */}
      {!loading && searched && directStocks.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">個股（無相關報告）</p>
          <div className="flex flex-wrap gap-2">
            {directStocks.map((s) => (
              <Link
                key={s.code}
                to={`/stocks/${s.code}`}
                state={{ from: "/search", label: "搜尋結果" }}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 bg-white hover:bg-blue-50 hover:border-blue-300 transition text-sm shadow-sm"
              >
                <span className="font-mono font-bold text-blue-600">{s.code}</span>
                {s.name && <span className="text-gray-600">{s.name}</span>}
                <span className="text-gray-300">→</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* 結果 */}
      {!loading && searched && (stockCount > 0 || newsCount > 0) && (
        <>
          {/* 頁籤 */}
          <div className="flex gap-1 border-b border-gray-200">
            {(
              [
                { key: "stocks", label: "個股報告", count: stockCount, color: "blue" },
                { key: "news", label: "市場新聞", count: newsCount, color: "orange" },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition -mb-px ${
                  tab === t.key
                    ? t.color === "blue"
                      ? "border-blue-500 text-blue-600"
                      : "border-orange-400 text-orange-500"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                {t.label}
                <span
                  className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                    tab === t.key
                      ? t.color === "blue"
                        ? "bg-blue-100 text-blue-600"
                        : "bg-orange-100 text-orange-500"
                      : "bg-gray-100 text-gray-400"
                  }`}
                >
                  {t.count}
                </span>
              </button>
            ))}
          </div>

          {/* 卡片列表 */}
          {tab === "stocks" ? (
            <section className="space-y-4">
              {stockCount === 0 ? (
                <p className="text-gray-400 text-sm">無個股報告</p>
              ) : (
                data!.stock_reports.map((r) => (
                  <StockReportCard key={r.id} r={r} tab={tab} query={appliedQuery} />
                ))
              )}
            </section>
          ) : (
            <section className="space-y-4">
              {newsCount === 0 ? (
                <p className="text-gray-400 text-sm">無市場新聞</p>
              ) : (
                (data!.market_news as (Report & { mentioned_stocks?: string[] })[]).map((r) => (
                  <NewsCard key={r.id} r={r} tab={tab} query={appliedQuery} />
                ))
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import { stocksApi, watchlistApi, type Report, type StockPrice } from "../api/client";
import RecommendationBadge from "../components/RecommendationBadge";
import ShareButton from "../components/ShareButton";
import { buildShareText, buildShareUrl } from "../utils/share";
import { useAuth } from "../contexts/AuthContext";
import StockLinkedText from "../components/StockLinkedText";

const REC_COLOR: Record<string, string> = {
  買進: "bg-green-500",
  Buy: "bg-green-500",
  中立: "bg-yellow-400",
  Hold: "bg-yellow-400",
  賣出: "bg-red-500",
  Sell: "bg-red-500",
};

export default function StockPage() {
  const { user } = useAuth();
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const backState = location.state as { from?: string; label?: string; recentTab?: string } | null;
  const backPath = backState?.from ?? "/";
  const backLabel = backState?.label ?? "自選股";
  const backNavState = backState?.recentTab ? { tab: backState.recentTab } : undefined;
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);

  const [relatedNews, setRelatedNews] = useState<Report[]>([]);
  const [stockPrice, setStockPrice] = useState<StockPrice | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [inWatchlist, setInWatchlist] = useState(false);
  const [watchlistLoading, setWatchlistLoading] = useState(false);

  const fetchPrice = () => {
    if (!code) return;
    setPriceLoading(true);
    stocksApi.price(code).then(setStockPrice).catch(() => {}).finally(() => setPriceLoading(false));
  };

  useEffect(() => {
    if (!code) return;
    stocksApi
      .reports(code)
      .then((data) => {
        setReports(data.reports);
        setRelatedNews(data.related_news);
      })
      .finally(() => setLoading(false));
    fetchPrice();
    if (user) {
      watchlistApi.get().then((list) => {
        setInWatchlist(list.some((item) => item.stock_code === code));
      });
    }
  }, [code, user]);

  const toggleWatchlist = async () => {
    if (!code) return;
    setWatchlistLoading(true);
    try {
      if (inWatchlist) {
        await watchlistApi.remove(code);
        setInWatchlist(false);
      } else {
        await watchlistApi.add(code, stockName);
        setInWatchlist(true);
      }
    } finally {
      setWatchlistLoading(false);
    }
  };

  // 以報告日期新→舊排序（無報告日期者排最後，用加入時間補位）
  const sortedReports = [...reports].sort((a, b) => {
    const da = (a.report_date ?? a.created_at ?? "").slice(0, 10);
    const db = (b.report_date ?? b.created_at ?? "").slice(0, 10);
    if (da > db) return -1; // a 較新，排前面
    if (da < db) return 1;  // b 較新，排前面
    return 0;
  });

  const stockName = sortedReports[0]?.stock_name;
  const latest = sortedReports[0]; // 報告日期最新一筆

  // 趨勢資料（舊→新，左到右，與箭頭方向一致）
  const recTrend = [...sortedReports].reverse().map((r) => r.recommendation).filter(Boolean);
  const priceTrend = [...sortedReports].reverse().map((r) => r.target_price).filter(Boolean) as number[];

  type TabKey = "reports" | "news";
  const [tab, setTab] = useState<TabKey>("reports");

  return (
    <div className="max-w-3xl mx-auto py-8 px-4 space-y-6">
      {/* 標題列 */}
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => navigate(backPath, { state: backNavState })} className="text-sm text-blue-500 hover:underline">← {backLabel}</button>
        <h1 className="text-2xl font-bold text-gray-800">
          <a
            href={`https://www.nstock.tw/stock_info?stock_id=${code}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono hover:text-blue-600 transition"
          >{code}</a>
          {stockName && <span className="ml-2 text-gray-500 text-xl">{stockName}</span>}
        </h1>
        <span className="text-sm text-gray-400">{reports.length} 篇報告</span>
        {user && (
        <button
          onClick={toggleWatchlist}
          disabled={watchlistLoading}
          className={`ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition border shadow-sm disabled:opacity-50
            ${inWatchlist
              ? "bg-yellow-50 border-yellow-300 text-yellow-700 hover:bg-yellow-100"
              : "bg-white border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
        >
          <span>{inWatchlist ? "★" : "☆"}</span>
          <span>{inWatchlist ? "已加入自選" : "加入自選"}</span>
        </button>
        )}
      </div>

      {/* 趨勢摘要卡片 */}
      {!loading && reports.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 space-y-4">
          {/* 推薦趨勢 */}
          {recTrend.length > 0 && (
            <div>
              <p className="text-xs text-gray-400 mb-2">推薦評等趨勢</p>
              <div className="flex items-center gap-1 flex-wrap">
                {recTrend.map((rec, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${REC_COLOR[rec!] ?? "bg-gray-300"}`}
                    />
                    <span className="text-sm text-gray-700">{rec}</span>
                    {i < recTrend.length - 1 && (
                      <span className="text-gray-300 mx-1">→</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 目標價趨勢 */}
          {priceTrend.length > 0 && (
            <div>
              <p className="text-xs text-gray-400 mb-2">目標價趨勢</p>
              <div className="flex items-center gap-1 flex-wrap">
                {priceTrend.map((price, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <span className="text-sm font-semibold text-gray-800">{price}</span>
                    {i < priceTrend.length - 1 && (
                      <span className="text-gray-300 mx-1">→</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 現價 vs 目標價 */}
          {stockPrice?.price && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <p className="text-xs text-gray-400">即時股價</p>
                {stockPrice.date && <span className="text-xs text-gray-300">{stockPrice.date}</span>}
                <button
                  onClick={fetchPrice}
                  disabled={priceLoading}
                  className="ml-auto text-xs text-blue-500 hover:text-blue-700 disabled:opacity-40 transition"
                >
                  {priceLoading ? "更新中…" : "↻ 更新"}
                </button>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-2xl font-bold text-gray-800">{stockPrice.price}</span>
                {stockPrice.change !== null && (
                  <span className={`text-sm font-medium ${stockPrice.change >= 0 ? "text-red-500" : "text-green-600"}`}>
                    {stockPrice.change >= 0 ? "▲" : "▼"} {Math.abs(stockPrice.change)} ({stockPrice.change_pct?.toFixed(2)}%)
                  </span>
                )}
              </div>
            </div>
          )}

          {/* 最新結論 */}
          {latest && (
            <div className="pt-3 border-t border-gray-100 flex items-center gap-3">
              <span className="text-xs text-gray-400">最新結論</span>
              <RecommendationBadge value={latest.recommendation} />
              {latest.target_price && (
                <span className="text-sm text-gray-500">
                  目標價 <span className="font-semibold text-gray-800">{latest.target_price}</span>
                  {stockPrice?.price && (
                    <span className={`ml-1 font-medium ${latest.target_price > stockPrice.price ? "text-red-500" : "text-green-600"}`}>
                      ({latest.target_price > stockPrice.price ? "+" : ""}{((latest.target_price / stockPrice.price - 1) * 100).toFixed(1)}%)
                    </span>
                  )}
                </span>
              )}
              {latest.analyst && (
                <span className="text-xs text-gray-400">{latest.analyst}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 頁籤 */}
      {!loading && (
        <div className="flex gap-1 border-b border-gray-200">
          {([
            { key: "reports" as TabKey, label: "個股報告", count: reports.length, color: "blue" },
            { key: "news"    as TabKey, label: "市場新聞",  count: relatedNews.length, color: "orange" },
          ]).map((t) => (
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
              <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                tab === t.key
                  ? t.color === "blue" ? "bg-blue-100 text-blue-600" : "bg-orange-100 text-orange-500"
                  : "bg-gray-100 text-gray-400"
              }`}>{t.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* 內容區 */}
      {loading ? (
        <p className="text-gray-400">載入中…</p>
      ) : tab === "reports" ? (
        reports.length === 0 ? (
          <p className="text-gray-400">尚無報告資料</p>
        ) : (
          <div className="relative">
            {/* 時間軸線 */}
            <div className="absolute left-3 top-0 bottom-0 w-px bg-gray-200" />
            <div className="space-y-6">
              {sortedReports.map((r) => (
                <div key={r.id} className="relative pl-10">
                  {/* 時間軸節點 */}
                  <div
                    className={`absolute left-0.5 top-1.5 w-5 h-5 rounded-full border-2 border-white shadow-sm flex items-center justify-center
                      ${REC_COLOR[r.recommendation ?? ""] ?? "bg-gray-300"}`}
                  />
                  {/* 日期標籤 */}
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    {r.report_date && (
                      <span className="text-xs text-gray-400">報告日 {r.report_date.slice(0, 10)}</span>
                    )}
                    {r.created_at && (
                      <span className="text-xs text-gray-300">加入 {r.created_at.slice(0, 10)}</span>
                    )}
                    {r.analyst && (
                      <span className="text-xs text-gray-400">· {r.analyst}</span>
                    )}
                    <RecommendationBadge value={r.recommendation} />
                    {r.target_price && (
                      <span className="text-xs text-gray-500">
                        目標價 <span className="font-semibold">{r.target_price}</span>
                      </span>
                    )}
                    <span className="ml-auto">
                      <ShareButton text={buildShareText(r)} url={buildShareUrl(r)} />
                    </span>
                  </div>
                  {/* 報告內容 */}
                  <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                    {r.summary && (
                      <p className="text-sm text-gray-700 leading-relaxed mb-3">{r.summary}</p>
                    )}
                    {r.key_points.length > 0 && (
                      <ul className="space-y-1">
                        {r.key_points.map((pt, j) => (
                          <li key={j} className="text-sm text-gray-600 flex gap-2">
                            <span className="text-blue-400 mt-0.5">▸</span>
                            <span>{pt}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {r.source_filename && (
                      <p className="mt-2 pt-2 border-t border-gray-100 text-xs text-gray-400 truncate">📄 {r.source_filename}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      ) : (
        relatedNews.length === 0 ? (
          <p className="text-gray-400">無相關市場新聞</p>
        ) : (
          <div className="space-y-4">
            {relatedNews.map((r) => {
              const mentionedCodes = r.mentioned_stocks ?? [];
              const newsLinkState = { from: `/stocks/${code}`, label: stockName ?? code ?? "個股", recentTab: "news" };
              return (
              <div key={r.id} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs px-2 py-0.5 rounded bg-orange-50 text-orange-600 font-medium border border-orange-200">
                      {r.analyst ?? "市場新聞"}
                    </span>
                    {/* 入選原因：報告文字中提及本股代號 */}
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-50 text-gray-400 border border-gray-200">
                      報告提及 {code}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    <span className="text-xs text-gray-400">
                      {(r.report_date ?? r.created_at)?.slice(0, 10)}
                    </span>
                    <ShareButton text={buildShareText(r)} url={buildShareUrl(r)} />
                  </div>
                </div>
                {r.summary && (
                  <p className="text-sm text-gray-700 leading-relaxed mb-2">
                    <StockLinkedText text={r.summary} mentionedStocks={mentionedCodes} linkState={newsLinkState} />
                  </p>
                )}
                {r.key_points.length > 0 && (
                  <ul className="space-y-1">
                    {r.key_points.map((pt, i) => (
                      <li key={i} className="text-sm text-gray-600 flex gap-2">
                        <span className="text-orange-400 mt-0.5">▸</span>
                        <span><StockLinkedText text={pt} mentionedStocks={mentionedCodes} linkState={newsLinkState} /></span>
                      </li>
                    ))}
                  </ul>
                )}
                {r.source_filename && (
                  <p className="mt-2 pt-2 border-t border-gray-100 text-xs text-gray-400 truncate">📄 {r.source_filename}</p>
                )}
              </div>
            )})}
          </div>
        )
      )}
    </div>
  );
}

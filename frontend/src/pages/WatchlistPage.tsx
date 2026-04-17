import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import { watchlistApi, type WatchlistItem } from "../api/client";
import RecommendationBadge from "../components/RecommendationBadge";
import StockSearch from "../components/StockSearch";
import { useAuth } from "../contexts/AuthContext";

export default function WatchlistPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    watchlistApi
      .get()
      .then(setItems)
      .finally(() => setLoading(false));
  };

  useAutoRefresh(load, 10000);
  useEffect(() => { if (user) load(); else setLoading(false); }, [user]);

  const handleRemove = async (code: string) => {
    await watchlistApi.remove(code);
    load();
  };

  const watchedCodes = new Set(items.map((i) => i.stock_code));

  if (!user) {
    return (
      <div className="max-w-4xl mx-auto py-20 px-4 text-center">
        <p className="text-2xl mb-2">🔒</p>
        <p className="text-gray-600 font-medium mb-1">請先登入</p>
        <p className="text-sm text-gray-400">自選股依帳號儲存，登入後即可使用</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
      <div className="sticky top-16 z-10 bg-gray-50 pt-2 pb-3 -mx-4 px-4 border-b border-gray-200">
        <StockSearch onAdded={load} watchedCodes={watchedCodes} />
      </div>

      <h1 className="text-2xl font-bold text-gray-800">我的自選股</h1>

      {loading ? (
        <p className="text-gray-400">載入中…</p>
      ) : items.length === 0 ? (
        <p className="text-gray-400">尚未加入任何自選股</p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.stock_code}
              className="bg-white rounded-xl shadow-sm border border-gray-200 p-5"
            >
              <div className="flex items-start justify-between">
                <div>
                  <Link
                    to={`/stocks/${item.stock_code}`} state={{ from: "/", label: "自選股" }}
                    className="font-mono font-bold text-lg text-blue-600 hover:underline"
                  >
                    {item.stock_code}
                  </Link>
                  {item.stock_name && (
                    <span className="ml-2 text-gray-600">{item.stock_name}</span>
                  )}
                </div>
                <button
                  onClick={() => handleRemove(item.stock_code)}
                  className="text-xs text-gray-400 hover:text-red-500 transition"
                >
                  移除
                </button>
              </div>

              {item.latest_report ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <RecommendationBadge value={item.latest_report.recommendation} />
                  {item.latest_report.target_price && (
                    <span className="text-sm text-gray-500">
                      目標價{" "}
                      <span className="font-semibold text-gray-800">
                        {item.latest_report.target_price}
                      </span>
                    </span>
                  )}
                  {item.latest_report.analyst && (
                    <span className="text-sm text-gray-400">{item.latest_report.analyst}</span>
                  )}
                  <span className="text-xs text-gray-400 ml-auto">
                    {(item.latest_report.report_date ?? item.latest_report.created_at)?.slice(0, 10)}
                  </span>
                </div>
              ) : (
                <p className="mt-2 text-sm text-gray-400">尚無報告</p>
              )}

              {item.latest_report?.summary && (
                <p className="mt-2 text-sm text-gray-600 line-clamp-2">
                  {item.latest_report.summary}
                </p>
              )}

              <Link
                to={`/stocks/${item.stock_code}`} state={{ from: "/", label: "自選股" }}
                className="mt-2 inline-block text-xs text-blue-500 hover:underline"
              >
                查看所有報告 →
              </Link>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}

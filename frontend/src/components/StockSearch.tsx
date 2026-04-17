import { useState } from "react";
import { stocksApi, watchlistApi, type StockSummary } from "../api/client";

interface Props {
  onAdded: () => void;
  watchedCodes: Set<string>;
}

export default function StockSearch({ onAdded, watchedCodes }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSummary[]>([]);
  const [searched, setSearched] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    const all = await stocksApi.list();
    const q = query.trim().toLowerCase();
    setResults(
      all.filter(
        (s) =>
          s.stock_code.toLowerCase().includes(q) ||
          (s.stock_name ?? "").toLowerCase().includes(q)
      )
    );
    setSearched(true);
  };

  const handleAdd = async (stock: StockSummary) => {
    await watchlistApi.add(stock.stock_code, stock.stock_name ?? undefined);
    onAdded();
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
      <h2 className="font-semibold text-gray-700 mb-3">加入自選股</h2>
      <div className="flex gap-2 mb-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="輸入股票代碼或名稱…"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={handleSearch}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition"
        >
          搜尋
        </button>
      </div>

      {searched && results.length === 0 && (
        <p className="text-sm text-gray-400">找不到相關股票</p>
      )}

      <ul className="space-y-2">
        {results.map((s) => (
          <li
            key={s.stock_code}
            className="flex items-center justify-between p-2 rounded-lg hover:bg-gray-50"
          >
            <div>
              <span className="font-mono font-semibold text-gray-800">{s.stock_code}</span>
              {s.stock_name && (
                <span className="ml-2 text-sm text-gray-500">{s.stock_name}</span>
              )}
              <span className="ml-2 text-xs text-gray-400">{s.report_count} 份報告</span>
            </div>
            <button
              onClick={() => handleAdd(s)}
              disabled={watchedCodes.has(s.stock_code)}
              className="text-xs px-3 py-1 rounded-lg border border-blue-500 text-blue-600 hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {watchedCodes.has(s.stock_code) ? "已加入" : "+ 加入"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

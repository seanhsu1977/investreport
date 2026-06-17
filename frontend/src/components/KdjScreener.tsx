import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { stocksApi, type KdjScreenItem } from "../api/client";

const SIGNAL_COLOR: Record<string, string> = {
  "低位金叉": "bg-red-100 text-red-700",
  "金叉":    "bg-orange-100 text-orange-700",
  "低位死叉": "bg-emerald-100 text-emerald-700",
  "死叉":    "bg-teal-100 text-teal-700",
  "高位死叉": "bg-green-100 text-green-700",
};

export default function KdjScreener() {
  const [result, setResult] = useState<{
    items: KdjScreenItem[];
    total: number;
    scanned: number;
    computed_at: string | null;
    data_date: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "golden" | "dead">("golden");

  useEffect(() => {
    stocksApi.kdj_screen()
      .then((r) => setResult(r))
      .catch((e: unknown) => {
        const msg =
          (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
          ?? (e as Error)?.message
          ?? "載入失敗";
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, []);

  const displayed = (result?.items ?? []).filter((it) => {
    if (filter === "golden") return it.kdj_signal === "低位金叉" || it.kdj_signal === "金叉";
    if (filter === "dead") return it.kdj_signal?.includes("死叉");
    return true;
  });

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400 px-1">
        KDJ(89,9,12) 近5天交叉訊號・自選股 + 00981A/00403A 成份股・每日收盤後更新
        {result?.data_date && (
          <span className="ml-1.5 text-gray-300">資料日期 {result.data_date}</span>
        )}
      </p>

      {loading && (
        <div className="flex justify-center py-12">
          <svg className="w-5 h-5 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a10 10 0 100 10H4z"/>
          </svg>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-500 text-center py-6">✗ {error}</p>
      )}

      {!loading && !error && result && (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-3 flex-wrap">
            <span className="text-xs text-gray-400">掃描 {result.scanned} 檔，命中 {result.total} 檔</span>
            <div className="flex gap-1.5 ml-auto">
              {(["golden", "dead", "all"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`text-xs px-2.5 py-1 rounded-full transition ${
                    filter === f ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {f === "golden" ? "金叉" : f === "dead" ? "死叉" : "全部"}
                </button>
              ))}
            </div>
          </div>

          {displayed.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">
              {result.total === 0
                ? "目前無 KDJ 金叉 / 死叉訊號個股"
                : "目前所選類型無符合，可切換至「全部」查看"}
            </p>
          ) : (
            <div className="divide-y divide-gray-50">
              {displayed.map((it) => (
                <div key={it.code} className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition">
                  <div className="flex items-center gap-2 min-w-0">
                    <Link to={`/stocks/${it.code}`} className="text-sm font-bold text-blue-700 hover:underline shrink-0">
                      {it.code}
                    </Link>
                    <span className="text-sm text-gray-600 truncate">{it.name}</span>
                    {it.kdj_cross_days != null && it.kdj_cross_days > 0 && (
                      <span className="text-[10px] text-gray-400 shrink-0">{it.kdj_cross_days}天前</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    <span className="text-xs text-gray-400 tabular-nums">K{it.kdj_k} D{it.kdj_d}</span>
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${SIGNAL_COLOR[it.kdj_signal] ?? "bg-gray-100 text-gray-600"}`}>
                      {it.kdj_signal}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!loading && !error && !result && (
        <p className="text-xs text-gray-400 text-center py-8">尚無快取資料，今日收盤後（15:30）將自動更新</p>
      )}
    </div>
  );
}

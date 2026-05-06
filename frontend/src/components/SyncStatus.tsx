import { useEffect, useRef, useState } from "react";
import { syncApi } from "../api/client";

interface Progress {
  running: boolean;
  current: string;
  processed: number;
  skipped: number;
  errors: number;
  total: number;
}

// 預設：7 天前
function defaultSince() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

export default function SyncStatus() {
  const [status, setStatus] = useState<{ synced_at?: string; processed?: number; warning?: string } | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [open, setOpen] = useState(false);
  const [since, setSince] = useState<string>(defaultSince());
  const [useSince, setUseSince] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = () => syncApi.status().then(setStatus).catch(console.error);
  const fetchProgress = () => syncApi.progress().then(setProgress).catch(console.error);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const startPolling = () => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const p = await syncApi.progress().catch(() => null);
      if (p) setProgress(p);
      if (p && !p.running) { stopPolling(); fetchStatus(); }
    }, 1500);
  };

  useEffect(() => {
    fetchStatus();
    fetchProgress();
    return stopPolling;
  }, []);

  // 點外面關閉 panel
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSync = async () => {
    await syncApi.trigger(useSince ? since : undefined);
    fetchProgress();
    startPolling();
    window.dispatchEvent(new Event("sync-started"));
    setOpen(true);
  };

  const handleStop = () => {
    syncApi.cancel();
    setOpen(false);
  };

  const isRunning = progress?.running;
  const warning = status?.warning as string | undefined;
  const done = progress ? progress.processed + progress.skipped + progress.errors : 0;
  const pct = progress && progress.total > 0 ? Math.round((done / progress.total) * 100) : 0;

  // 圓形進度圈參數
  const r = 9;
  const circ = 2 * Math.PI * r;
  const dash = circ * (pct / 100);

  return (
    <div ref={ref} className="relative">
      {/* ── 常駐觸發區 ── */}
      <button
        onClick={() => setOpen((v) => !v)}
        title={isRunning ? `同步中 ${pct}%` : "同步狀態"}
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-gray-100 transition text-xs text-gray-500"
      >
        {isRunning ? (
          /* 同步中：旋轉進度圈 + 百分比 */
          <>
            <svg width="20" height="20" viewBox="0 0 24 24" className="shrink-0">
              {/* 背景圓 */}
              <circle cx="12" cy="12" r={r} fill="none" stroke="#e5e7eb" strokeWidth="3" />
              {/* 進度弧 */}
              <circle
                cx="12" cy="12" r={r}
                fill="none" stroke="#3b82f6" strokeWidth="3"
                strokeDasharray={`${dash} ${circ}`}
                strokeLinecap="round"
                transform="rotate(-90 12 12)"
                className="transition-all duration-500"
              />
            </svg>
            <span className="text-blue-600 font-medium tabular-nums">{pct}%</span>
          </>
        ) : (
          /* 閒置：同步圖示 */
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        )}
      </button>

      {/* ── 展開 Panel ── */}
      {open && (
        <div className="absolute right-0 top-9 z-50 bg-white rounded-xl shadow-xl border border-gray-200 p-4 w-72 space-y-3">

          {/* 標題列 */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">Google Drive 同步</span>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
          </div>

          {/* 上次同步 */}
          {!isRunning && status?.synced_at && (
            <div className="text-xs text-gray-500 space-y-0.5">
              <div>上次同步：{String(status.synced_at).slice(0, 16).replace("T", " ")}</div>
              {typeof status.processed === "number" && status.processed > 0 && (
                <div className="text-green-600 font-medium">＋{status.processed} 筆新增</div>
              )}
            </div>
          )}

          {/* 同步中進度 */}
          {isRunning && progress && (
            <div className="space-y-2">
              {/* 文字進度 */}
              <div className="text-xs text-blue-600 truncate">
                {progress.total > 0
                  ? `${done} / ${progress.total} 個檔案`
                  : "掃描中…"}
              </div>
              {progress.current && (
                <div className="text-xs text-gray-400 truncate">· {progress.current}</div>
              )}
              {/* 進度條 */}
              {progress.total > 0 && (
                <>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>✓ {progress.processed} 新增　↷ {progress.skipped} 跳過　✗ {progress.errors} 失敗</span>
                    <span>{pct}%</span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* 警告 */}
          {warning && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              ⚠️ {warning}
            </div>
          )}

          {/* 日期篩選 */}
          {!isRunning && (
            <div className="space-y-1.5 pt-1 border-t border-gray-100">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={useSince}
                  onChange={(e) => setUseSince(e.target.checked)}
                  className="rounded"
                />
                <span className="text-xs text-gray-600">只同步此日期後的新檔案</span>
              </label>
              {useSince && (
                <input
                  type="date"
                  value={since}
                  onChange={(e) => setSince(e.target.value)}
                  className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              )}
              {!useSince && (
                <p className="text-xs text-amber-600">⚠️ 將掃描全部檔案，速度較慢</p>
              )}
            </div>
          )}

          {/* 操作按鈕 */}
          <div className="flex gap-2 pt-1">
            {isRunning ? (
              <button
                onClick={handleStop}
                className="flex-1 px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 transition"
              >
                停止同步
              </button>
            ) : (
              <button
                onClick={handleSync}
                className="flex-1 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition"
              >
                立即同步
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

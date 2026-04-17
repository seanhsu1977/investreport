import { useEffect, useRef } from "react";
import { syncApi } from "../api/client";

/**
 * 同步進行中時每 intervalMs 毫秒自動呼叫 callback 一次
 * 同步結束後停止輪詢
 */
export function useAutoRefresh(callback: () => void, intervalMs = 10000) {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const start = () => {
    stop();
    timerRef.current = setInterval(async () => {
      callback();
      // 確認同步是否結束，結束後停止
      const progress = await syncApi.progress().catch(() => ({ running: false }));
      if (!progress.running) stop();
    }, intervalMs);
  };

  useEffect(() => {
    // 頁面載入時先確認是否正在同步，是的話立刻開始輪詢
    syncApi.progress().then((p) => {
      if (p.running) start();
    }).catch(() => {});

    // 監聽「同步開始」事件
    const onSyncStart = () => start();
    window.addEventListener("sync-started", onSyncStart);

    return () => {
      stop();
      window.removeEventListener("sync-started", onSyncStart);
    };
  }, []);

  return { start, stop };
}

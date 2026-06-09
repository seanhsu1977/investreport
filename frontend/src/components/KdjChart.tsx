import { useEffect, useRef } from "react";
import { createChart, LineSeries } from "lightweight-charts";
import type { ITimeScaleApi, UTCTimestamp } from "lightweight-charts";

interface KdjPoint { time: number; value?: number }
type LcPoint = { time: UTCTimestamp; value?: number }

interface Props {
  kdj_k: KdjPoint[];
  kdj_d: KdjPoint[];
  kdj_j: KdjPoint[];
  onTimeScaleReady?: (ts: ITimeScaleApi<UTCTimestamp>) => void;
}

// KDJ oscillator chart (0–100 range, K/D/J lines, 20/80 reference)
export default function KdjChart({ kdj_k, kdj_d, kdj_j, onTimeScaleReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !kdj_k.length) return;
    const toLC = (pts: KdjPoint[]): LcPoint[] =>
      pts.map(p => ({ time: p.time as UTCTimestamp, value: p.value }));

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 180,
      layout: { background: { color: "#122548" }, textColor: "#94A3B8" },
      grid:   { vertLines: { color: "#1e3a5f" }, horzLines: { color: "#1e3a5f" } },
      rightPriceScale: { borderColor: "#1e3a5f", scaleMargins: { top: 0.05, bottom: 0.05 } },
      timeScale: {
        borderColor: "#1e3a5f",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: number) => {
          const d = new Date(time * 1000);
          return `${d.getMonth() + 1}/${d.getDate()}`;
        },
      },
      crosshair: { mode: 1 },
      handleScroll: true,
      handleScale:  true,
    });

    // K line – blue
    const kSeries = chart.addSeries(LineSeries, { color: "#3B82F6", lineWidth: 2, title: "K" });
    kSeries.setData(toLC(kdj_k));

    // D line – orange
    const dSeries = chart.addSeries(LineSeries, { color: "#F59E0B", lineWidth: 2, title: "D" });
    dSeries.setData(toLC(kdj_d));

    // J line – purple (thin, lighter)
    const jSeries = chart.addSeries(LineSeries, { color: "#A78BFA", lineWidth: 1, title: "J" });
    jSeries.setData(toLC(kdj_j));

    // Reference lines at 10 / 20 / 80 / 90
    const lastTime  = kdj_k[kdj_k.length - 1].time as UTCTimestamp;
    const firstTime = kdj_k[0].time as UTCTimestamp;
    const refLines: [number, string, number][] = [
      [10, "#86EFAC", 1],   // 極低撐：淺綠實線
      [20, "#22C55E", 2],   // 低撐：綠虛線
      [80, "#EF4444", 2],   // 高壓：紅虛線
      [90, "#FCA5A5", 1],   // 極高壓：淺紅實線
    ];
    for (const [level, color, lineStyle] of refLines) {
      const s = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle, title: "" });
      s.setData([{ time: firstTime, value: level }, { time: lastTime, value: level }]);
    }

    chart.timeScale().fitContent();
    onTimeScaleReady?.(chart.timeScale() as ITimeScaleApi<UTCTimestamp>);

    // Responsive resize
    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth });
    });
    ro.observe(el);

    return () => { ro.disconnect(); chart.remove(); };
  }, [kdj_k, kdj_d, kdj_j]);

  return <div ref={containerRef} className="w-full" style={{ height: 180 }} />;
}

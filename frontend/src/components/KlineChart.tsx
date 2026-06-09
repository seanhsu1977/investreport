import { useEffect, useRef } from "react";
import { createChart, CandlestickSeries, LineSeries, ColorType } from "lightweight-charts";
import type { ITimeScaleApi, UTCTimestamp } from "lightweight-charts";

interface Candle { time: number; open: number; high: number; low: number; close: number; }
interface MaPoint { time: number; value?: number; }

interface Props {
  candles: Candle[];
  ma5: MaPoint[];
  ma10: MaPoint[];
  ma20: MaPoint[];
  ma60: MaPoint[];
  onTimeScaleReady?: (ts: ITimeScaleApi<UTCTimestamp>) => void;
}

export default function KlineChart({ candles, ma5, ma10, ma20, ma60, onTimeScaleReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#122548" },
        textColor: "rgba(255,255,255,0.6)",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.05)" },
        horzLines: { color: "rgba(255,255,255,0.05)" },
      },
      crosshair: {
        vertLine: { color: "rgba(255,255,255,0.3)" },
        horzLine: { color: "rgba(255,255,255,0.3)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.1)",
        timeVisible: true,
        secondsVisible: false,
      },
      width: containerRef.current.clientWidth,
      height: 300,
    });

    // Candlestick series
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#E53935",
      downColor: "#1E8B4A",
      borderUpColor: "#E53935",
      borderDownColor: "#1E8B4A",
      wickUpColor: "#E53935",
      wickDownColor: "#1E8B4A",
    });
    candleSeries.setData(candles as any);

    // MA lines
    const maConfigs = [
      { data: ma5,  color: "#F59E0B", title: "MA5"  },
      { data: ma10, color: "#3B82F6", title: "MA10" },
      { data: ma20, color: "#A855F7", title: "MA20" },
      { data: ma60, color: "#10B981", title: "MA60" },
    ];
    for (const { data, color, title } of maConfigs) {
      if (data.length === 0) continue;
      const series = chart.addSeries(LineSeries, {
        color,
        lineWidth: 1,
        title,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      series.setData(data as any);
    }

    chart.timeScale().fitContent();
    onTimeScaleReady?.(chart.timeScale() as ITimeScaleApi<UTCTimestamp>);

    // Responsive resize
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [candles, ma5, ma10, ma20, ma60]);

  return <div ref={containerRef} className="w-full" style={{ height: 300 }} />;
}

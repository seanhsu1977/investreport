import { useEffect, useRef } from "react";
import { createChart, CandlestickSeries, LineSeries, HistogramSeries, ColorType } from "lightweight-charts";
import type { ITimeScaleApi, UTCTimestamp } from "lightweight-charts";

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
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

    // Volume histogram (bottom 20% of chart, separate scale)
    const hasVolume = candles.some(c => (c.volume ?? 0) > 0);
    if (hasVolume) {
      const volSeries = chart.addSeries(HistogramSeries, {
        priceScaleId: "volume",
        priceLineVisible: false,
        lastValueVisible: false,
      });
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.82, bottom: 0 },
        borderVisible: false,
      });
      volSeries.setData(
        candles.map((c, i) => ({
          time: c.time as UTCTimestamp,
          value: c.volume ?? 0,
          color: i > 0 && c.close >= candles[i - 1].close
            ? "rgba(229,57,53,0.45)"
            : "rgba(30,139,74,0.45)",
        }))
      );
    }

    // Candlestick series
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#E53935",
      downColor: "#1E8B4A",
      borderUpColor: "#E53935",
      borderDownColor: "#1E8B4A",
      wickUpColor: "#E53935",
      wickDownColor: "#1E8B4A",
      priceScaleId: "right",
    });
    chart.priceScale("right").applyOptions({
      scaleMargins: { top: 0.05, bottom: 0.22 },
    });
    candleSeries.setData(candles as any);

    // MA lines
    const maConfigs = [
      { data: ma5,  color: "#F59E0B" },
      { data: ma10, color: "#3B82F6" },
      { data: ma20, color: "#A855F7" },
      { data: ma60, color: "#10B981" },
    ];
    for (const { data, color } of maConfigs) {
      if (data.length === 0) continue;
      const series = chart.addSeries(LineSeries, {
        color, lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
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

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface Series {
  label: string;
  /** Unit shown on the axis; series sharing a unit share an axis. */
  unit: string;
  color: string;
  values: (number | null)[];
}

interface Props {
  /** Epoch seconds. */
  x: number[];
  series: Series[];
  height?: number;
}

/** uPlot line chart (CLAUDE.md stack); one y-axis per distinct unit, at most two shown. */
export function TimeSeriesChart({ x, series, height = 260 }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const signature = series.map((s) => `${s.label}|${s.unit}`).join(",");

  // (Re)create when the shape of the chart changes.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const units = [...new Set(series.map((s) => s.unit))];
    const axisColor = getComputedStyle(el).color;
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height,
      series: [
        {},
        ...series.map((s) => ({
          label: `${s.label} (${s.unit})`,
          stroke: s.color,
          width: 2,
          scale: s.unit,
          spanGaps: true,
        })),
      ],
      scales: { x: { time: true } },
      axes: [
        { stroke: axisColor, grid: { stroke: "rgba(128,128,128,0.15)" } },
        ...units.slice(0, 2).map((unit, i) => ({
          scale: unit,
          label: unit,
          side: i === 0 ? 3 : 1,
          stroke: axisColor,
          grid: { show: i === 0, stroke: "rgba(128,128,128,0.15)" },
        })),
      ],
      legend: { live: true },
    };
    const data = [x, ...series.map((s) => s.values)] as uPlot.AlignedData;
    const p = new uPlot(opts, data, el);
    plot.current = p;
    const resize = new ResizeObserver(() => p.setSize({ width: el.clientWidth, height }));
    resize.observe(el);
    return () => {
      resize.disconnect();
      p.destroy();
      plot.current = null;
    };
    // Data updates are handled below; only the series layout (signature) rebuilds the chart.
  }, [signature, height]);

  useEffect(() => {
    plot.current?.setData([x, ...series.map((s) => s.values)] as uPlot.AlignedData);
  }, [x, series]);

  return <div ref={container} className="chart" />;
}

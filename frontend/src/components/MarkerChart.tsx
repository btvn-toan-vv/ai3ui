/**
 * Top-markers bar chart, rendered **inside the chat transcript** as the
 * result of the agent's `run_deg` call.
 *
 * This is the point of the whole "AI-driven UI" idea taken one step further:
 * a tool result does not have to be a status line. The `render` of a frontend
 * tool can return arbitrary React, so the agent's answer arrives as a chart —
 * and the chart is a **control**, not a picture. Clicking a bar displays that
 * gene on the scatter, through the same `displayGenes` path the manual input
 * box uses. The chat stops being a transcript and becomes part of the app.
 *
 * Tree-shaken ECharts: only the bar chart, grid, and tooltip are registered,
 * not the ~1 MB umbrella build.
 */
import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { Marker } from "../lib/types";
import { EXPRESSION_RAMP, sampleRamp } from "../lib/colors";

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

export interface MarkerChartProps {
  markers: Marker[];
  group: string;
  /** Called with the gene symbol when a bar is clicked. */
  onSelectGene?: (gene: string) => void;
}

const BAR_COUNT = 10;

export function MarkerChart({ markers, group, onSelectGene }: MarkerChartProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  // Keep the latest callback without re-initialising the chart on every
  // parent render — the click handler is bound once.
  const onSelectRef = useRef(onSelectGene);
  onSelectRef.current = onSelectGene;

  const top = markers.slice(0, BAR_COUNT);

  useEffect(() => {
    if (!elRef.current || top.length === 0) return;

    const chart = echarts.init(elRef.current, undefined, { renderer: "canvas" });
    chartRef.current = chart;

    // ECharts wants ascending order for a horizontal bar chart, so the
    // strongest marker ends up at the top of the axis.
    const ordered = [...top].reverse();
    const maxScore = Math.max(...ordered.map((m) => m.score), 1);

    chart.setOption({
      animationDuration: 260,
      grid: { left: 4, right: 34, top: 4, bottom: 4, containLabel: true },
      tooltip: {
        trigger: "item",
        confine: true,
        formatter: (p: { dataIndex: number }) => {
          const m = ordered[p.dataIndex];
          return [
            `<strong>${m.gene}</strong>`,
            `score ${m.score.toFixed(2)}`,
            `log2FC ${m.log2fc.toFixed(2)}`,
            `FDR ${m.fdr.toExponential(2)}`,
            `${(m.pctIn * 100).toFixed(1)}% in / ${(m.pctOut * 100).toFixed(1)}% out`,
          ].join("<br/>");
        },
      },
      xAxis: {
        type: "value",
        axisLabel: { show: false },
        splitLine: { lineStyle: { color: "#eef2f5" } },
      },
      yAxis: {
        type: "category",
        data: ordered.map((m) => m.gene),
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { color: "#1b2733", fontSize: 11 },
      },
      series: [
        {
          type: "bar",
          data: ordered.map((m) => ({
            value: m.score,
            // Shade each bar by its own strength using the app's expression
            // ramp — the same colours the scatter uses, so a strong marker
            // looks "hot" in both places.
            itemStyle: {
              color: `rgb(${sampleRamp(EXPRESSION_RAMP, m.score / maxScore).join(",")})`,
              borderRadius: [0, 3, 3, 0],
            },
          })),
          barMaxWidth: 14,
          label: {
            show: true,
            position: "right",
            formatter: (p: { value: number }) => p.value.toFixed(1),
            fontSize: 10,
            color: "#52606d",
          },
          cursor: "pointer",
        },
      ],
    });

    chart.on("click", (params: { dataIndex?: number }) => {
      if (params.dataIndex === undefined) return;
      const m = ordered[params.dataIndex];
      if (m) onSelectRef.current?.(m.gene);
    });

    // The chat column resizes (window resize, transcript growth), and ECharts
    // does not track that on its own.
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(elRef.current);

    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
    // `top` is derived from markers; keying on the gene list avoids
    // re-initialising when an unrelated parent state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top.map((m) => m.gene).join(",")]);

  if (top.length === 0) return null;

  return (
    <figure className="marker-chart">
      <figcaption className="marker-chart-caption">
        Top {top.length} markers · {group}
        <span className="marker-chart-hint">click a bar to plot it</span>
      </figcaption>
      <div ref={elRef} className="marker-chart-canvas" />
    </figure>
  );
}

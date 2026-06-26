import { memo, useMemo, type HTMLAttributes } from "react";
import { VChart } from "@visactor/react-vchart";
import type { ISpec } from "@visactor/react-vchart";
import { useVChartThemeSpec } from "@/components/custom/charts/vchart-theme";
import { cn } from "@/lib/utils";

export type VChartSpec = ISpec;

const chartOptions = {
  mode: "desktop-browser" as const,
};

export interface VChartViewProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  spec: VChartSpec;
  height?: number | string;
}

export const VChartView = memo(function VChartView({
  spec,
  height = "100%",
  className,
  style,
  ...props
}: VChartViewProps) {
  const resolvedHeight = typeof height === "number" ? `${height}px` : height;
  const appTheme = useVChartThemeSpec();
  const themedSpec = useMemo<VChartSpec>(
    () => ({
      ...spec,
      background: spec.background ?? "transparent",
      theme: spec.theme ?? (appTheme as VChartSpec["theme"]),
    }),
    [appTheme, spec],
  );

  return (
    <div
      className={cn("min-h-0 w-full overflow-hidden", className)}
      style={{ height: resolvedHeight, ...style }}
      {...props}
    >
      <VChart spec={themedSpec} options={chartOptions} />
    </div>
  );
});

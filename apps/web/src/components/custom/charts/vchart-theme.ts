import { useMemo } from "react";
import type { ITheme } from "@visactor/react-vchart";

export interface VChartThemeTokens {
  /** Chart canvas background */
  chartBackground: string;
  /** Primary text */
  primaryText: string;
  /** Secondary text */
  secondaryText: string;
  /** Axis label / secondary text */
  axisLabel: string;
  /** Tertiary text — small captions, legend hints */
  axisSubLabel: string;
  /** Grid lines */
  grid: string;
  /** Axis domain / tick lines */
  axisLine: string;
  /** Tooltip card background */
  tooltipBg: string;
  /** Tooltip card text */
  tooltipText: string;
  /** Tooltip card border */
  tooltipBorder: string;
  /** Hovered legend / component background */
  hoverBg: string;
  /** Popup shadow */
  shadow: string;
}

// AnySentry is dark-only — a single token set, no light-mode toggle.
const DARK_TOKENS: VChartThemeTokens = {
  chartBackground: "transparent",
  primaryText: "#f8fafc",
  secondaryText: "#cbd5e1",
  axisLabel: "#94a3b8",
  axisSubLabel: "#64748b",
  grid: "#1e293b",
  axisLine: "#334155",
  tooltipBg: "#111827",
  tooltipText: "#f8fafc",
  tooltipBorder: "#334155",
  hoverBg: "rgba(148,163,184,0.14)",
  shadow: "rgba(0,0,0,0.36)",
};

function palette(tokens: VChartThemeTokens) {
  return {
    backgroundColor: tokens.chartBackground,
    borderColor: tokens.tooltipBorder,
    shadowColor: tokens.shadow,
    hoverBackgroundColor: tokens.hoverBg,
    sliderRailColor: tokens.grid,
    sliderHandleColor: tokens.chartBackground,
    sliderTrackColor: "#2dd4bf",
    popupBackgroundColor: tokens.tooltipBg,
    primaryFontColor: tokens.primaryText,
    secondaryFontColor: tokens.secondaryText,
    tertiaryFontColor: tokens.axisSubLabel,
    axisLabelFontColor: tokens.axisLabel,
    disableFontColor: tokens.axisSubLabel,
    axisMarkerFontColor: tokens.tooltipText,
    axisGridColor: tokens.grid,
    axisDomainColor: tokens.axisLine,
    dataZoomHandleStrokeColor: tokens.axisLabel,
    dataZoomChartColor: tokens.grid,
    scrollBarSliderColor: tokens.axisLabel,
    axisMarkerBackgroundColor: tokens.tooltipBg,
    markLabelBackgroundColor: tokens.hoverBg,
    markLineStrokeColor: tokens.axisLabel,
    discreteLegendPagerTextColor: tokens.secondaryText,
    discreteLegendPagerHandlerColor: tokens.secondaryText,
    discreteLegendPagerHandlerDisableColor: tokens.axisSubLabel,
    emptyCircleColor: tokens.axisLine,
    linearProgressTrackColor: tokens.grid,
  };
}

function textStyle(fill: string, fontSize = 12) {
  return {
    fill,
    fontSize,
    fontWeight: "normal" as const,
    fillOpacity: 1,
  };
}

function tooltipTextStyle(fontColor: string, fontWeight: "normal" | "bold" = "normal") {
  return {
    fontColor,
    fontWeight,
  };
}

function buildVChartTheme(tokens: VChartThemeTokens): Partial<ITheme> {
  return {
    background: tokens.chartBackground,
    colorScheme: {
      default: {
        palette: palette(tokens),
      },
    },
    component: {
      axis: {
        domainLine: { style: { stroke: tokens.axisLine } },
        grid: { style: { stroke: tokens.grid } },
        tick: { style: { stroke: tokens.axisLine } },
        subTick: { style: { stroke: tokens.axisLine } },
        label: { style: textStyle(tokens.axisLabel) },
        title: { style: textStyle(tokens.secondaryText) },
      },
      axisX: {
        label: { style: textStyle(tokens.axisLabel) },
        unit: { style: textStyle(tokens.axisLabel) },
      },
      axisY: {
        label: { style: textStyle(tokens.axisLabel) },
        unit: { style: textStyle(tokens.axisLabel) },
      },
      discreteLegend: {
        item: {
          background: {
            state: {
              selectedHover: { fill: tokens.hoverBg },
              unSelectedHover: { fill: tokens.hoverBg },
            },
          },
          label: {
            style: textStyle(tokens.axisLabel),
            state: {
              unSelected: { fill: tokens.axisSubLabel },
            },
          },
        },
        pager: {
          textStyle: { fill: tokens.secondaryText },
          handler: {
            style: { fill: tokens.secondaryText },
            state: { disable: { fill: tokens.axisSubLabel } },
          },
        },
      },
      tooltip: {
        panel: {
          backgroundColor: tokens.tooltipBg,
          border: {
            color: tokens.tooltipBorder,
            width: 1,
            radius: 6,
          },
          shadow: {
            x: 0,
            y: 10,
            blur: 24,
            spread: 0,
            color: tokens.shadow,
          },
        },
        titleLabel: tooltipTextStyle(tokens.tooltipText, "bold"),
        keyLabel: tooltipTextStyle(tokens.secondaryText),
        valueLabel: tooltipTextStyle(tokens.tooltipText, "bold"),
      },
      crosshair: {
        xField: {
          line: { style: { stroke: tokens.axisLine } },
          label: {
            labelBackground: { style: { fill: tokens.tooltipBg, stroke: tokens.tooltipBorder } },
            style: { fill: tokens.tooltipText },
          },
        },
        yField: {
          line: { style: { stroke: tokens.axisLine } },
          label: {
            labelBackground: { style: { fill: tokens.tooltipBg, stroke: tokens.tooltipBorder } },
            style: { fill: tokens.tooltipText },
          },
        },
      },
      title: {
        textStyle: textStyle(tokens.primaryText, 14),
        subtextStyle: textStyle(tokens.secondaryText, 12),
      },
    },
  } as unknown as Partial<ITheme>;
}

/**
 * Returns chart-axis / grid / tooltip colors. AnySentry is dark-only, so this
 * is a constant — the hook shape is kept for a stable call site.
 */
export function useVChartTheme(): VChartThemeTokens {
  return DARK_TOKENS;
}

/** Full VChart theme fragment used by the shared renderer (dark-only). */
export function useVChartThemeSpec(): Partial<ITheme> {
  const tokens = useVChartTheme();
  return useMemo(() => buildVChartTheme(tokens), [tokens]);
}

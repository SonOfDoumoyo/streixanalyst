// The chart follows the app's light or dark mode. Each mode has its own palette. A chart background the user picked in
// Settings is kept while it suits the current mode; when it does not (a white chart in dark mode, say), the palette
// takes over, so light mode always gets a light chart and dark mode always gets a dark one.

// TradingView-style palettes. Keys match what the chart engine reads from its theme.
export const CHART_PALETTES = {
  dark: {
    bg: "#131722",
    grid: "rgba(42,46,57,0.85)",
    text: "#787b86",
    crosshair: "#758696",
    axisLine: "#2a2e39",
    label: "#2a3a5c",          // crosshair price and time tags
    ma20: "rgba(255,255,255,0.55)",
    ma50: "rgba(255,213,79,0.75)",
    ma200: "rgba(155,123,255,0.95)",
  },
  light: {
    bg: "#ffffff",
    grid: "rgba(42,46,57,0.08)",
    text: "#5d6676",
    crosshair: "#9598a1",
    axisLine: "#e0e3eb",
    label: "#2a2e39",
    ma20: "rgba(19,23,34,0.45)",
    ma50: "rgba(214,140,0,0.95)",
    ma200: "rgba(103,58,209,0.9)",
  },
};

// Relative brightness of a #rgb or #rrggbb colour (0 = black, 1 = white), or null when it is not a hex colour.
export function brightness(hex) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// Does a saved chart background suit this mode? A light background suits light mode and a dark one suits dark mode.
export function bgSuitsMode(bg, mode) {
  const b = brightness(bg);
  if (b === null) return false;
  return mode === "light" ? b >= 0.5 : b < 0.5;
}

// The full chart theme for the current app mode: palette + the user's candle colours (+ their background when it fits).
export function chartThemeFor(mode, chart = {}, candles = {}) {
  const isLight = mode === "light";
  const pal = isLight ? CHART_PALETTES.light : CHART_PALETTES.dark;
  const keepUser = bgSuitsMode(chart.background, isLight ? "light" : "dark");
  return {
    ...pal,
    bg: keepUser ? chart.background : pal.bg,
    grid: keepUser && chart.gridColor ? chart.gridColor : pal.grid,
    text: keepUser && chart.textColor ? chart.textColor : pal.text,
    crosshair: keepUser && chart.crosshair ? chart.crosshair : pal.crosshair,
    up: candles.up,
    down: candles.down,
    wickUp: candles.wickUp,
    wickDown: candles.wickDown,
    borderUp: candles.borderUp,
    borderDown: candles.borderDown,
  };
}

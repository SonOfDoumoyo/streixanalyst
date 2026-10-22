// Chart and app preferences. Saved to the account (PATCH /auth/me) and cached in this browser.

export const DEFAULT_SETTINGS = {
  theme: "dark",
  candles: {
    style: "candles", // any id in components/chart/series.js CHART_TYPES
    up: "#12d9a0",
    down: "#ff3b5c",
    wickUp: "#12d9a0",
    wickDown: "#ff3b5c",
    borderUp: "#12d9a0",
    borderDown: "#ff3b5c",
  },
  chart: {
    skins: {},                 // per app mode: { dark: { bg, grid, text }, light: { ... } }, set from Settings
    background: "#000000",
    grid: false,
    gridColor: "rgba(42,46,57,0.85)",
    crosshair: "#758696",
    textColor: "#9a9fac",
    volume: true,
    logScale: false,
    rsi: false,
    watermark: true,
    killzones: false,          // shade the London and New York killzones (fixed New York clock windows)
    minCandle: 2,              // narrowest candle in px when pinching in (1-10, set in Settings)
  },
  indicators: { ema20: false, ema50: true, ema200: true, bb: false, vwap: false },
  analysis: { detail: 2, animate: true, account: 1000, risk_pct: 1, leverage: "", mode: "auto", showAlt: false, directionView: "range",
    showLevels: true,          // off: analysis only, no entry / stop / target anywhere
    targetMode: "liquidity",   // TP1 at the first liquidity level, or "winrate": where about 68% of similar setups got
    hud: true,                 // the reasons on the chart after Analyse
    fixedTime: false },        // the person also trades fixed time (shows the up/down card first)
  studies: [],               // indicators from the library: [{ key, id, params }] (components/chart/studies.js)
  intervalFavorites: ["5m", "15m", "1h", "4h"],
  toolFavorites: ["trendline", "hline", "rect", "fib", "long"],
  keepScreenOn: false,       // stop the phone dimming while the chart is open
  rememberChart: true,       // reopen the last market and timeframe
  layers: {},
  drawingDefaults: { color: "#2962ff", width: 2, dash: "solid" },
  chartFavorites: [],        // chart types starred with a long tap in the Chart type sheet
  chartTypeTipSeen: false,
  layouts: [],               // saved chart layouts (market, timeframe, chart type, indicators, panes, compared markets)
  currentLayout: null,
  indicatorTemplates: [],    // named sets of indicators
  lastSymbol: "BTCUSDT",
  lastTf: "1h",
  tourDone: false, // the first-visit tour; set to true when it is finished or skipped
};

export const CANDLE_PRESETS = [
  { name: "Vivid", up: "#12d9a0", down: "#ff3b5c" },
  { name: "Classic", up: "#26a69a", down: "#ef5350" },
  { name: "Streix", up: "#2fd3a6", down: "#ff5d7a" },
  { name: "Ocean", up: "#3b90fa", down: "#f5a524" },
  { name: "Mono", up: "#e8eef9", down: "#5b6b8c" },
  { name: "Neon", up: "#00e5a0", down: "#ff3366" },
  { name: "Colour-blind", up: "#1f77ff", down: "#ff9f1c" },
];

// Chart backgrounds to choose from, per app mode. The chart always matches the app's light or dark mode.
export const CHART_BACKGROUNDS = [
  { mode: "dark", name: "Black", bg: "#000000", grid: "rgba(255,255,255,0.05)", text: "#9a9fac" },
  { mode: "dark", name: "Carbon", bg: "#0b0b0c", grid: "rgba(255,255,255,0.05)", text: "#9aa3ad" },
  { mode: "dark", name: "Graphite", bg: "#131316", grid: "rgba(255,255,255,0.06)", text: "#9a9ea8" },
  { mode: "dark", name: "Charcoal", bg: "#171717", grid: "rgba(255,255,255,0.07)", text: "#a8a49a" },
  { mode: "light", name: "White", bg: "#ffffff", grid: "rgba(42,46,57,0.08)", text: "#5d6676" },
  { mode: "light", name: "Warm", bg: "#fbfaf7", grid: "rgba(60,50,30,0.08)", text: "#6b6557" },
  { mode: "light", name: "Cool", bg: "#f5f7fb", grid: "rgba(20,40,90,0.07)", text: "#5a6b8c" },
];

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export function mergeSettings(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(base[k]) ? mergeSettings(base[k], v) : v;
  }
  return out;
}

const KEY = "sa_settings_v1";

export function loadLocalSettings() {
  try {
    const raw = typeof window !== "undefined" && window.localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveLocalSettings(s) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

export function localGet(key, fallback = null) {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function localSet(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

// Chart and app preferences. Saved to the account (PATCH /auth/me) and cached in this browser.

export const DEFAULT_SETTINGS = {
  theme: "dark",
  candles: {
    style: "candles", // candles | hollow | bars | line | area | heikin
    up: "#089981",
    down: "#f23645",
    wickUp: "#089981",
    wickDown: "#f23645",
    borderUp: "#089981",
    borderDown: "#f23645",
  },
  chart: {
    background: "#131722",
    grid: false,
    gridColor: "rgba(42,46,57,0.85)",
    crosshair: "#758696",
    textColor: "#787b86",
    volume: true,
    logScale: false,
    rsi: false,
    watermark: true,
  },
  indicators: { ema20: false, ema50: true, ema200: true, bb: false, vwap: false },
  analysis: { detail: 1, animate: true, account: 1000, risk_pct: 1, leverage: "", mode: "auto", showAlt: false, directionView: "range" },
  layers: {},
  drawingDefaults: { color: "#e8a287", width: 2, dash: "solid" },
  lastSymbol: "BTCUSDT",
  lastTf: "1h",
  tourDone: false, // the first-visit tour; set to true when it is finished or skipped
};

export const CANDLE_PRESETS = [
  { name: "TradingView", up: "#089981", down: "#f23645" },
  { name: "Classic", up: "#26a69a", down: "#ef5350" },
  { name: "Streix", up: "#2fd3a6", down: "#ff5d7a" },
  { name: "Ocean", up: "#3b90fa", down: "#f5a524" },
  { name: "Mono", up: "#e8eef9", down: "#5b6b8c" },
  { name: "Neon", up: "#00e5a0", down: "#ff3366" },
  { name: "Colour-blind", up: "#1f77ff", down: "#ff9f1c" },
];

export const CHART_BACKGROUNDS = [
  { name: "TradingView", bg: "#131722", grid: "rgba(42,46,57,0.85)", text: "#787b86" },
  { name: "Black", bg: "#0a0a0a", grid: "rgba(255,255,255,0.06)", text: "#9a968c" },
  { name: "Carbon", bg: "#0e1013", grid: "rgba(255,255,255,0.05)", text: "#9aa3ad" },
  { name: "Charcoal", bg: "#171717", grid: "rgba(255,255,255,0.07)", text: "#a8a49a" },
  { name: "Paper", bg: "#ffffff", grid: "rgba(20,40,90,0.07)", text: "#5a6b8c" },
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

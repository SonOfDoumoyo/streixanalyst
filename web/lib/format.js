// Number, price and time formatting.

export function fmtPrice(x, dec = 2) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return "—";
  const v = Number(x);
  const d = Math.max(0, Math.min(10, dec | 0));
  return Math.abs(v) >= 1000
    ? v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
    : v.toFixed(d);
}

export function fmtPct(x, d = 0) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return "—";
  return `${(Number(x) * 100).toFixed(d)}%`;
}

export function fmtChange(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return "—";
  const v = Number(pct);
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function fmtMoney(x, cur = "$") {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return "—";
  const v = Number(x);
  return `${cur}${v.toLocaleString("en-US", { minimumFractionDigits: v < 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

export function fmtNaira(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return "—";
  return `₦${Number(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function fmtQty(x) {
  if (!Number.isFinite(Number(x)) || Number(x) === 0) return "0";
  const v = Number(x);
  const mag = Math.floor(Math.log10(Math.abs(v)));
  const d = mag < 3 ? Math.min(8, Math.max(0, 3 - mag)) : 0;
  return v.toLocaleString("en-US", { maximumFractionDigits: d });
}

export function fmtCompact(x) {
  if (!Number.isFinite(Number(x))) return "—";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(x));
}

export function timeAgo(iso) {
  if (!iso) return "";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function minutesHuman(m) {
  const v = Math.round(Number(m));
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  const txt = a < 60 ? `${a} min` : a < 1440 ? `${Math.floor(a / 60)} h ${a % 60} min` : `${Math.floor(a / 1440)} d ${Math.floor((a % 1440) / 60)} h`;
  return v >= 0 ? `in ${txt}` : `${txt} ago`;
}

export function fmtDate(iso, opts = { day: "numeric", month: "short", year: "numeric" }) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, opts);
}

export function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export const TFS = ["1m", "5m", "15m", "30m", "1h", "4h", "1D", "3D", "1W", "1M"];
export const TF_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1D": 86400, "3D": 259200, "1W": 604800, "1M": 2629800 };
export const TF_LABEL = { "1m": "1 minute", "5m": "5 minutes", "15m": "15 minutes", "30m": "30 minutes", "1h": "1 hour", "4h": "4 hours", "1D": "1 day", "3D": "3 days", "1W": "1 week", "1M": "1 month",
  "2m": "2 minutes", "3m": "3 minutes", "10m": "10 minutes", "45m": "45 minutes", "2h": "2 hours", "3h": "3 hours", "6h": "6 hours", "8h": "8 hours", "12h": "12 hours" };
// chart-only intervals (the server builds them from a standard one); the analyst works on the standard ones
export const CUSTOM_TFS = ["2m", "3m", "10m", "45m", "2h", "3h", "6h", "8h", "12h"];
export const ALL_TFS = [...TFS, ...CUSTOM_TFS];
export const INTERVAL_GROUPS = [
  ["Minutes", ["1m", "2m", "3m", "5m", "10m", "15m", "30m", "45m"]],
  ["Hours", ["1h", "2h", "3h", "4h", "6h", "8h", "12h"]],
  ["Days and longer", ["1D", "3D", "1W", "1M"]],
];
// the standard timeframe the analyst uses for a chart-only interval: the next standard one up
export const ANALYSIS_TF = { "2m": "5m", "3m": "5m", "10m": "15m", "45m": "1h", "2h": "4h", "3h": "4h", "6h": "1D", "8h": "1D", "12h": "1D" };
export const analysisTf = (tf) => (TFS.includes(tf) ? tf : ANALYSIS_TF[tf] || "1h");

export function greeting(name) {
  const h = new Date().getHours();
  const part = h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : part;
}

export function initials(name) {
  return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join("");
}

const PALETTE = ["#f7931a", "#627eea", "#14f195", "#f3ba2f", "#e84142", "#2a5ada", "#c2a633", "#8247e5", "#ff007a", "#00d1ff"];
export function symbolColor(sym) {
  let h = 0;
  for (const ch of String(sym)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function cleanSymbol(s) {
  return String(s || "").trim().toUpperCase();
}

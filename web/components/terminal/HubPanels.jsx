"use client";
// The analysis hub (TradingView's mobile "Analysis hub" sheet) and the panels it opens: chart layout, saved layouts,
// indicators and templates, compare, object tree, symbol details, technicals and trading at a broker.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Icon from "@/components/Icons";
import { get, qs } from "@/lib/api";
import { fmtPrice } from "@/lib/format";
import { technicals } from "@/lib/technicals";
import { CHART_TYPES } from "@/components/chart/series";
import { TOOLS } from "@/components/chart/engine";
import Sheet from "./Sheet";
import { ChartTypeIcon } from "./ChartTypeSheet";

const H = {
  layout: <rect x="4" y="5" width="16" height="14" rx="2" />,
  manage: <><path d="M4 17V6a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v4" /><path d="M7 13l3-3 3 2 3-4" /><circle cx="17.5" cy="17.5" r="2.5" /><path d="M17.5 13.5v1M17.5 20.5v1M13.5 17.5h1M20.5 17.5h1" /></>,
  settings: <><path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" /><circle cx="12" cy="12" r="3" /></>,
  newl: <><path d="M4 17V6a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v5" /><path d="M7 13l3-3 3 2 3-4" /><path d="M18 15v6M15 18h6" /></>,
  save: <><path d="M7 18a4 4 0 0 1-.7-7.9A6 6 0 0 1 18 9a4.5 4.5 0 0 1 0 9" /><path d="M12 13v8M9 16l3-3 3 3" /></>,
  open: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  broker: <><path d="M3 12l4-4 4 3 4-4 6 5" /><path d="M3 17l4-4 4 3 4-4 6 5" /></>,
  indicators: <><path d="M4 20V14M9 20V10M14 20v-6M19 20V8" /><path d="M4 9l5-4 5 3 5-4" /></>,
  compare: <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v8M8 12h8" /></>,
  alerts: <><circle cx="12" cy="13" r="7" /><path d="M12 9.5V13l2.5 1.5M4 5l3-2M20 5l-3-2" /></>,
  replay: <><path d="M11 7l-6 5 6 5zM19 7l-6 5 6 5z" /></>,
  templates: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>,
  objects: <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  details: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v6M12 7.5v.5" /></>,
  financials: <><path d="M5 20V12M10 20V7M15 20v-9M20 20V4" /></>,
  forecast: <><path d="M4 16l5-5 3 3 6-6" /><path d="M14 8h4v4" /><path d="M18 14v6" strokeDasharray="1.5 2" /></>,
  technicals: <><path d="M4 16a8 8 0 0 1 16 0" /><path d="M12 16l4-5" /><circle cx="12" cy="16" r="1.4" /></>,
  publish: <><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z" /><path d="M12 7v5M9.5 9.5h5" /></>,
  pine: <><path d="M4 20l4-1 11-11-3-3L5 16z" /><path d="M14 6l3 3" /></>,
};
const HubIcon = ({ id }) => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{H[id]}</svg>
);

function Tile({ icon, label, onClick, href, disabled, note, wide }) {
  const body = (<><HubIcon id={icon} /><span>{label}</span></>);
  if (href && !disabled) return <Link className={`hub-tile ${wide ? "wide" : ""}`} href={href}>{body}</Link>;
  return (
    <button className={`hub-tile ${wide ? "wide" : ""} ${disabled ? "off" : ""}`} onClick={onClick} title={note || label} aria-disabled={disabled || undefined}>
      {body}
    </button>
  );
}

/** The hub itself. `go(panel)` opens one of the panels below; `act` holds the direct actions. */
export function AnalysisHub({ open, onClose, go, act, symbol, tf }) {
  const noFin = "Financial statements are only published for company shares, and this app's feeds do not carry them.";
  return (
    <Sheet open={open} onClose={onClose} title="Analysis hub">
      <div className="hub-row3">
        <Tile icon="layout" label="Layout setup" onClick={() => go("layout")} />
        <Tile icon="manage" label="Manage layouts" onClick={() => go("layouts")} />
        <Tile icon="settings" label="Chart settings" href="/settings#chart" />
        <Tile icon="newl" label="New" onClick={act.newLayout} />
        <Tile icon="save" label="Save" onClick={act.saveLayout} />
        <Tile icon="open" label="Open" onClick={() => go("layouts")} />
      </div>
      <button className="hub-broker" onClick={() => go("broker")}>
        <HubIcon id="broker" />
        <span>Trade with your broker</span>
      </button>
      <div className="sheet-sec">Tools</div>
      <div className="hub-grid">
        <Tile icon="indicators" label="Indicators" onClick={() => go("indicators")} />
        <Tile icon="compare" label="Compare" onClick={() => go("compare")} />
        <Tile icon="alerts" label="Alerts" onClick={act.alerts} />
        <Tile icon="replay" label="Bar Replay" onClick={act.replay} />
      </div>
      <div className="hub-row3">
        <Tile icon="templates" label="Indicator templates" onClick={() => go("templates")} />
        <button className="hub-tile" onClick={() => go("types")}><ChartTypeIcon id="candles" size={24} /><span>Chart type</span></button>
        <Tile icon="objects" label="Object Tree" onClick={() => go("objects")} />
      </div>
      <div className="sheet-sec">Info</div>
      <div className="hub-grid">
        <Tile icon="details" label="Symbol details" onClick={() => go("details")} />
        <Tile icon="financials" label="Financials" disabled note={noFin} onClick={() => act.note(noFin)} />
        <Tile icon="forecast" label="Forecast" disabled note="Analyst forecasts are for company shares; the feeds this app uses do not carry them."
          onClick={() => act.note("Analyst forecasts are for company shares; the feeds this app uses do not carry them.")} />
        <Tile icon="technicals" label="Technicals" onClick={() => go("technicals")} />
      </div>
      <div className="sheet-sec">More</div>
      <div className="hub-grid">
        <Tile icon="publish" label="Publish idea" onClick={act.publish} />
        <Tile icon="pine" label="Strategy lab" href={`/strategy?s=${encodeURIComponent(symbol)}&tf=${tf}`} />
      </div>
      <Link className="hub-help" href="/support"><Icon name="info" size={18} /> Help Center</Link>
    </Sheet>
  );
}

const Toggle = ({ on, label, sub, onClick }) => (
  <button className="hub-toggle" onClick={onClick} role="switch" aria-checked={!!on}>
    <span className="grow"><b>{label}</b>{sub ? <small>{sub}</small> : null}</span>
    <i className={`switch ${on ? "on" : ""}`} />
  </button>
);

export function LayoutPanel({ open, onClose, onBack, settings, update, panelHidden, setPanelHidden, narrow }) {
  const c = settings.chart;
  const flip = (k) => update({ chart: { [k]: !c[k] } });
  return (
    <Sheet open={open} onClose={onClose} onBack={onBack} title="Layout setup">
      <Toggle on={c.volume} label="Volume" sub="Volume bars under the candles" onClick={() => flip("volume")} />
      <Toggle on={c.rsi} label="RSI pane" sub="RSI 14 in its own pane" onClick={() => flip("rsi")} />
      <Toggle on={c.logScale} label="Log scale" sub="Equal percentage moves look equal" onClick={() => flip("logScale")} />
      <Toggle on={c.grid} label="Grid" onClick={() => flip("grid")} />
      <Toggle on={c.killzones} label="Killzones" sub="London 02:00–05:00 and New York 07:00–10:00, New York time" onClick={() => flip("killzones")} />
      <Toggle on={c.watermark} label="Watermark" sub="The market's name behind the candles" onClick={() => flip("watermark")} />
      {!narrow ? <Toggle on={!panelHidden} label="Side panel" sub="Analysis, replay, StreixAI and the rest" onClick={() => setPanelHidden(!panelHidden)} /> : null}
      <label className="hub-range">
        <span><b>Narrowest candle</b><small>Pinching in stops at {c.minCandle || 2}px</small></span>
        <input type="range" min="1" max="10" step="1" value={c.minCandle || 2} onChange={(e) => update({ chart: { minCandle: Number(e.target.value) } })} />
      </label>
    </Sheet>
  );
}

export function LayoutsPanel({ open, onClose, onBack, layouts, current, onOpen, onDelete, onSaveAs, onRename }) {
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState(null);
  useEffect(() => { if (open) setName(`Layout ${layouts.length + 1}`); }, [open, layouts.length]);
  return (
    <Sheet open={open} onClose={onClose} onBack={onBack} title="Chart layouts">
      <form className="hub-save" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSaveAs(name.trim()); }}>
        <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="Layout name" />
        <button className="btn primary sm">Save current</button>
      </form>
      <p className="faint hub-note">A layout keeps the market, timeframe, chart type, indicators, panes and compared markets. Drawings stay with each market.</p>
      {!layouts.length ? <div className="hub-empty">No saved layouts yet.</div> : null}
      <div className="hub-list">
        {layouts.map((l) => (
          <div key={l.id} className={`hub-item ${current === l.id ? "on" : ""}`}>
            {renaming === l.id ? (
              <form className="grow row" onSubmit={(e) => { e.preventDefault(); const v = e.target.elements.n.value.trim(); if (v) onRename(l.id, v); setRenaming(null); }}>
                <input name="n" className="input" defaultValue={l.name} maxLength={40} autoFocus />
                <button className="btn sm">OK</button>
              </form>
            ) : (
              <button className="grow hub-item-main" onClick={() => onOpen(l)}>
                <b>{l.name}{current === l.id ? " · open" : ""}</b>
                <small>{l.symbol} · {l.tf} · {(CHART_TYPES.find((t) => t.id === l.style) || {}).label || "Candles"}</small>
              </button>
            )}
            <button className="icon-btn" onClick={() => setRenaming(l.id)} aria-label={`Rename ${l.name}`}><Icon name="pen" size={16} /></button>
            <button className="icon-btn" onClick={() => onDelete(l.id)} aria-label={`Delete ${l.name}`}><Icon name="trash" size={16} /></button>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

const INDICATORS = [["ema20", "EMA 20"], ["ema50", "EMA 50"], ["ema200", "EMA 200"], ["bb", "Bollinger Bands (20, 2)"], ["vwap", "VWAP (intraday)"]];

export function IndicatorsPanel({ open, onClose, onBack, settings, update, templatesOnly = false, templates, onSaveTemplate, onApplyTemplate, onDeleteTemplate }) {
  const [name, setName] = useState("");
  return (
    <Sheet open={open} onClose={onClose} onBack={onBack} title={templatesOnly ? "Indicator templates" : "Indicators"}>
      {!templatesOnly ? (
        <>
          {INDICATORS.map(([k, l]) => (
            <Toggle key={k} on={settings.indicators[k]} label={l} onClick={() => update({ indicators: { [k]: !settings.indicators[k] } })} />
          ))}
          <Toggle on={settings.chart.rsi} label="RSI 14" sub="In its own pane" onClick={() => update({ chart: { rsi: !settings.chart.rsi } })} />
          <div className="sheet-sec">Templates</div>
        </>
      ) : null}
      <form className="hub-save" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onSaveTemplate(name.trim()); setName(""); } }}>
        <input className="input" value={name} maxLength={30} placeholder="Name this set, e.g. Trend" onChange={(e) => setName(e.target.value)} aria-label="Template name" />
        <button className="btn sm">Save set</button>
      </form>
      {!templates.length ? <div className="hub-empty">Save the indicators you use together, then switch to them in one tap.</div> : null}
      <div className="hub-list">
        {templates.map((t) => (
          <div key={t.name} className="hub-item">
            <button className="grow hub-item-main" onClick={() => onApplyTemplate(t)}>
              <b>{t.name}</b>
              <small>{[...INDICATORS.filter(([k]) => t.indicators[k]).map(([, l]) => l), t.rsi ? "RSI 14" : null].filter(Boolean).join(", ") || "No indicators"}</small>
            </button>
            <button className="icon-btn" onClick={() => onDeleteTemplate(t.name)} aria-label={`Delete ${t.name}`}><Icon name="trash" size={16} /></button>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

export function ComparePanel({ open, onClose, onBack, compare, onAdd, onRemove, symbol }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState([]);
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => {
      get(`/market/search?${qs({ q, limit: 12 })}`).then((d) => setRes(d.results || [])).catch(() => setRes([]));
    }, 220);
    return () => clearTimeout(t);
  }, [q, open]);
  return (
    <Sheet open={open} onClose={onClose} onBack={onBack} title="Compare symbol">
      <p className="faint hub-note">Draws another market over {symbol}, starting from the same point at the left of the screen, so you can see which moved more.</p>
      {compare.length ? (
        <div className="hub-list">
          {compare.map((c) => (
            <div key={c.symbol} className="hub-item">
              <i className="hub-swatch" style={{ background: c.color }} />
              <b className="grow">{c.symbol}{c.error ? <small className="down"> · {c.error}</small> : null}</b>
              <button className="icon-btn" onClick={() => onRemove(c.symbol)} aria-label={`Remove ${c.symbol}`}><Icon name="x" size={16} /></button>
            </div>
          ))}
        </div>
      ) : null}
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search, e.g. ETHUSDT, XAUUSD, NAS100" autoFocus />
      <div className="hub-list">
        {res.map((r) => (
          <button key={r.symbol} className="hub-item hub-item-main" onClick={() => onAdd(r.chart_symbol || r.symbol)} disabled={compare.length >= 4}>
            <b>{r.symbol}</b>
            <small>{r.name || r.cls || ""}</small>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

const TOOL_LABEL = (t) => (TOOLS[t] && TOOLS[t].label) || t;

export function ObjectTreePanel({ open, onClose, onBack, drawings, decimals, onSelect, onToggle, onDelete, onLock, hasAnalysis, analysisOn, onAnalysis }) {
  return (
    <Sheet open={open} onClose={onClose} onBack={onBack} title="Object tree">
      {hasAnalysis ? (
        <Toggle on={analysisOn} label="StreixAnalyst analysis" sub="The structure, levels and plan drawn by Analyse" onClick={onAnalysis} />
      ) : null}
      {!drawings.length ? <div className="hub-empty">Nothing drawn on this chart yet. Use the pen to draw lines, zones and trades.</div> : null}
      <div className="hub-list">
        {drawings.map((d) => (
          <div key={d.id} className="hub-item">
            <i className="hub-swatch" style={{ background: (d.style && d.style.color) || "#2962ff" }} />
            <button className="grow hub-item-main" onClick={() => onSelect(d.id)}>
              <b>{d.type === "text" && d.style && d.style.text ? `“${d.style.text}”` : TOOL_LABEL(d.type)}</b>
              <small>{(d.points || []).slice(0, 2).map((p) => fmtPrice(p.p, decimals)).join(" → ")}</small>
            </button>
            <button className="icon-btn" onClick={() => onLock(d.id, !d.locked)} aria-label={d.locked ? "Unlock" : "Lock"}><Icon name={d.locked ? "lock" : "unlock"} size={16} /></button>
            <button className="icon-btn" onClick={() => onToggle(d.id, !d.hidden)} aria-label={d.hidden ? "Show" : "Hide"}><Icon name={d.hidden ? "eyeOff" : "eye"} size={16} /></button>
            <button className="icon-btn" onClick={() => onDelete(d.id)} aria-label="Delete"><Icon name="trash" size={16} /></button>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

export function SymbolDetailsPanel({ open, onClose, onBack, meta, symbol, tf }) {
  const [q, setQ] = useState(null);
  useEffect(() => {
    if (!open) return;
    get(`/market/quotes?${qs({ symbols: symbol })}`).then((d) => setQ((d.quotes || [])[0] || null)).catch(() => setQ(null));
  }, [open, symbol]);
  const rows = meta ? [
    ["Market", meta.display],
    ["Ticker", meta.symbol],
    ["Kind", { crypto: "Crypto", forex: "Forex", metal: "Metal", index: "Index", stock: "Stock", commodity: "Commodity" }[meta.asset_class] || meta.asset_class],
    ["Base / quote", meta.base && meta.quote ? `${meta.base} / ${meta.quote}` : null],
    ["Contract", meta.perp ? "Perpetual futures" : meta.asset_class === "crypto" ? "Spot" : null],
    ["Data from", meta.source],
    ["Price", fmtPrice(meta.price, meta.decimals)],
    ["Change today", q && q.change !== null && q.change !== undefined ? `${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)}%` : null],
    ["Price decimals", String(meta.decimals)],
    ["Timeframe", tf],
    ["Last closed candle", meta.age_minutes !== null && meta.age_minutes !== undefined ? `${meta.age_minutes} minutes ago` : null],
  ].filter((r) => r[1]) : [];
  return (
    <Sheet open={open} onClose={onClose} onBack={onBack} title="Symbol details">
      {!meta ? <div className="hub-empty">The chart is still loading.</div> : (
        <dl className="hub-dl">
          {rows.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd className="num">{v}</dd></div>))}
        </dl>
      )}
    </Sheet>
  );
}

const TONE = { "Strong buy": "up", Buy: "up", Neutral: "", Sell: "down", "Strong sell": "down" };

function Gauge({ label, g }) {
  const angle = (g.score || 0) * 80;
  return (
    <div className="tech-gauge">
      <svg viewBox="0 0 120 70" width="150" height="88" aria-hidden="true">
        <path d="M10 62a50 50 0 0 1 100 0" fill="none" stroke="var(--line-2)" strokeWidth="8" strokeLinecap="round" />
        <path d="M10 62a50 50 0 0 1 30-46" fill="none" stroke="var(--down)" strokeWidth="8" strokeLinecap="round" opacity="0.8" />
        <path d="M80 16a50 50 0 0 1 30 46" fill="none" stroke="var(--up)" strokeWidth="8" strokeLinecap="round" opacity="0.8" />
        <g transform={`rotate(${angle} 60 62)`}><path d="M60 62L60 20" stroke="var(--text)" strokeWidth="3" strokeLinecap="round" /></g>
        <circle cx="60" cy="62" r="4.5" fill="var(--text)" />
      </svg>
      <small>{label}</small>
      <b className={TONE[g.rating]}>{g.rating}</b>
      <span className="faint">Sell {g.sell} · Neutral {g.neutral} · Buy {g.buy}</span>
    </div>
  );
}

export function TechnicalsPanel({ open, onClose, onBack, candles, symbol, tf, decimals }) {
  const t = useMemo(() => (open ? technicals(candles) : null), [open, candles]);
  return (
    <Sheet open={open} onClose={onClose} onBack={onBack} title={`Technicals · ${symbol} · ${tf}`} wide>
      {!t ? <div className="hub-empty">Not enough candles yet.</div> : (
        <>
          <div className="tech-top">
            <Gauge label="Oscillators" g={t.osc} />
            <Gauge label="Summary" g={t.summary} />
            <Gauge label="Moving averages" g={t.ma} />
          </div>
          <p className="faint hub-note">Votes from the chart&apos;s closed and forming candles on this timeframe. A summary of common readings, not a trade call: the Analyse button gives the full plan.</p>
          {[["Oscillators", t.osc.rows], ["Moving averages", t.ma.rows]].map(([title, rows]) => (
            <div key={title}>
              <div className="sheet-sec">{title}</div>
              <table className="tech-table">
                <thead><tr><th>Name</th><th>Value</th><th>Action</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.name}><td>{r.name}</td><td className="num">{Math.abs(r.value) >= 100 ? fmtPrice(r.value, Math.min(decimals, 2)) : r.value.toFixed(2)}</td>
                      <td className={r.action === "Buy" ? "up" : r.action === "Sell" ? "down" : "faint"}>{r.action}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </Sheet>
  );
}

// Where a market can be traded. Crypto pairs open on the exchanges; every market opens on TradingView, where a
// broker account can be connected and orders placed.
function brokerLinks(meta, symbol) {
  const out = [];
  const tvSym = (() => {
    if (!meta) return symbol;
    if (meta.asset_class === "crypto") return `BINANCE:${meta.base}${meta.quote === "USD" ? "USDT" : meta.quote}${meta.perp ? ".P" : ""}`;
    if (meta.asset_class === "forex" || meta.asset_class === "metal") return `OANDA:${(meta.display || symbol).replace(/[^A-Z]/gi, "")}`;
    return (meta.display || symbol).replace(/\s+/g, "");
  })();
  if (meta && meta.asset_class === "crypto") {
    const B = meta.base;
    const Q = meta.quote === "USD" ? "USDT" : meta.quote;
    if (meta.perp) {
      out.push(["Binance Futures", `https://www.binance.com/en/futures/${B}${Q}`]);
      out.push(["Bybit", `https://www.bybit.com/trade/usdt/${B}${Q}`]);
      out.push(["OKX", `https://www.okx.com/trade-swap/${B.toLowerCase()}-${Q.toLowerCase()}-swap`]);
    } else {
      out.push(["Binance", `https://www.binance.com/en/trade/${B}_${Q}?type=spot`]);
      out.push(["Bybit", `https://www.bybit.com/en/trade/spot/${B}/${Q}`]);
      out.push(["OKX", `https://www.okx.com/trade-spot/${B.toLowerCase()}-${Q.toLowerCase()}`]);
      out.push(["KuCoin", `https://www.kucoin.com/trade/${B}-${Q}`]);
      out.push(["MEXC", `https://www.mexc.com/exchange/${B}_${Q}`]);
      out.push(["Gate", `https://www.gate.io/trade/${B}_${Q}`]);
    }
  }
  out.push(["TradingView (connect a broker there)", `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym)}`]);
  return out;
}

export function BrokerPanel({ open, onClose, onBack, meta, symbol, plan, decimals, toast }) {
  const links = brokerLinks(meta, symbol);
  const ticket = plan && plan.entry ? [
    `${symbol} ${plan.side === "short" ? "SELL" : "BUY"} (${plan.type || "limit"})`,
    `Entry ${fmtPrice(plan.entry, decimals)}`, `Stop loss ${fmtPrice(plan.sl, decimals)}`,
    ...(plan.tps || []).map((tp, i) => `Take profit ${i + 1}: ${fmtPrice(tp, decimals)}`),
  ].join("\n") : null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ticket);
      toast("Plan copied. Paste the levels into your broker's order ticket.", "success");
    } catch {
      toast("Copy didn't work in this browser. Long-press the levels to copy them.", "error");
    }
  };
  return (
    <Sheet open={open} onClose={onClose} onBack={onBack} title="Trade with your broker">
      <p className="hub-note">StreixAnalyst does not place orders yet. Open {symbol} at your broker or exchange, then enter the levels yourself. Your broker account and money stay with your broker.</p>
      {ticket ? (
        <div className="hub-ticket">
          <pre className="num">{ticket}</pre>
          <button className="btn sm" onClick={copy}><Icon name="copy" size={15} /> Copy plan</button>
        </div>
      ) : <p className="faint hub-note">Press Analyse first to have the plan's entry, stop and targets ready to copy.</p>}
      <div className="hub-list">
        {links.map(([name, href]) => (
          <a key={name} className="hub-item hub-item-main" href={href} target="_blank" rel="noopener noreferrer">
            <b>{name}</b>
            <small>Opens {symbol} in a new tab</small>
          </a>
        ))}
      </div>
    </Sheet>
  );
}

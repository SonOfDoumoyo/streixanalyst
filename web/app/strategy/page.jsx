"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Icon from "@/components/Icons";
import ChartView from "@/components/chart/ChartView";
import Paywall from "@/components/Paywall";
import SubNav from "@/components/SubNav";
import EquityCurve from "@/components/EquityCurve";
import { useAuth } from "@/components/Providers";
import { Menu, RequireAuth, Spinner } from "@/components/ui";
import SymbolSearch, { SymbolIcon } from "@/components/terminal/SymbolSearch";
import { ApiError, del, get, post, put, qs } from "@/lib/api";
import { cleanSymbol, fmtDate, fmtDateTime, fmtPct, fmtPrice } from "@/lib/format";
import { localGet, localSet } from "@/lib/settings";

const TFS = ["5m", "15m", "1h", "4h", "1D"];
const BARS = [[1000, "1,000"], [3000, "3,000"], [5000, "5,000"]];
const PARAM_LABEL = {
  fast: "Fast EMA", slow: "Slow EMA", period: "Period", within: "Within candles", long_below: "Long below", short_above: "Short above",
  level: "Level", lookback: "Lookback", atr: "Within ATR", mult: "Multiplier", buffer_atr: "Buffer (ATR)", value: "Value", names: "Sessions", kind: "Break type",
};
const FLOAT_KEYS = new Set(["atr", "mult", "buffer_atr", "value"]);
const STOP_LABEL = { atr: "ATR multiple", swing: "Beyond the last swing", percent: "Percent of price" };
const TARGET_LABEL = { rr: "Reward : risk", atr: "ATR multiple", percent: "Percent of price" };
const SESSION_LABEL = { asia: "Asia", london: "London", newyork: "New York", nyclose: "NY close" };
const EXAMPLE = "Buy when EMA 50 is above EMA 200 and RSI crosses back above 30 in the London or New York session. Stop 1.5 ATR, target 2R.";

function fillDesc(desc, c) {
  return String(desc || "").replace(/\{(\w+)\}/g, (m, k) => (Array.isArray(c[k]) ? c[k].map((n) => SESSION_LABEL[n] || n).join(" + ") : c[k] ?? m));
}
const signed = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(d)}`);

function NumInput({ value, onChange, float, label }) {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => { setTxt(String(value)); }, [value]);
  return (
    <label className="param">
      <span>{label}</span>
      <input className="input sm num" inputMode="decimal" value={txt} aria-label={label}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={() => {
          const v = float ? parseFloat(txt) : parseInt(txt, 10);
          if (Number.isFinite(v)) onChange(v);
          else setTxt(String(value));
        }} />
    </label>
  );
}

function Condition({ c, meta, onChange, onRemove, live }) {
  const params = Object.keys((meta && meta.params) || {});
  return (
    <div className="cond">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="grow">
          <div className="row" style={{ gap: 8 }}>
            <b>{meta ? meta.label : c.type}</b>
            {live ? (
              <span className="row" style={{ gap: 4 }}>
                <span className={`badge ${live.long ? "up" : ""}`} title="Long condition right now">L {live.long ? "✓" : "·"}</span>
                <span className={`badge ${live.short ? "down" : ""}`} title="Short condition right now">S {live.short ? "✓" : "·"}</span>
              </span>
            ) : null}
          </div>
          <div className="faint" style={{ fontSize: "0.8rem", marginTop: 2 }}>{fillDesc(meta && meta.desc, c)}</div>
        </div>
        <button className="icon-btn" onClick={onRemove} aria-label={`Remove ${meta ? meta.label : c.type}`}><Icon name="x" size={16} /></button>
      </div>
      {params.length ? (
        <div className="params">
          {params.map((k) => {
            if (k === "names") {
              return (
                <div key={k} className="param wide">
                  <span>{PARAM_LABEL[k]}</span>
                  <div className="chips">
                    {Object.keys(SESSION_LABEL).map((n) => {
                      const on = (c.names || []).includes(n);
                      return (
                        <button key={n} className={`chip ${on ? "on" : ""}`} aria-pressed={on}
                          onClick={() => {
                            const next = on ? c.names.filter((x) => x !== n) : [...(c.names || []), n];
                            if (next.length) onChange({ ...c, names: next });
                          }}>{SESSION_LABEL[n]}</button>
                      );
                    })}
                  </div>
                </div>
              );
            }
            if (k === "kind") {
              return (
                <label key={k} className="param">
                  <span>{PARAM_LABEL[k]}</span>
                  <select className="select input sm" value={c.kind} onChange={(e) => onChange({ ...c, kind: e.target.value })}>
                    <option value="any">BOS or CHoCH</option><option value="BOS">BOS only</option><option value="CHoCH">CHoCH only</option>
                  </select>
                </label>
              );
            }
            return <NumInput key={k} label={PARAM_LABEL[k] || k} value={c[k]} float={FLOAT_KEYS.has(k)} onChange={(v) => onChange({ ...c, [k]: v })} />;
          })}
        </div>
      ) : null}
    </div>
  );
}

function StrategyInner() {
  const { settings, toast } = useAuth();
  const sp = useSearchParams();
  const [width, setWidth] = useState(1400);
  useEffect(() => {
    const f = () => setWidth(window.innerWidth);
    f();
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  const mobile = width <= 760;
  const [lib, setLib] = useState(null);
  const [spec, setSpec] = useState(null);
  const [name, setName] = useState("My strategy");
  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [symbol, setSymbol] = useState(cleanSymbol(sp.get("s") || localGet("sa_lab_symbol", "BTCUSDT")));
  const [tf, setTf] = useState(TFS.includes(sp.get("tf")) ? sp.get("tf") : localGet("sa_lab_tf", "1h"));
  const [bars, setBars] = useState(3000);
  const [res, setRes] = useState(null);
  const [running, setRunning] = useState(false);
  const [saved, setSaved] = useState([]);
  const [savedId, setSavedId] = useState(null);
  const [savedOpen, setSavedOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [paywall, setPaywall] = useState(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [allTrades, setAllTrades] = useState(false);
  const eng = useRef(null);
  const [ready, setReady] = useState(false);
  const meta = useRef(null);
  const resultsRef = useRef(null);

  const theme = useMemo(() => ({
    bg: settings.chart.background, grid: settings.chart.gridColor, text: settings.chart.textColor, crosshair: settings.chart.crosshair,
    up: settings.candles.up, down: settings.candles.down, wickUp: settings.candles.wickUp, wickDown: settings.candles.wickDown,
    borderUp: settings.candles.borderUp, borderDown: settings.candles.borderDown,
  }), [settings.chart, settings.candles]);

  const fail = useCallback((e) => {
    if (e instanceof ApiError && (e.status === 402 || e.status === 429)) setPaywall({ message: e.message, detail: e.detail });
    else toast(e.message, "error");
  }, [toast]);

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    get("/strategy/library").then((d) => {
      setLib(d);
      const want = sp.get("t");
      const draft = localGet("sa_lab_draft", null);
      const tpl = d.templates.find((t) => t.id === want) || (!draft && d.templates[0]);
      if (tpl) {
        setSpec({ direction: tpl.direction, conditions: tpl.conditions, stop: tpl.stop, target: tpl.target, max_hold: tpl.max_hold });
        setName(tpl.name);
      } else if (draft) {
        setSpec(draft.spec);
        setName(draft.name || "My strategy");
        setSavedId(draft.savedId || null);
      }
    }).catch(fail);
    get("/strategy/saved").then((d) => setSaved(d.items)).catch(() => {});
  }, [sp, fail]);

  useEffect(() => {
    if (spec) localSet("sa_lab_draft", { spec, name, savedId });
  }, [spec, name, savedId]);
  useEffect(() => { localSet("sa_lab_symbol", symbol); localSet("sa_lab_tf", tf); }, [symbol, tf]);

  useEffect(() => {
    if (!ready) return;
    eng.current.setTheme(theme);
    eng.current.setOptions({ style: settings.candles.style, volume: false, indicators: { ema20: false, ema50: false, ema200: false, bb: false, vwap: false } });
    eng.current.setDetail(3);
  }, [ready, theme, settings.candles.style]);

  const loadChart = useCallback(async (s, t, n) => {
    if (!eng.current) return null;
    setChartLoading(true);
    try {
      const d = await get(`/market/candles?${qs({ symbol: s, tf: t, bars: n })}`);
      if (!eng.current) return null;
      eng.current.setData(d.candles, { tfSec: d.tf_seconds, decimals: d.decimals, label: `${d.display} · ${t}` });
      meta.current = d;
      return d;
    } catch (e) {
      toast(e.message, "error");
      return null;
    } finally {
      setChartLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!ready) return;
    setRes(null);
    eng.current.clearAnalysis();
    loadChart(symbol, tf, 600);
  }, [ready, symbol, tf, loadChart]);

  const change = (next) => {
    setSpec(next);
    setDirty(true);
  };
  const applyTemplate = (t) => {
    change({ direction: t.direction, conditions: t.conditions, stop: t.stop, target: t.target, max_hold: t.max_hold });
    setName(t.name);
    setSavedId(null);
    setParsed(null);
  };

  const parse = async () => {
    if (text.trim().length < 3) return;
    setParsing(true);
    try {
      const d = await post("/strategy/parse", { text: text.trim() });
      change(d.spec);
      setParsed(d);
      if (!savedId) setName(d.spec.name && d.spec.name !== "My strategy" ? d.spec.name : "My strategy");
    } catch (e) {
      fail(e);
    } finally {
      setParsing(false);
    }
  };

  const run = async () => {
    if (!spec) return;
    setRunning(true);
    try {
      const d = await post("/strategy/run", { symbol, tf, spec: { ...spec, name }, bars, save_id: savedId });
      setRes(d);
      setDirty(false);
      setAllTrades(false);
      if (window.innerWidth <= 1100 && resultsRef.current) resultsRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      const cd = await loadChart(symbol, tf, Math.min(5000, Math.max(600, d.period.candles)));
      if (eng.current && cd) {
        const items = [...d.markers];
        const step = cd.tf_seconds;
        const L = d.live;
        if (L.signal && Number.isFinite(L.stop)) {
          const t2 = L.time + 30 * step;
          const ln = (id, p, color, label) => ({ id, layer: "plan", kind: "line", order: 9, prio: 1, t1: L.time, t2, p1: p, p2: p, color, width: 1.6, text: label, axisTag: true });
          items.push(ln("ent", L.entry, "#e8a287", `Entry ${fmtPrice(L.entry, d.decimals)}`));
          items.push(ln("stp", L.stop, "#ff5d7a", `Stop ${fmtPrice(L.stop, d.decimals)}`));
          items.push(ln("tgt", L.target, "#2fd3a6", `Target ${fmtPrice(L.target, d.decimals)}`));
        }
        eng.current.setAnalysis(items, { animate: true, pins: [] });
        const ct = cd.candles;
        if (ct.length > 160) eng.current.fitTimes(ct[ct.length - 160][0], ct[ct.length - 1][0] + 12 * step, 4);
      }
      if (savedId) get("/strategy/saved").then((x) => setSaved(x.items)).catch(() => {});
    } catch (e) {
      fail(e);
    } finally {
      setRunning(false);
    }
  };

  const save = async (asNew = false) => {
    if (!spec) return;
    try {
      const body = { name: name.trim() || "My strategy", spec };
      const d = savedId && !asNew ? await put(`/strategy/saved/${savedId}`, body) : await post("/strategy/saved", body);
      setSavedId(d.id);
      toast(savedId && !asNew ? "Strategy updated" : "Strategy saved", "success");
      const x = await get("/strategy/saved");
      setSaved(x.items);
    } catch (e) {
      fail(e);
    }
  };
  const [alerting, setAlerting] = useState(false);
  const alertMe = async () => {
    if (!spec) return;
    setAlerting(true);
    try {
      let id = savedId;
      const body = { name: name.trim() || "My strategy", spec };
      if (!id) {
        const d = await post("/strategy/saved", body);
        id = d.id;
        setSavedId(id);
        get("/strategy/saved").then((x) => setSaved(x.items)).catch(() => {});
      } else if (dirty) {
        await put(`/strategy/saved/${id}`, body);
      }
      await post("/alerts", { kind: "strategy", symbol, tf, strategy_id: id });
      try { if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission(); } catch { /* unsupported */ }
      toast(`Alert set: you'll be notified whenever "${body.name}" fires on ${symbol} ${tf}.`, "success", 6000);
    } catch (e) {
      fail(e);
    } finally {
      setAlerting(false);
    }
  };
  const loadSaved = (s) => {
    setSpec(s.spec);
    setName(s.name);
    setSavedId(s.id);
    setParsed(null);
    setSavedOpen(false);
    setDirty(true);
    if (s.last_symbol) setSymbol(s.last_symbol);
    if (s.last_tf && TFS.includes(s.last_tf)) setTf(s.last_tf);
  };
  const removeSaved = async (s) => {
    try {
      await del(`/strategy/saved/${s.id}`);
      setSaved((xs) => xs.filter((x) => x.id !== s.id));
      if (savedId === s.id) setSavedId(null);
    } catch (e) {
      fail(e);
    }
  };

  const st = res && res.stats;
  const liveBy = {};
  if (res && !dirty) res.live.checks.forEach((c, i) => { liveBy[i] = c; });
  const tone = st && st.trades ? (st.verdict.startsWith("promising") ? "up" : st.verdict.startsWith("positive") ? "warn" : st.verdict.startsWith("loses") ? "down" : "") : "";
  const dec = res ? res.decimals : (meta.current && meta.current.decimals) || 2;

  return (
    <div className="page lab-page">
      <SubNav mobile={mobile} />
      <main className="lab">
        <section className="lab-left stack">
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="grow">
              <div className="eyebrow">Strategy lab</div>
              <input className="lab-name" value={name} maxLength={60} onChange={(e) => { setName(e.target.value); setDirty(true); }} aria-label="Strategy name" />
            </div>
            <div style={{ position: "relative" }}>
              <button className="btn sm" onClick={() => setSavedOpen(!savedOpen)}><Icon name="book" size={15} /> Saved ({saved.length}) <Icon name="chevronDown" size={14} /></button>
              <Menu open={savedOpen} onClose={() => setSavedOpen(false)} anchorStyle={{ top: 40, right: 0, width: 300 }}>
                {saved.length ? saved.map((s) => (
                  <div key={s.id} className="row" style={{ gap: 4 }}>
                    <button className="grow" onClick={() => loadSaved(s)} style={{ textAlign: "left" }}>
                      <div style={{ minWidth: 0 }}>
                        <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</b>
                        <span className="faint" style={{ fontSize: "0.76rem" }}>
                          {s.last_stats && s.last_stats.trades ? `${s.last_symbol} ${s.last_tf} · ${s.last_stats.trades} trades · ${signed(s.last_stats.avg_r)}R avg` : "not run yet"}
                        </span>
                      </div>
                    </button>
                    <button className="icon-btn" onClick={() => removeSaved(s)} aria-label={`Delete ${s.name}`}><Icon name="trash" size={15} /></button>
                  </div>
                )) : <div className="faint" style={{ padding: 10, fontSize: "0.86rem" }}>Nothing saved yet. Build a strategy and press Save.</div>}
              </Menu>
            </div>
          </div>

          <div className="card" style={{ padding: 14 }}>
            <div className="section-title" style={{ marginTop: 0 }}><Icon name="sparkles" size={15} /> Describe it in your own words</div>
            <textarea className="input textarea" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) parse(); }} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary sm" onClick={parse} disabled={parsing || text.trim().length < 3}>
                {parsing ? <span className="spinner" /> : <Icon name="zap" size={15} />} Build the rules
              </button>
              {!text ? <button className="btn ghost sm" onClick={() => setText(EXAMPLE)}>Use the example</button> : null}
              <div className="grow" />
              {parsed ? <span className={`badge ${parsed.used_ai ? "violet" : ""}`}>{parsed.used_ai ? "read by StreixAI" : "read by rules"}</span> : null}
            </div>
            {parsed && parsed.notes && parsed.notes.length ? (
              <ul className="check-list" style={{ marginTop: 10 }}>{parsed.notes.map((n, i) => <li key={i}><span className="ic">i</span><span>{n}</span></li>)}</ul>
            ) : null}
          </div>

          {lib ? (
            <div>
              <div className="section-title">Or start from a template</div>
              <div className="chips">
                {lib.templates.map((t) => <button key={t.id} className="chip" title={t.description} onClick={() => applyTemplate(t)}>{t.name}</button>)}
              </div>
            </div>
          ) : <Spinner />}

          {spec && lib ? (
            <div className="card stack" style={{ padding: 14, gap: 12 }}>
              <div className="row wrap" style={{ justifyContent: "space-between" }}>
                <div className="section-title" style={{ margin: 0 }}><Icon name="sliders" size={15} /> Rules</div>
                <div className="seg brand" role="radiogroup" aria-label="Direction">
                  {[["both", "Long & short"], ["long", "Long only"], ["short", "Short only"]].map(([v, l]) => (
                    <button key={v} className={spec.direction === v ? "on" : ""} onClick={() => change({ ...spec, direction: v })}>{l}</button>
                  ))}
                </div>
              </div>
              <div className="faint" style={{ fontSize: "0.8rem" }}>Enter when <b>all</b> of these are true:</div>
              {spec.conditions.map((c, i) => (
                <Condition key={`${c.type}-${i}`} c={c} meta={lib.conditions[c.type]} live={liveBy[i]}
                  onChange={(nc) => change({ ...spec, conditions: spec.conditions.map((x, j) => (j === i ? nc : x)) })}
                  onRemove={() => spec.conditions.length > 1 ? change({ ...spec, conditions: spec.conditions.filter((_, j) => j !== i) }) : toast("A strategy needs at least one condition.", "error")} />
              ))}
              {spec.conditions.length < 8 ? (
                <div style={{ position: "relative" }}>
                  <button className="btn ghost sm" onClick={() => setAddOpen(!addOpen)}><Icon name="plus" size={15} /> Add a condition</button>
                  <Menu open={addOpen} onClose={() => setAddOpen(false)} anchorStyle={{ top: 38, left: 0, width: 320, maxHeight: 360, overflowY: "auto" }}>
                    {Object.entries(lib.conditions).map(([k, m]) => (
                      <button key={k} onClick={() => { change({ ...spec, conditions: [...spec.conditions, { type: k, ...m.params }] }); setAddOpen(false); }} style={{ textAlign: "left" }}>
                        <div><b>{m.label}</b><div className="faint" style={{ fontSize: "0.76rem" }}>{fillDesc(m.desc, m.params)}</div></div>
                      </button>
                    ))}
                  </Menu>
                </div>
              ) : null}
              <div className="lab-exits">
                <div className="cond">
                  <b>Stop loss</b>
                  <div className="params">
                    <label className="param wide">
                      <span>Placed at</span>
                      <select className="select input sm" value={spec.stop.type} onChange={(e) => change({ ...spec, stop: { type: e.target.value, ...lib.stops[e.target.value] } })}>
                        {Object.keys(lib.stops).map((k) => <option key={k} value={k}>{STOP_LABEL[k] || k}</option>)}
                      </select>
                    </label>
                    {Object.keys(lib.stops[spec.stop.type] || {}).map((k) => (
                      <NumInput key={k} label={PARAM_LABEL[k] || k} value={spec.stop[k]} float={FLOAT_KEYS.has(k)} onChange={(v) => change({ ...spec, stop: { ...spec.stop, [k]: v } })} />
                    ))}
                  </div>
                </div>
                <div className="cond">
                  <b>Take profit</b>
                  <div className="params">
                    <label className="param wide">
                      <span>Placed at</span>
                      <select className="select input sm" value={spec.target.type} onChange={(e) => change({ ...spec, target: { type: e.target.value, ...lib.targets[e.target.value] } })}>
                        {Object.keys(lib.targets).map((k) => <option key={k} value={k}>{TARGET_LABEL[k] || k}</option>)}
                      </select>
                    </label>
                    {Object.keys(lib.targets[spec.target.type] || {}).map((k) => (
                      <NumInput key={k} label={spec.target.type === "rr" ? "R multiple" : PARAM_LABEL[k] || k} value={spec.target[k]} float onChange={(v) => change({ ...spec, target: { ...spec.target, [k]: v } })} />
                    ))}
                    <NumInput label="Max hold (candles)" value={spec.max_hold} onChange={(v) => change({ ...spec, max_hold: v })} />
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div className="card lab-run" style={{ padding: 14 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <button className="symbol-btn" onClick={() => setSearchOpen(true)} aria-label="Change market">
                <SymbolIcon symbol={symbol} size={22} /><span className="sym">{symbol}</span><Icon name="chevronDown" size={14} />
              </button>
              <div className="seg">
                {TFS.map((t) => <button key={t} className={tf === t ? "on" : ""} onClick={() => setTf(t)}>{t}</button>)}
              </div>
              <select className="select input sm" style={{ width: "auto" }} value={bars} onChange={(e) => setBars(Number(e.target.value))} aria-label="Candles to test">
                {BARS.map(([v, l]) => <option key={v} value={v}>{l} candles</option>)}
              </select>
            </div>
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <button className="btn primary lg grow" onClick={run} disabled={running || !spec}>
                {running ? <span className="spinner" /> : <Icon name="play" size={17} />} {res && !dirty ? "Run again" : "Backtest & check now"}
              </button>
              <button className="btn lg" onClick={() => save(false)} disabled={!spec} title={savedId ? "Update the saved strategy" : "Save this strategy"}>
                <Icon name="download" size={16} /> {savedId ? "Update" : "Save"}
              </button>
            </div>
            <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
              <button className="btn ghost sm" onClick={alertMe} disabled={!spec || alerting} title="Get a notification each time these rules fire on a closed candle">
                {alerting ? <span className="spinner dark" /> : <Icon name="bell" size={14} />} Alert me when it fires on {symbol} {tf}
              </button>
              {savedId ? <button className="btn ghost sm" onClick={() => save(true)}>Save as a copy</button> : null}
            </div>
          </div>
        </section>

        <section className="lab-right stack" ref={resultsRef} style={{ scrollMarginTop: 70 }}>
          {res && dirty ? (
            <div className="stale-note row">
              <Icon name="info" size={17} />
              <span className="grow">You changed the rules since this run. These results are for the previous version.</span>
              <button className="btn sm primary" onClick={run} disabled={running}>Run again</button>
            </div>
          ) : null}
          {res ? (
            <div className={`card live-card ${res.live.signal || ""}`}>
              <div className="row wrap">
                <div className="grow" style={{ minWidth: 240 }}>
                  <div className="eyebrow">Right now · {res.symbol} {res.tf}</div>
                  <b style={{ fontSize: "1.15rem" }}>
                    {res.live.signal ? `${res.live.signal === "long" ? "Long" : "Short"} signal on the last candle` : "No signal on the last candle"}
                  </b>
                  <div className="faint" style={{ fontSize: "0.82rem" }}>
                    Long rules met {res.live.long_ready}/{res.live.total} · short rules met {res.live.short_ready}/{res.live.total} · price {fmtPrice(res.live.price, dec)}
                  </div>
                </div>
                {res.live.signal && Number.isFinite(res.live.stop) ? (
                  <div className="row" style={{ gap: 14 }}>
                    <div><div className="faint" style={{ fontSize: "0.74rem" }}>Entry</div><b className="num">{fmtPrice(res.live.entry, dec)}</b></div>
                    <div><div className="faint" style={{ fontSize: "0.74rem" }}>Stop</div><b className="num down">{fmtPrice(res.live.stop, dec)}</b></div>
                    <div><div className="faint" style={{ fontSize: "0.74rem" }}>Target</div><b className="num up">{fmtPrice(res.live.target, dec)}</b></div>
                  </div>
                ) : null}
              </div>
              {res.open_trade ? (
                <div className="hint" style={{ marginTop: 8 }}>
                  A {res.open_trade.side} from the backtest is still open: entry {fmtPrice(res.open_trade.entry, dec)}, stop {fmtPrice(res.open_trade.stop, dec)}, target {fmtPrice(res.open_trade.target, dec)}.
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="card lab-chart" style={{ "--chart-bg": theme.bg }}>
            <ChartView onReady={(e) => { eng.current = e; setReady(!!e); }} onEvent={() => {}} />
            {chartLoading || running ? <div className="chart-msg"><div><Spinner /></div></div> : null}
            {res ? (
              <div className="lab-legend glass">
                <span><i style={{ color: "#2fd3a6" }}>▲</i> long entry</span><span><i style={{ color: "#ff5d7a" }}>▼</i> short entry</span>
                <span><i style={{ color: "var(--text-2)" }}>●</i> target hit</span><span><i style={{ color: "var(--text-2)" }}>✕</i> stopped / timed out</span>
              </div>
            ) : null}
          </div>

          {!res ? (
            <div className="card" style={{ padding: 18 }}>
              <b>How the lab works</b>
              <ul className="check-list" style={{ marginTop: 10 }}>
                <li><span className="ic">1</span><span>Describe your strategy in plain words, pick a template, or build the rules yourself.</span></li>
                <li><span className="ic">2</span><span>Run it: every past candle is checked, trades enter at the <b>next candle's open</b> (no peeking at the future), and the stop is assumed to hit first when both levels fall inside one candle.</span></li>
                <li><span className="ic">3</span><span>Trading costs and stop slippage are taken off every trade, so the numbers are what you'd actually have kept.</span></li>
                <li><span className="ic">4</span><span>You also see whether the rules are firing on the latest candle, with the entry, stop and target.</span></li>
              </ul>
              <div className="hint" style={{ marginTop: 10 }}>A backtest describes the past. It can't promise the future, so treat it as evidence, not a guarantee.</div>
            </div>
          ) : null}

          {res && st ? (
            st.trades ? (
              <>
                <div className={`verdict-bar ${tone}`}>
                  <Icon name={tone === "up" ? "check" : tone === "down" ? "alert" : "info"} size={18} />
                  <div>
                    <b>Verdict: {st.verdict}.</b>
                    <div style={{ fontSize: "0.82rem", opacity: 0.9 }}>
                      {res.period.candles.toLocaleString()} candles ({fmtDate(res.period.start * 1000)} – {fmtDate(res.period.end * 1000)}) · costs {res.costs.round_trip_pct.toFixed(3)}% round trip + {res.costs.stop_slip_pct.toFixed(3)}% stop slippage
                      {st.t_stat !== null && st.t_stat !== undefined ? ` · t-stat ${st.t_stat.toFixed(2)} (2+ is meaningful)` : ""}
                    </div>
                  </div>
                </div>
                {res.notes && res.notes.length ? <div className="hint">{res.notes.join(" ")}</div> : null}
                <div className="stats lab-stats">
                  <div className="card stat"><div className="k">Trades</div><div className="v">{st.trades}</div>
                    <div className="faint" style={{ fontSize: "0.76rem" }}>{st.by_side.long ? `${st.by_side.long.trades} long` : ""}{st.by_side.long && st.by_side.short ? " · " : ""}{st.by_side.short ? `${st.by_side.short.trades} short` : ""}</div></div>
                  <div className="card stat"><div className="k">Win rate</div><div className="v">{fmtPct(st.win_rate)}</div>
                    <div className="faint" style={{ fontSize: "0.76rem" }}>{st.exits.target} targets · {st.exits.stop} stops · {st.exits.time} timed out</div></div>
                  <div className="card stat"><div className="k">Average trade</div><div className={`v ${st.avg_r > 0 ? "up" : "down"}`}>{signed(st.avg_r)}R</div>
                    <div className="faint" style={{ fontSize: "0.76rem" }}>median {signed(st.median_r)}R</div></div>
                  <div className="card stat"><div className="k">Total</div><div className={`v ${st.total_r > 0 ? "up" : "down"}`}>{signed(st.total_r, 1)}R</div>
                    <div className="faint" style={{ fontSize: "0.76rem" }}>at 1% risk ≈ {signed(st.total_r, 0)}% of the account</div></div>
                  <div className="card stat"><div className="k">Profit factor</div><div className="v">{st.profit_factor ? st.profit_factor.toFixed(2) : "—"}</div>
                    <div className="faint" style={{ fontSize: "0.76rem" }}>won ÷ lost, above 1.3 is healthy</div></div>
                  <div className="card stat"><div className="k">Worst drawdown</div><div className="v down">{signed(st.max_drawdown_r, 1)}R</div>
                    <div className="faint" style={{ fontSize: "0.76rem" }}>longest losing run {st.longest_losing_streak}</div></div>
                </div>
                <div className="card" style={{ padding: 14 }}>
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                    <b>Equity curve</b><span className="faint" style={{ fontSize: "0.8rem" }}>cumulative R after each closed trade · avg hold {st.avg_bars.toFixed(1)} candles</span>
                  </div>
                  <EquityCurve equity={res.equity} />
                </div>
                {Object.keys(st.by_side).length > 1 ? (
                  <div className="grid-2">
                    {["long", "short"].map((s) => st.by_side[s] ? (
                      <div key={s} className="card" style={{ padding: 12, fontSize: "0.86rem" }}>
                        <b style={{ textTransform: "capitalize" }}>{s}s</b> <span className="faint">{st.by_side[s].trades} trades</span>
                        <div>win rate {fmtPct(st.by_side[s].win_rate)} · avg <b className={st.by_side[s].avg_r > 0 ? "up" : "down"}>{signed(st.by_side[s].avg_r)}R</b> · total {signed(st.by_side[s].total_r, 1)}R</div>
                      </div>
                    ) : null)}
                  </div>
                ) : null}
                <div>
                  <div className="section-title">Latest trades</div>
                  <div className="table-wrap">
                    <table className="t">
                      <thead><tr><th>Side</th><th>Entered</th><th>Entry</th><th>Stop</th><th>Exit</th><th>Result</th><th style={{ textAlign: "right" }}>R</th><th style={{ textAlign: "right" }}>Candles</th></tr></thead>
                      <tbody>
                        {(allTrades ? res.trades : res.trades.slice(0, 12)).map((t, i) => (
                          <tr key={i}>
                            <td><span className={`badge ${t.side === "long" ? "up" : "down"}`}>{t.side}</span></td>
                            <td className="num">{fmtDateTime(t.entry_t * 1000)}</td>
                            <td className="num">{fmtPrice(t.entry, dec)}</td>
                            <td className="num">{fmtPrice(t.stop, dec)}</td>
                            <td className="num">{fmtPrice(t.exit, dec)}</td>
                            <td>{t.reason === "target" ? "target hit" : t.reason === "stop" ? "stopped out" : "time exit"}</td>
                            <td className={`num ${t.r > 0 ? "up" : "down"}`} style={{ textAlign: "right", fontWeight: 700 }}>{signed(t.r)}</td>
                            <td className="num" style={{ textAlign: "right" }}>{t.bars}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {res.trades.length > 12 ? (
                    <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setAllTrades(!allTrades)}>
                      {allTrades ? "Show fewer" : `Show all ${res.trades.length} recent trades`}
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="card" style={{ padding: 18 }}>
                <b>No trades in {res.period.candles.toLocaleString()} candles.</b>
                <div className="muted" style={{ marginTop: 6 }}>These rules never all lined up on {res.symbol} {res.tf}. Remove a condition, loosen a setting, or try another timeframe.</div>
                {res.notes && res.notes.length ? <div className="hint" style={{ marginTop: 8 }}>{res.notes.join(" ")}</div> : null}
              </div>
            )
          ) : null}
        </section>
      </main>
      <SymbolSearch open={searchOpen} onClose={() => setSearchOpen(false)} onPick={(s) => { const c = cleanSymbol(s); if (c) setSymbol(c); }} />
      <Paywall open={!!paywall} onClose={() => setPaywall(null)} info={paywall} />
    </div>
  );
}

export default function StrategyPage() {
  return (
    <RequireAuth>
      <Suspense fallback={null}><StrategyInner /></Suspense>
    </RequireAuth>
  );
}

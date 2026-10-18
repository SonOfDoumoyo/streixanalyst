"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import Icon from "@/components/Icons";
import Brand, { Mark } from "@/components/Brand";
import ChartView from "@/components/chart/ChartView";
import { useAuth } from "@/components/Providers";
import { Menu, Modal } from "@/components/ui";
import Paywall from "@/components/Paywall";
import AlertsBell from "@/components/AlertsBell";
import { APP_LINKS } from "@/components/SubNav";
import { ApiError, del, get, post, put, qs } from "@/lib/api";
import { ANALYSIS_STEPS, gradeClass, toOverlay, toUserDrawings, verdictTone } from "@/lib/analysis";
import { cleanSymbol, fmtChange, fmtPrice, initials, TF_LABEL, TFS } from "@/lib/format";
import { localGet, localSet } from "@/lib/settings";
import SymbolSearch from "./SymbolSearch";
import { DrawToolbar, StyleBar, TOOL_KEYS } from "./DrawTools";
import AnalysisPanel from "./AnalysisPanel";
import AIChat from "./AIChat";
import Watchlist from "./Watchlist";
import NewsPanel from "./NewsPanel";
import ReviewModal from "./ReviewModal";
import DivergencePanel from "./DivergencePanel";
import ReplayPanel from "./ReplayPanel";
import { chartThemeFor } from "@/lib/chartTheme";

const STYLES = [["candles", "Candles"], ["hollow", "Hollow candles"], ["heikin", "Heikin Ashi"], ["bars", "OHLC bars"], ["line", "Line"], ["area", "Area"]];
const INDICATORS = [["ema20", "EMA 20"], ["ema50", "EMA 50"], ["ema200", "EMA 200"], ["bb", "Bollinger Bands"], ["vwap", "VWAP (intraday)"]];
const TABS = [["analysis", "Analysis", "zap"], ["replay", "Replay", "clock"], ["ai", "StreixAI", "sparkles"], ["watchlist", "Watchlist", "list"], ["news", "News", "news"], ["divergence", "Divergence", "candles"]];
const utcLabel = (iso) => `${iso.replace("T", " ").slice(0, 16)} UTC`;

function useWidth() {
  const [w, setW] = useState(typeof window === "undefined" ? 1400 : window.innerWidth);
  useEffect(() => {
    const f = () => setW(window.innerWidth);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return w;
}

export default function Terminal() {
  const { user, settings, updateSettings, refresh, toast, logout } = useAuth();
  const sp = useSearchParams();
  const width = useWidth();
  const mobile = width <= 760;
  const narrow = width <= 1100;
  const scale = width >= 3200 ? 1.9 : width >= 2200 ? 1.35 : 1;

  const [symbol, setSymbol] = useState(() => cleanSymbol(sp.get("s") || settings.lastSymbol || "BTCUSDT"));
  const [tf, setTf] = useState(() => (TFS.includes(sp.get("tf")) ? sp.get("tf") : TFS.includes(settings.lastTf) ? settings.lastTf : "1h"));
  const [meta, setMeta] = useState(null);
  const [chartState, setChartState] = useState({ loading: true, error: null });
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [stale, setStale] = useState(false);
  const [layers, setLayers] = useState([]);
  const [hiddenLayers, setHiddenLayers] = useState(() => new Set(localGet("sa_hidden_layers", [])));
  const [detail, setDetailState] = useState(settings.analysis.detail || 1);
  const [showAlt, setShowAlt] = useState(settings.analysis.showAlt === true);
  const [tab, setTab] = useState("analysis");
  // a replay moment: { at (ISO, UTC), ahead (candles shown after it, once revealed) }, or null when live
  const [replay, setReplay] = useState(null);
  const replayKey = replay ? `${replay.at}|${replay.ahead}` : "live";
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelHidden, setPanelHidden] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tool, setToolState] = useState("cursor");
  const [magnet, setMagnetState] = useState(false);
  const [drawVisible, setDrawVisible] = useState(true);
  const [drawMobile, setDrawMobile] = useState(false);
  const [selDrawing, setSelDrawing] = useState(null);
  const [watch, setWatch] = useState([]);
  const [hover, setHover] = useState(null);
  const [review, setReview] = useState({ open: false, prefill: null });
  const [paywall, setPaywall] = useState(null);
  const [textEdit, setTextEdit] = useState(null);
  const [pendingAsk, setPendingAsk] = useState(null);
  const [menu, setMenu] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const eng = useRef(null);
  const [engReady, setEngReady] = useState(false);
  const barsRef = useRef(600);
  const loadingMore = useRef(false);
  const saveTimer = useRef(null);
  const resRef = useRef(null);
  resRef.current = res;
  const replayRef = useRef(null);
  replayRef.current = replay;

  // the chart follows the app's light or dark mode (see lib/chartTheme.js)
  const theme = useMemo(() => chartThemeFor(settings.theme, settings.chart, settings.candles),
    [settings.theme, settings.chart, settings.candles]);

  // ───── engine wiring
  const onReady = useCallback((e) => {
    eng.current = e;
    setEngReady(!!e);
  }, []);

  const hoverRaf = useRef(0);
  const onEvent = useCallback((type, data) => {
    if (type === "hover") {
      cancelAnimationFrame(hoverRaf.current);
      hoverRaf.current = requestAnimationFrame(() => setHover(data));
    } else if (type === "select") setSelDrawing(data);
    else if (type === "toolDone") setToolState("cursor");
    else if (type === "requestText") {
      const d = eng.current && eng.current.drawings.find((x) => x.id === data);
      setTextEdit({ id: data, value: (d && d.style.text) || "" });
    } else if (type === "drawings") {
      clearTimeout(saveTimer.current);
      const sym = symbolRef.current;
      localSet(`sa_draw_${sym}`, data);
      saveTimer.current = setTimeout(() => {
        put("/user/drawings", { symbol: sym, items: data }).catch(() => {});
      }, 700);
    } else if (type === "view") {
      if (data.i0 < 40 && barsRef.current < 5000 && !loadingMore.current && data.n >= barsRef.current * 0.9) loadMore();
    }
    // loadMore is stable via refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const tfRef = useRef(tf);
  tfRef.current = tf;

  useEffect(() => {
    if (!eng.current) return;
    eng.current.setTheme(theme);
    eng.current.setOptions({ style: settings.candles.style, volume: settings.chart.volume, logScale: settings.chart.logScale, rsi: settings.chart.rsi,
      grid: settings.chart.grid, watermark: settings.chart.watermark, indicators: settings.indicators });
    eng.current.drawingDefaults = settings.drawingDefaults;
    eng.current.setScale(scale);
  }, [engReady, theme, settings.candles.style, settings.chart, settings.indicators, settings.drawingDefaults, scale]);

  useEffect(() => {
    if (!eng.current || !res) return;
    const ov = toOverlay(res, theme);
    eng.current.setAnalysis(ov.items, { animate: false, pins: ov.pins });
  }, [theme]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (eng.current) eng.current.setDetail(detail);
  }, [engReady, detail]);
  useEffect(() => {
    if (eng.current) eng.current.setHiddenLayers(hiddenLayers);
    localSet("sa_hidden_layers", [...hiddenLayers]);
  }, [engReady, hiddenLayers]);
  useEffect(() => {
    if (eng.current) eng.current.setShowAlt(showAlt);
  }, [engReady, showAlt]);
  useEffect(() => {
    if (eng.current) eng.current.setDrawingsVisible(drawVisible);
  }, [engReady, drawVisible]);

  // ───── data loading
  const loadChart = useCallback(async (sym, frame, rp) => {
    const e = eng.current;
    if (!e) return;
    setChartState({ loading: true, error: null });
    setRes(null);
    setStale(false);
    setLayers([]);
    e.clearAnalysis();
    barsRef.current = 600;
    try {
      const d = await get(`/market/candles?${qs(rp ? { symbol: sym, tf: frame, bars: 600, at: rp.at, ahead: rp.ahead } : { symbol: sym, tf: frame, bars: 600 })}`);
      if (sym !== symbolRef.current || frame !== tfRef.current) return;
      e.setData(d.candles, { tfSec: d.tf_seconds, decimals: d.decimals, label: `${d.display} · ${frame}` });
      setMeta(d);
      setChartState({ loading: false, error: null });
    } catch (err) {
      if (sym !== symbolRef.current) return;
      e.setData([], {});
      setMeta(null);
      setChartState({ loading: false, error: err.message || "Couldn't load this chart." });
    }
    const cached = localGet(`sa_draw_${sym}`, null);
    if (cached) e.setDrawings(cached);
    else e.setDrawings([]);
    get(`/user/drawings?${qs({ symbol: sym })}`).then((dd) => {
      if (sym !== symbolRef.current) return;
      if (dd.updated_at || !cached) e.setDrawings(dd.items || []);
    }).catch(() => {});
  }, []);

  const loadMore = useCallback(async () => {
    const e = eng.current;
    if (!e || loadingMore.current) return;
    loadingMore.current = true;
    const want = Math.min(5000, barsRef.current * 2);
    const sym = symbolRef.current;
    const frame = tfRef.current;
    const rp = replayRef.current;
    try {
      const d = await get(`/market/candles?${qs(rp ? { symbol: sym, tf: frame, bars: want, at: rp.at, ahead: rp.ahead } : { symbol: sym, tf: frame, bars: want })}`);
      if (sym === symbolRef.current && frame === tfRef.current && d.candles.length > e.d.length) {
        e.setData(d.candles, { tfSec: d.tf_seconds, decimals: d.decimals, keepView: true });
        barsRef.current = want;
      } else barsRef.current = 5000;
    } catch {
      barsRef.current = 5000;
    } finally {
      loadingMore.current = false;
    }
  }, []);

  useEffect(() => {
    if (!engReady) return;
    loadChart(symbol, tf, replayRef.current);
    const url = new URL(window.location.href);
    url.searchParams.set("s", symbol);
    url.searchParams.set("tf", tf);
    window.history.replaceState(null, "", url.toString());
    if (settings.lastSymbol !== symbol || settings.lastTf !== tf) updateSettings({ lastSymbol: symbol, lastTf: tf });
  }, [engReady, symbol, tf, replayKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // live updates
  useEffect(() => {
    if (!engReady || chartState.error || chartState.loading || !meta || replayKey !== "live") return undefined;
    const every = 5000;               // every market (crypto, forex, metals, indices, stocks) refreshes every 5 seconds
    let alive = true;
    const tick = async () => {
      if (document.hidden || !alive) return;
      try {
        const d = await get(`/market/latest?${qs({ symbol, tf })}`);
        if (!alive || !eng.current || symbolRef.current !== symbol) return;
        eng.current.updateTail(d.candles);
        setMeta((m) => (m ? { ...m, price: d.price } : m));
        const r = resRef.current;
        if (r && r.candles && d.candles.length) {
          const lastClosedAnalysed = r.candles[r.candles.length - (r.forming ? 2 : 1)][0];
          const closedNow = d.candles[d.candles.length - 2] ? d.candles[d.candles.length - 2][0] : 0;
          if (closedNow > lastClosedAnalysed) setStale(true);
        }
      } catch { /* keep trying */ }
    };
    const t = setInterval(tick, every);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [engReady, symbol, tf, meta && meta.asset_class, chartState.loading, chartState.error, replayKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    get("/user/watchlist").then((d) => setWatch(d.symbols || [])).catch(() => {});
  }, []);

  // analysis narration
  useEffect(() => {
    if (!busy) return undefined;
    setStep(0);
    const t = setInterval(() => setStep((s) => Math.min(ANALYSIS_STEPS.length - 1, s + 1)), 700);
    return () => clearInterval(t);
  }, [busy]);

  const showLimit = useCallback((e) => setPaywall({ message: e.message, detail: e.detail }), []);

  const analyse = useCallback(async () => {
    if (replayRef.current) {
      toast("You're looking at a past moment. Analyse it from the Replay tab.", "info");
      return;
    }
    if (busy || !eng.current || chartState.error) return;
    setBusy(true);
    setTab("analysis");
    const a = settings.analysis;
    try {
      const d = await post("/analysis/run", {
        symbol, tf, account: Number(a.account) || 1000, risk_pct: Number(a.risk_pct) || 1,
        leverage: a.leverage ? Number(a.leverage) : null, mode: a.mode === "auto" ? null : a.mode,
        drawings: toUserDrawings(eng.current.getDrawings()),
      });
      if (symbolRef.current !== symbol || tfRef.current !== tf) return;
      setRes(d);
      setStale(false);
      const ov = toOverlay(d, theme);
      setLayers(ov.layers);
      eng.current.setAnalysis(ov.items, { animate: a.animate !== false, pins: ov.pins });
      if (d.view && d.candles && d.candles.length) {
        const from = d.candles[Math.max(0, Math.min(d.candles.length - 1, d.view.x_from))][0];
        const last = d.candles[d.candles.length - 1][0];
        eng.current.fitTimes(from, last + ((d.meta && d.meta.tf_seconds) || 3600) * 30, 6);
      }
      if (narrow && !mobile) setPanelOpen(true);
      refresh();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 402 || e.status === 429)) showLimit(e);
      else toast(e.message || "The analysis failed.", "error");
    } finally {
      setBusy(false);
    }
  }, [busy, chartState.error, settings.analysis, symbol, tf, theme, narrow, mobile, refresh, toast, showLimit]);

  // ───── keyboard shortcuts
  useEffect(() => {
    const k = (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.target.isContentEditable) return;
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || e.key === "/") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.altKey && TOOL_KEYS[e.key.toLowerCase()]) {
        e.preventDefault();
        setTool(TOOL_KEYS[e.key.toLowerCase()]);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() === "a" && !e.repeat) analyse();
      if (/^[1-9]$/.test(e.key) && !e.repeat && document.activeElement && document.activeElement.tagName === "CANVAS") {
        const t = TFS[Number(e.key) - 1];
        if (t) setTf(t);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [analyse]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const f = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []);

  // ───── actions
  const pickSymbol = (s) => {
    const c = cleanSymbol(s);
    if (!c) return;
    setSymbol(c);
    if (mobile) setPanelOpen(false);
  };
  const setTool = (t) => {
    setToolState(t);
    if (eng.current) eng.current.setTool(t);
  };
  const setMagnet = (m) => {
    setMagnetState(m);
    if (eng.current) eng.current.magnet = m;
  };
  const toggleWatch = async (s, add) => {
    try {
      const d = add ? await post("/user/watchlist", { symbol: s }) : await del(`/user/watchlist/${encodeURIComponent(s)}`);
      setWatch(d.symbols || []);
      toast(add ? `${s} added to your watchlist` : `${s} removed`, "success", 2200);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) showLimit(e);
      else toast(e.message, "error");
    }
  };
  const moveWatch = async (i, dir) => {
    const next = watch.slice();
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setWatch(next);
    put("/user/watchlist", { symbols: next }).catch(() => {});
  };
  const toggleLayer = (id) => setHiddenLayers((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const setDetail = (n) => {
    setDetailState(n);
    updateSettings({ analysis: { detail: n } });
  };
  const ask = (q) => {
    setPendingAsk(q);
    setTab("ai");
    if (narrow) setPanelOpen(true);
  };
  const openTab = (t) => {
    setTab(t);
    if (narrow) setPanelOpen(true);
    if (panelHidden) setPanelHidden(false);
  };
  const screenshot = () => {
    if (!eng.current) return;
    const a = document.createElement("a");
    a.href = eng.current.screenshot();
    a.download = `${symbol}-${tf}-streixanalyst.png`;
    a.click();
  };
  const goFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
  };
  const reviewFromDrawing = () => {
    if (!selDrawing || !["long", "short"].includes(selDrawing.type)) return;
    const P = selDrawing.points;
    setReview({ open: true, prefill: { side: selDrawing.type, entry: P[0].p, sl: P[1].p, tp: P[2].p } });
  };
  const placeTrade = ({ side, entry, sl, tp }) => {
    if (!eng.current || !eng.current.d.length) return;
    const last = eng.current.d[eng.current.d.length - 1].t;
    const step = (meta && meta.tf_seconds) || 3600;
    const id = eng.current.addDrawing({ type: side === "short" ? "short" : "long", points: [{ t: last, p: entry }, { t: last + step * 24, p: sl }, { t: last + step * 24, p: tp }], style: {} });
    eng.current.select(id);
  };

  const ent = user && user.entitlements;
  const display = (meta && meta.display) || symbol;
  const legendCandle = hover && hover.candle ? hover.candle : eng.current && eng.current.d.length ? eng.current.d[eng.current.d.length - 1] : null;
  const dec = meta ? meta.decimals : 2;
  const prevClose = eng.current && eng.current.d.length > 1 ? eng.current.d[eng.current.d.length - 2].c : null;
  const dayChange = hover && hover.change !== null && hover.change !== undefined ? hover.change : legendCandle && prevClose ? (legendCandle.c / prevClose - 1) * 100 : null;
  const vTone = res ? verdictTone(res.verdict) : null;
  const panelVisible = !narrow ? !panelHidden : panelOpen;

  const panelContent = (
    <>
      {narrow ? (
        <div className="tabs" role="tablist">
          {TABS.map(([id, label, icon]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              <Icon name={icon} /> <span>{label}</span>
            </button>
          ))}
          <button onClick={() => setPanelOpen(false)} aria-label="Close panel" style={{ flex: "none", width: 40 }}><Icon name="x" /></button>
        </div>
      ) : null}
      <div className={`panel-body ${tab === "ai" || tab === "watchlist" ? "flush" : ""}`} style={tab === "ai" ? { overflow: "hidden", display: "flex", flexDirection: "column" } : undefined}>
        {tab === "analysis" ? (
          <AnalysisPanel res={res} busy={busy} step={step} steps={ANALYSIS_STEPS} onAnalyse={analyse} onAsk={ask} onUpgrade={() => setPaywall({ message: "Upgrade to Pro for both report styles and the model statistics." })}
            hiddenLayers={hiddenLayers} toggleLayer={toggleLayer} layers={layers} detail={detail} setDetail={setDetail} showAlt={showAlt}
            setShowAlt={(b) => { setShowAlt(b); updateSettings({ analysis: { showAlt: b } }); }} stale={stale} symbolLabel={display} tf={tf} symbol={symbol} />
        ) : null}
        {tab === "ai" ? (
          <AIChat symbol={symbol} tf={tf} analysisId={res && res.analysis_id} pending={pendingAsk} clearPending={() => setPendingAsk(null)} onLimit={showLimit} />
        ) : null}
        {tab === "watchlist" ? (
          <Watchlist symbols={watch} current={symbol} onPick={pickSymbol} onRemove={(s) => toggleWatch(s, false)} onAdd={() => setSearchOpen(true)} onMove={moveWatch} />
        ) : null}
        {tab === "news" ? <NewsPanel symbol={symbol} tf={tf} /> : null}
        {tab === "divergence" ? <DivergencePanel symbol={symbol} tf={tf} /> : null}
        {tab === "replay" ? <ReplayPanel symbol={symbol} tf={tf} replay={replay} setReplay={setReplay} /> : null}
      </div>
    </>
  );

  return (
    <div className={`term${narrow ? "" : " term-desk"}`} data-tv={scale > 1 ? "1" : undefined}>
      <header className="topbar">
        {mobile ? <Link href="/" aria-label="Home"><Mark size={34} /></Link> : <Brand href="/" size={34} compact={width < 1300} />}
        {!mobile ? <span className="sep" /> : null}
        <button className="symbol-btn" data-tour="market" onClick={() => setSearchOpen(true)} aria-label="Change market">
          <Icon name="search" size={16} style={{ color: "var(--text-3)", flex: "none" }} />
          <span className="sym">{display}</span>
          {meta && meta.perp ? <span className="badge violet hide-mobile">PERP</span> : null}
        </button>
        {mobile ? (
          <select className="select sm" style={{ width: 62, flex: "none", paddingLeft: 8, paddingRight: 22, backgroundPosition: "calc(100% - 13px) 50%, calc(100% - 8px) 50%" }} data-tour="timeframe" value={tf} onChange={(e) => setTf(e.target.value)} aria-label="Timeframe">
            {TFS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        ) : (
          <div className="tf-pills" data-tour="timeframe" role="radiogroup" aria-label="Timeframe">
            {TFS.map((t) => (
              <button key={t} className={tf === t ? "on" : ""} onClick={() => setTf(t)} role="radio" aria-checked={tf === t} title={TF_LABEL[t]}>{t}</button>
            ))}
          </div>
        )}
        <Link className="icon-btn" href={`/strategy?s=${encodeURIComponent(symbol)}&tf=${tf}`} data-tour="strategy"
          title="Test a strategy on this market" aria-label="Test a strategy on this market"
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="sliders" size={16} />
        </Link>
        {!mobile ? (
          <>
            <span className="sep" />
            <div style={{ position: "relative" }}>
              <button className="icon-btn" onClick={() => setMenu(menu === "style" ? null : "style")} title="Chart type"><Icon name="candles" /></button>
              <Menu open={menu === "style"} onClose={() => setMenu(null)} anchorStyle={{ top: 42, left: 0 }}>
                <div className="mh">Chart type</div>
                {STYLES.map(([id, label]) => (
                  <button key={id} onClick={() => { updateSettings({ candles: { style: id } }); setMenu(null); }}>
                    <Icon name={settings.candles.style === id ? "check" : "dot"} size={14} style={{ opacity: settings.candles.style === id ? 1 : 0 }} /> {label}
                  </button>
                ))}
                <hr />
                {[["volume", "Volume"], ["rsi", "RSI pane"], ["logScale", "Log scale"], ["grid", "Grid"]].map(([k, l]) => (
                  <button key={k} onClick={() => updateSettings({ chart: { [k]: !settings.chart[k] } })}>
                    <Icon name="check" size={14} style={{ opacity: settings.chart[k] ? 1 : 0 }} /> {l}
                  </button>
                ))}
                <hr />
                <Link href="/settings#chart"><Icon name="palette" size={16} /> Colours & candles…</Link>
              </Menu>
            </div>
            <div style={{ position: "relative" }}>
              <button className="icon-btn" onClick={() => setMenu(menu === "apps" ? null : "apps")} title="Workspaces"><Icon name="grid" /></button>
              <Menu open={menu === "apps"} onClose={() => setMenu(null)} anchorStyle={{ top: 42, left: 0, width: 260 }}>
                <div className="mh">Workspaces</div>
                {APP_LINKS.filter(([href]) => href !== "/terminal").map(([href, label, ic]) => (
                  <Link key={href} href={href === "/track-record" ? href : `${href}?s=${encodeURIComponent(symbol)}&tf=${tf}`}><Icon name={ic} size={16} /> {label}</Link>
                ))}
                <Link href={`/tv?s=${encodeURIComponent(symbol)}&tf=${tf}`}><Icon name="tv" size={16} /> TV / presentation mode</Link>
              </Menu>
            </div>
            <div style={{ position: "relative" }}>
              <button className="icon-btn" onClick={() => setMenu(menu === "ind" ? null : "ind")} title="Indicators"><Icon name="indicator" /></button>
              <Menu open={menu === "ind"} onClose={() => setMenu(null)} anchorStyle={{ top: 42, left: 0 }}>
                <div className="mh">Indicators</div>
                {INDICATORS.map(([k, l]) => (
                  <button key={k} onClick={() => updateSettings({ indicators: { [k]: !settings.indicators[k] } })}>
                    <Icon name="check" size={14} style={{ opacity: settings.indicators[k] ? 1 : 0 }} /> {l}
                  </button>
                ))}
                <button onClick={() => updateSettings({ chart: { rsi: !settings.chart.rsi } })}>
                  <Icon name="check" size={14} style={{ opacity: settings.chart.rsi ? 1 : 0 }} /> RSI 14 (pane)
                </button>
              </Menu>
            </div>
          </>
        ) : null}
        <div className="grow" />
        {!mobile && ent && ent.tier === "trial" ? <Link href="/billing" className="trial-chip hide-mobile" title="Your free trial">✦ Trial · {ent.trial_days_left}d left</Link> : null}
        {!mobile && user && user.streak_days > 1 ? <span className="streak hide-mobile" title="Days in a row"><Icon name="flame" size={15} /> {user.streak_days}</span> : null}
        {!mobile ? (
          <button className="btn sm hide-mobile" onClick={() => setReview({ open: true, prefill: null })} title="Grade your own trade idea"><Icon name="review" size={15} /> Review</button>
        ) : null}
        <button className={`btn primary analyse-btn ${busy ? "busy" : ""}`} data-tour="analyse" onClick={analyse} disabled={busy || !!chartState.error} title="Analyse this chart (A)">
          {busy ? <span className="spinner" /> : <Icon name="zap" size={17} />}
          <span className="hide-mobile">{busy ? "Analysing" : "Analyse"}</span>
        </button>
        {narrow && !mobile ? (
          <button className="icon-btn" onClick={() => setPanelOpen(!panelOpen)} title="Panel"><Icon name="menu" /></button>
        ) : null}
        <AlertsBell symbol={symbol} tf={tf} price={meta ? meta.price : null} decimals={meta ? meta.decimals : 2} onLimit={(e) => setPaywall({ message: e.message, detail: e.detail })} />
        <div style={{ position: "relative" }}>
          <button className="avatar" style={{ cursor: "pointer", padding: 0 }} onClick={() => setMenu(menu === "me" ? null : "me")} aria-label="Account menu">
            {user && user.avatar_url ? <img src={user.avatar_url} alt="" referrerPolicy="no-referrer" /> : initials(user && user.name)}
          </button>
          <Menu open={menu === "me"} onClose={() => setMenu(null)} anchorStyle={{ top: 44, right: 0 }}>
            <div style={{ padding: "8px 10px" }}>
              <b>{user && user.name}</b>
              <div className="faint" style={{ fontSize: "0.8rem" }}>{user && user.email}</div>
              {ent ? <div style={{ marginTop: 6 }}><span className="badge brand" style={{ textTransform: "capitalize" }}>{ent.tier}{ent.tier === "trial" ? ` · ${ent.trial_days_left} days left` : ""}</span></div> : null}
            </div>
            <hr />
            <Link href={`/practice?s=${encodeURIComponent(symbol)}&tf=${["15m", "1h", "4h", "1D"].includes(tf) ? tf : "1h"}`}><Icon name="target" size={16} /> Draw & score this chart</Link>
            <Link href={`/strategy?s=${encodeURIComponent(symbol)}&tf=${tf}`}><Icon name="sliders" size={16} /> Strategy lab</Link>
            <Link href="/track-record"><Icon name="shield" size={16} /> Track record</Link>
            <hr />
            {mobile ? <button onClick={() => { setMenu(null); setReview({ open: true, prefill: null }); }}><Icon name="review" size={16} /> Review a trade</button> : null}
            {mobile ? <button onClick={() => { setMenu(null); openTab("news"); }}><Icon name="news" size={16} /> News & calendar</button> : null}
            <Link href="/settings"><Icon name="settings" size={16} /> Settings</Link>
            <Link href="/billing"><Icon name="card" size={16} /> Plan & billing</Link>
            <Link href={`/tv?s=${encodeURIComponent(symbol)}&tf=${tf}`}><Icon name="tv" size={16} /> TV / presentation mode</Link>
            {user && user.role === "admin" ? <Link href="/admin"><Icon name="shield" size={16} /> Admin</Link> : null}
            <hr />
            <button onClick={() => { setMenu(null); screenshot(); }}><Icon name="camera" size={16} /> Save chart image</button>
            {!mobile ? <button onClick={() => { setMenu(null); goFullscreen(); }}><Icon name={fullscreen ? "minimize" : "maximize"} size={16} /> {fullscreen ? "Exit full screen" : "Full screen"}</button> : null}
            <button onClick={() => updateSettings({ theme: settings.theme === "light" ? "dark" : "light" })}>
              <Icon name={settings.theme === "light" ? "moon" : "sun"} size={16} /> {settings.theme === "light" ? "Dark" : "Light"} interface
            </button>
            <hr />
            <button onClick={logout}><Icon name="logout" size={16} /> Sign out</button>
          </Menu>
        </div>
        <SymbolSearch open={searchOpen} onClose={() => setSearchOpen(false)} onPick={pickSymbol} watchlist={watch} onToggleWatch={toggleWatch} />
      </header>

      <div className={`term-body ${panelHidden && !narrow ? "no-panel" : ""}`}>
        {!mobile ? (
          <DrawToolbar tool={tool} setTool={setTool} magnet={magnet} setMagnet={setMagnet} visible={drawVisible} setVisible={setDrawVisible}
            onUndo={() => eng.current && eng.current.undo()} onRedo={() => eng.current && eng.current.redo()}
            onClear={() => { if (window.confirm("Remove all your drawings on this chart?")) eng.current && eng.current.clearDrawings(); }} />
        ) : null}
        <div className="chart-wrap" style={{ "--chart-bg": theme.bg }}>
          <ChartView onReady={onReady} onEvent={onEvent} scale={scale} />
          <div className="legend">
            <div className="l1">
              <b>{display}</b><span className="faint">{TF_LABEL[tf]}{meta ? ` · ${meta.source}` : ""}</span>
            </div>
            {legendCandle ? (
              <div className="ohlc num">
                <span>O <i>{fmtPrice(legendCandle.o, dec)}</i></span><span>H <i>{fmtPrice(legendCandle.h, dec)}</i></span>
                <span>L <i>{fmtPrice(legendCandle.l, dec)}</i></span><span>C <i>{fmtPrice(legendCandle.c, dec)}</i></span>
                {dayChange !== null ? <span className={dayChange >= 0 ? "up" : "down"}>{fmtChange(dayChange)}</span> : null}
              </div>
            ) : null}
            {hover && !mobile ? (
              <div className="ind num">
                {settings.indicators.ema50 && hover.ema50 ? <span style={{ color: "rgba(255,213,79,.9)" }}>EMA50 {fmtPrice(hover.ema50, dec)}</span> : null}
                {settings.indicators.ema200 && hover.ema200 ? <span style={{ color: "#b39dff" }}>EMA200 {fmtPrice(hover.ema200, dec)}</span> : null}
                {settings.chart.rsi && hover.rsi ? <span style={{ color: "#b388ff" }}>RSI {hover.rsi.toFixed(1)}</span> : null}
              </div>
            ) : null}
          </div>
          {selDrawing ? (
            <StyleBar drawing={selDrawing} onStyle={(s) => eng.current && eng.current.updateSelected({ style: s })}
              onDelete={() => eng.current && eng.current.deleteSelected()} onClone={() => eng.current && eng.current.cloneSelected()}
              onLock={() => eng.current && eng.current.updateSelected({ locked: !selDrawing.locked })} onReview={reviewFromDrawing}
              onEditText={() => setTextEdit({ id: selDrawing.id, value: selDrawing.style.text || "" })} />
          ) : null}
          <div className="chart-fab">
            {mobile ? (
              <button className={`icon-btn glass ${drawMobile ? "active" : ""}`} onClick={() => setDrawMobile(!drawMobile)} aria-label="Drawing tools"><Icon name="pen" /></button>
            ) : null}
            {res ? (
              <div className="seg brand glass detail-seg" title="How much the analyst draws">
                {[[1, mobile ? "Key" : "Essentials"], [2, mobile ? "More" : "Normal"], [3, "All"]].map(([n, l]) => (
                  <button key={n} className={detail === n ? "on" : ""} onClick={() => setDetail(n)}>{l}</button>
                ))}
              </div>
            ) : null}
            {!mobile && panelHidden ? (
              <button className="btn sm glass" onClick={() => setPanelHidden(false)}><Icon name="chevronLeft" size={15} /> Panel</button>
            ) : null}
          </div>
          {mobile ? (
            <DrawToolbar tool={tool} setTool={setTool} magnet={magnet} setMagnet={setMagnet} visible={drawVisible} setVisible={setDrawVisible}
              onUndo={() => eng.current && eng.current.undo()} onRedo={() => eng.current && eng.current.redo()} mobileHidden={!drawMobile}
              onClear={() => { if (window.confirm("Remove all your drawings on this chart?")) eng.current && eng.current.clearDrawings(); }} />
          ) : null}
          {busy ? (
            <>
              <div className="scanline" />
              <div className="analysing-card glass"><span className="spinner dark" /> {ANALYSIS_STEPS[step]}…</div>
            </>
          ) : null}
          {chartState.loading ? (
            <div className="chart-msg"><div><span className="spinner dark" style={{ width: 28, height: 28, margin: "0 auto" }} /></div></div>
          ) : null}
          {chartState.error ? (
            <div className="chart-msg">
              <div className="card">
                <Icon name="alert" size={30} style={{ margin: "0 auto 8px", color: "var(--warn)" }} />
                <b>{symbol} isn't loading</b>
                <p className="muted" style={{ fontSize: "0.9rem" }}>{chartState.error}</p>
                <div className="row" style={{ justifyContent: "center", gap: 8 }}>
                  <button className="btn sm" onClick={() => loadChart(symbol, tf, replayRef.current)}>Try again</button>
                  <button className="btn sm primary" onClick={() => setSearchOpen(true)}>Search markets</button>
                </div>
              </div>
            </div>
          ) : null}
          {mobile && res && !panelOpen && !busy ? (
            <button className={`verdict ${vTone}`} onClick={() => openTab("analysis")}
              style={{ position: "absolute", left: 10, right: 10, bottom: drawMobile ? 92 : 34, zIndex: 8, textAlign: "left", padding: 12, color: "var(--text)",
                backgroundColor: "var(--panel-solid)", boxShadow: "var(--shadow)" }}>
              <div className="row">
                <div className="grow">
                  <b style={{ fontFamily: "var(--font-display)" }}>{res.verdict.action}</b>
                  {res.plan ? (
                    <div className="num faint" style={{ fontSize: "0.8rem" }}>
                      EP {fmtPrice(res.plan.entry, dec)} · SL {fmtPrice(res.plan.sl, dec)} · TP {fmtPrice(res.plan.tps[0], dec)}
                    </div>
                  ) : null}
                </div>
                <span className={`grade ${gradeClass(res.verdict.grade)}`} style={{ width: 36, height: 36 }}>{res.verdict.grade}</span>
              </div>
            </button>
          ) : null}
          {meta && !chartState.loading ? (
            <div className="chart-status hide-mobile">
              {replay ? (
                <>
                  <span className="live-dot" style={{ background: "var(--warn)" }} /> Replay · {utcLabel(replay.at)}{replay.ahead ? " · future shown" : " · future hidden"}
                  <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setReplay(null)}>Back to live</button>
                </>
              ) : (
                <><span className="live-dot" /> Live · {meta.source}</>
              )}
            </div>
          ) : null}
        </div>
        <aside className={`rpanel ${panelVisible ? "open" : ""}`} aria-label="Analysis and tools" style={!narrow && panelHidden ? { display: "none" } : undefined}>
          {panelContent}
        </aside>
        {!narrow ? (
          <nav className="widget-bar" aria-label="Panels">
            {TABS.map(([id, label, icon]) => {
              const on = tab === id && !panelHidden;
              return (
                <button key={id} title={label} aria-label={label} aria-pressed={on} className={on ? "on" : ""}
                  onClick={() => { if (on) setPanelHidden(true); else { setTab(id); setPanelHidden(false); } }}>
                  <Icon name={icon} size={18} />
                </button>
              );
            })}
            <span className="grow" />
            <button title={panelHidden ? "Show panel" : "Hide panel"} aria-label={panelHidden ? "Show panel" : "Hide panel"} onClick={() => setPanelHidden(!panelHidden)}>
              <Icon name={panelHidden ? "chevronLeft" : "chevronRight"} size={16} />
            </button>
          </nav>
        ) : null}
      </div>

      {!narrow ? (
        <footer className="term-status">
          <span className="live-dot" style={replay ? { background: "var(--warn)" } : undefined} />
          <span>{replay ? `Replay · ${utcLabel(replay.at)}` : "Live"}</span>
          {meta ? <span className="faint">{meta.source}</span> : null}
          <span className="grow" />
          <span className="faint">{display} · {TF_LABEL[tf]}</span>
        </footer>
      ) : null}

      {mobile ? (
        <nav className="bottom-nav" aria-label="Sections">
          <button className={!panelOpen ? "on" : ""} onClick={() => setPanelOpen(false)}><Icon name="candles" /> Chart</button>
          <button className={panelOpen && tab === "analysis" ? "on" : ""} onClick={() => openTab("analysis")}><Icon name="target" /> Analysis</button>
          <button className="fab" data-tour="analyse" onClick={analyse} aria-label="Analyse"><span className="ring">{busy ? <span className="spinner" /> : <Icon name="zap" size={24} />}</span></button>
          <button className={panelOpen && tab === "ai" ? "on" : ""} onClick={() => openTab("ai")}><Icon name="sparkles" /> StreixAI</button>
          <button className={panelOpen && tab === "watchlist" ? "on" : ""} onClick={() => openTab("watchlist")}><Icon name="list" /> Watchlist</button>
        </nav>
      ) : null}

      <ReviewModal open={review.open} onClose={() => setReview({ open: false, prefill: null })} symbol={symbol} tf={tf} prefill={review.prefill}
        price={meta && meta.price} decimals={dec} settings={settings} onLimit={showLimit} onShowOnChart={placeTrade} />
      <Paywall open={!!paywall} onClose={() => setPaywall(null)} info={paywall} />
      <Modal open={!!textEdit} onClose={() => {
        if (textEdit && eng.current) {
          const d = eng.current.drawings.find((x) => x.id === textEdit.id);
          if (d && d.type === "text" && !d.style.text) eng.current.setText(textEdit.id, "");
        }
        setTextEdit(null);
      }} title="Label">
        {textEdit ? (
          <form onSubmit={(e) => {
            e.preventDefault();
            if (eng.current) {
              eng.current.select(textEdit.id);
              const d = eng.current.drawings.find((x) => x.id === textEdit.id);
              if (d && d.type === "text") eng.current.setText(textEdit.id, textEdit.value.trim());
              else eng.current.updateSelected({ style: { text: textEdit.value.trim() } });
            }
            setTextEdit(null);
          }} className="stack">
            <input className="input" autoFocus maxLength={80} value={textEdit.value} onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
              placeholder="e.g. Liquidity above — wait for the sweep" />
            <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary">Save</button></div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}

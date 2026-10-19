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
import AlertsBell, { requestAlert } from "@/components/AlertsBell";
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
import CrossMenu from "./CrossMenu";
import DivergencePanel from "./DivergencePanel";
import ReplayPanel from "./ReplayPanel";
import { chartThemeFor } from "@/lib/chartTheme";
import { CHART_TYPES } from "@/components/chart/series";
import ChartTypeSheet, { ChartTypeIcon } from "./ChartTypeSheet";
import { AnalysisHub, BrokerPanel, ComparePanel, IndicatorsPanel, LayoutPanel, LayoutsPanel, ObjectTreePanel, SymbolDetailsPanel,
  TechnicalsPanel } from "./HubPanels";

const COMPARE_COLORS = ["#f5a524", "#b78bff", "#3fb8ff", "#ff6bcb"];
const LAYOUT_KEYS = ["volume", "rsi", "logScale", "grid", "killzones", "watermark"];
const TABS = [["analysis", "Analysis", "zap"], ["replay", "Replay", "clock"], ["ai", "StreixAI", "sparkles"], ["watchlist", "Watchlist", "list"], ["news", "News", "news"], ["divergence", "Divergence", "candles"]];
const utcLabel = (iso) => `${iso.replace("T", " ").slice(0, 16)} UTC`;

// The analysis on a chart stays there until the user cleans it. The server keeps each one per symbol and timeframe;
// this browser keeps a copy as a fallback. The copy keeps only each candle's time, which is all the overlay needs.
const ANALYSES_KEY = "sa_analyses";
const ANALYSES_KEEP = 12;
const analysisKey = (sym, frame) => `${sym}|${frame}`;
function storeAnalysisLocal(sym, frame, d) {
  const all = localGet(ANALYSES_KEY, {}) || {};
  all[analysisKey(sym, frame)] = { savedAt: Date.now(), res: { ...d, candles: (d.candles || []).map((c) => [c[0]]) } };
  const kept = Object.entries(all).sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0)).slice(0, ANALYSES_KEEP);
  localSet(ANALYSES_KEY, Object.fromEntries(kept));
}
function readAnalysisLocal(sym, frame) {
  const all = localGet(ANALYSES_KEY, {}) || {};
  const e = all[analysisKey(sym, frame)];
  return e && e.res ? e.res : null;
}
function dropAnalysisLocal(sym, frame) {
  const all = localGet(ANALYSES_KEY, {}) || {};
  delete all[analysisKey(sym, frame)];
  localSet(ANALYSES_KEY, all);
}

// Candles, retried on a failed or timed-out request: one dropped connection should not leave the chart empty.
async function fetchCandles(params, tries = 3) {
  let last = null;
  for (let k = 0; k < tries; k++) {
    try {
      return await get(`/market/candles?${qs(params)}`);
    } catch (err) {
      last = err;
      const st = err instanceof ApiError ? err.status : 0;
      if ([400, 401, 402, 403, 422].includes(st) || (st === 404 && k >= 1)) throw err;
      await new Promise((r) => setTimeout(r, 600 * (k + 1)));
    }
  }
  throw last;
}

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
  const [crossMenu, setCrossMenu] = useState(null);
  const [paywall, setPaywall] = useState(null);
  const [textEdit, setTextEdit] = useState(null);
  const [pendingAsk, setPendingAsk] = useState(null);
  const [menu, setMenu] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  // TradingView-style sheets: chart types, the analysis hub and the panels it opens
  const [sheet, setSheet] = useState(null);
  const [compare, setCompare] = useState(() => (localGet("sa_compare", []) || []).filter((c) => c && c.symbol).slice(0, 4));
  const [drawList, setDrawList] = useState([]);
  const [analysisOn, setAnalysisOn] = useState(true);
  const eng = useRef(null);
  const [engReady, setEngReady] = useState(false);
  const barsRef = useRef(600);
  const loadingMore = useRef(false);
  const saveTimer = useRef(null);
  const resRef = useRef(null);
  resRef.current = res;
  const replayRef = useRef(null);
  replayRef.current = replay;
  // the analyst's setup and drawings for the replay moment, kept so they can be drawn again when a reveal reloads the chart
  const replayOverlay = useRef(null);

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
    else if (type === "crossMenu") setCrossMenu(data);
    else if (type === "toolDone") setToolState("cursor");
    else if (type === "requestText") {
      const d = eng.current && eng.current.drawings.find((x) => x.id === data);
      setTextEdit({ id: data, value: (d && d.style.text) || "" });
    } else if (type === "drawings") {
      setDrawList(data);
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
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    if (!eng.current) return;
    eng.current.setTheme(theme);
    eng.current.setOptions({ style: settings.candles.style, volume: settings.chart.volume, logScale: settings.chart.logScale, rsi: settings.chart.rsi,
      grid: settings.chart.grid, watermark: settings.chart.watermark, killzones: !!settings.chart.killzones, indicators: settings.indicators,
      minCandle: settings.chart.minCandle });
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

  // ───── the saved analysis of a chart comes back when the chart loads
  const showStoredAnalysis = useCallback((d) => {
    setRes(d);
    setStale(false);
    const ov = toOverlay(d, themeRef.current);
    setLayers(ov.layers);
    if (eng.current) eng.current.setAnalysis(ov.items, { animate: false, pins: ov.pins });
  }, []);
  const restoreAnalysis = useCallback((sym, frame) => {
    const current = () => sym === symbolRef.current && frame === tfRef.current;
    const usable = (a) => !!(a && Array.isArray(a.candles) && a.candles.length);
    get(`/user/analysis?${qs({ symbol: sym, tf: frame })}`).then((dd) => {
      if (!current()) return;
      if (dd && usable(dd.data)) {
        showStoredAnalysis(dd.data);
        storeAnalysisLocal(sym, frame, dd.data);
        return;
      }
      // nothing on the server yet (this browser may have run it before the server saved it): show and save the copy
      const local = readAnalysisLocal(sym, frame);
      if (usable(local)) {
        showStoredAnalysis(local);
        put("/user/analysis", { symbol: sym, tf: frame, data: local }).catch(() => {});
      }
    }).catch(() => {
      if (!current()) return;
      const local = readAnalysisLocal(sym, frame);
      if (usable(local)) showStoredAnalysis(local);
    });
  }, [showStoredAnalysis]);

  // ───── data loading
  const loadChart = useCallback(async (sym, frame, rp) => {
    const e = eng.current;
    if (!e) return;
    if (!rp) replayOverlay.current = null;
    setChartState({ loading: true, error: null });
    setMeta(null);          // the previous symbol's price and stats go with its chart
    e.setData([], {});      // hide the previous chart while the new one loads
    setRes(null);
    setStale(false);
    setLayers([]);
    e.clearAnalysis();
    barsRef.current = 600;
    try {
      const d = await fetchCandles(rp ? { symbol: sym, tf: frame, bars: 600, at: rp.at, ahead: rp.ahead } : { symbol: sym, tf: frame, bars: 600 });
      if (sym !== symbolRef.current || frame !== tfRef.current) return;
      e.setData(d.candles, { tfSec: d.tf_seconds, decimals: d.decimals, label: `${d.display} · ${frame}`, keepWidth: true });
      setMeta(d);
      setChartState({ loading: false, error: null });
      // a replay analysis stays on its chart, also after a reveal reloads the candles
      const ro = replayOverlay.current;
      if (rp && ro && ro.key === `${sym}|${frame}|${rp.at}`) e.setAnalysis(ro.ov.items, { animate: false, pins: ro.ov.pins });
      if (!rp) restoreAnalysis(sym, frame);
    } catch (err) {
      if (sym !== symbolRef.current) return;
      e.setData([], {});
      setMeta(null);
      setChartState({ loading: false, error: err.message || "Couldn't load this chart." });
    }
    const cached = localGet(`sa_draw_${sym}`, null);
    if (cached) e.setDrawings(cached);
    else e.setDrawings([]);
    setDrawList(e.getDrawings());
    get(`/user/drawings?${qs({ symbol: sym })}`).then((dd) => {
      if (sym !== symbolRef.current) return;
      if (dd.updated_at || !cached) {
        e.setDrawings(dd.items || []);
        setDrawList(e.getDrawings());
      }
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
      const d = await fetchCandles(rp ? { symbol: sym, tf: frame, bars: want, at: rp.at, ahead: rp.ahead } : { symbol: sym, tf: frame, bars: want }, 2);
      if (sym === symbolRef.current && frame === tfRef.current && d.candles.length > e.raw.length) {
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

  // The whole series again, keeping the view: used when live updates find candles missing (the phone slept, the tab
  // was in the background, the network dropped), so the chart never keeps a hole until it is reloaded.
  const lastResync = useRef(0);
  const resync = useCallback(async (force = false) => {
    const e = eng.current;
    if (!e || !e.raw.length || replayRef.current) return;
    const now = Date.now();
    if (!force && now - lastResync.current < 8000) return;
    lastResync.current = now;
    const sym = symbolRef.current;
    const frame = tfRef.current;
    try {
      const d = await fetchCandles({ symbol: sym, tf: frame, bars: Math.max(600, Math.min(5000, e.raw.length)) }, 2);
      if (sym !== symbolRef.current || frame !== tfRef.current || replayRef.current || !eng.current) return;
      eng.current.setData(d.candles, { tfSec: d.tf_seconds, decimals: d.decimals, keepView: true });
      setMeta((m) => (m ? { ...m, price: d.price } : m));
    } catch { /* the next live update tries again */ }
  }, []);

  // live updates
  useEffect(() => {
    if (!engReady || chartState.error || chartState.loading || !meta || replayKey !== "live") return undefined;
    const every = 5000;               // every market (crypto, forex, metals, indices, stocks) refreshes every 5 seconds
    let alive = true;
    const tick = async () => {
      if (document.hidden || !alive) return;
      try {
        const d = await get(`/market/latest?${qs({ symbol, tf })}`);
        if (!alive || !eng.current || symbolRef.current !== symbol || tfRef.current !== tf) return;
        const upd = eng.current.updateTail(d.candles);
        if (upd && upd.gap) resync();
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
    // back on the page after the phone slept or another tab was open: fill in what was missed straight away
    const onVis = () => {
      if (!document.hidden && alive) resync(true).then(tick);
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onVis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onVis);
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

  // the replay analysis is drawn on the replay chart: the setup, the levels and the drawings, like a live analysis
  const drawReplayAnalysis = (d, where) => {
    if (!d || !where) {
      replayOverlay.current = null;
      if (eng.current) eng.current.clearAnalysis();
      return;
    }
    const ov = toOverlay(d, theme);
    replayOverlay.current = { key: `${where.symbol}|${where.tf}|${where.at}`, ov };
    if (!eng.current) return;
    eng.current.setAnalysis(ov.items, { animate: true, pins: ov.pins });
    if (d.view && d.meta && d.candles && d.candles.length) {
      eng.current.panTo(d.candles[Math.max(0, d.view.x_from)][0], d.candles[d.candles.length - 1][0] + d.meta.tf_seconds * 30);
    }
  };
  const showLimit = useCallback((e) => setPaywall({ message: e.message, detail: e.detail }), []);
  const lineAt = (at, type = "hline") => {
    const e = eng.current;
    setCrossMenu(null);
    if (!e) return;
    const def = e.drawingDefaults || { color: "#2962ff", width: 2, dash: "solid" };
    e.select(e.addDrawing({ type, points: [{ t: at.time, p: at.price }], style: { ...def } }));
  };
  const alertForm = (at, op) => {
    setCrossMenu(null);
    requestAlert({ symbol: symbolRef.current, tf: tfRef.current, price: Number(Number(at.price).toFixed(at.decimals ?? 2)), op });
  };
  const copyPrice = async (at) => {
    setCrossMenu(null);
    const p = Number(at.price).toFixed(at.decimals ?? 2);
    try {
      await navigator.clipboard.writeText(p);
      toast(`${p} copied`, "success", 1800);
    } catch {
      toast(p, "info");
    }
  };
  const alertAt = async (at, op) => {
    setCrossMenu(null);
    const price = Number(Number(at.price).toFixed(at.decimals ?? 2));
    try {
      await post("/alerts", { kind: "price", symbol: symbolRef.current, op, price });
      toast(`Alert set: ${op === "above" ? "rises above" : "falls below"} ${price}`, "success");
    } catch (ex) {
      if (ex instanceof ApiError && (ex.status === 402 || ex.status === 429)) showLimit(ex);
      else toast(ex.message || "The alert couldn't be set.", "error");
    }
  };

  const analyse = useCallback(async () => {
    if (replayRef.current) {
      // in a replay the analysis runs for that moment, from the Replay tab
      setTab("replay");
      setPanelOpen(true);
      setPanelHidden(false);
      toast("Press Analyse this moment in the Replay tab.", "info");
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
      // saved for its chart even if the user has moved on, so it is there when they come back
      storeAnalysisLocal(symbol, tf, d);
      put("/user/analysis", { symbol, tf, data: d }).catch(() => {});
      if (symbolRef.current !== symbol || tfRef.current !== tf) return;
      setRes(d);
      setStale(false);
      const ov = toOverlay(d, theme);
      setLayers(ov.layers);
      eng.current.setAnalysis(ov.items, { animate: a.animate !== false, pins: ov.pins });
      if (d.view && d.candles && d.candles.length) {
        const from = d.candles[Math.max(0, Math.min(d.candles.length - 1, d.view.x_from))][0];
        const last = d.candles[d.candles.length - 1][0];
        eng.current.panTo(from, last + ((d.meta && d.meta.tf_seconds) || 3600) * 30);
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

  // Clean analysis: the only thing that removes an analysis from its chart
  const cleanAnalysis = useCallback(() => {
    const sym = symbolRef.current;
    const frame = tfRef.current;
    setRes(null);
    setStale(false);
    setLayers([]);
    if (eng.current) eng.current.clearAnalysis();
    dropAnalysisLocal(sym, frame);
    del(`/user/analysis?${qs({ symbol: sym, tf: frame })}`).catch(() => {});
    toast("Analysis cleaned from this chart.", "info");
  }, [toast]);

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
    if (!eng.current || !eng.current.raw.length) return;
    const last = eng.current.raw[eng.current.raw.length - 1].t;
    const step = (meta && meta.tf_seconds) || 3600;
    const id = eng.current.addDrawing({ type: side === "short" ? "short" : "long", points: [{ t: last, p: entry }, { t: last + step * 24, p: sl }, { t: last + step * 24, p: tp }], style: {} });
    eng.current.select(id);
  };

  // The AI plan becomes a trade on the chart, with the entry, stop and target as handles the person can drag.
  // Review (on the trade's toolbar) then grades the levels as they are now.
  const editPlan = (p) => {
    const tps = p.tps || [];
    const tp = tps[Math.min(1, tps.length - 1)];
    if (!p.entry || !p.sl || !tp) {
      toast("This plan has no entry, stop and target to edit yet.", "info");
      return;
    }
    placeTrade({ side: p.side, entry: p.entry, sl: p.sl, tp });
    if (narrow) setPanelOpen(false);
    toast("Drag the entry, stop or target to change the plan, then tap Review to grade your edits.", "info");
  };

  // ───── compare: other markets drawn over this one, on the same timeframe (and the same replay moment)
  const compareKey = compare.map((c) => c.symbol).join(",");
  useEffect(() => {
    localSet("sa_compare", compare.map(({ symbol: s0, color }) => ({ symbol: s0, color })));
    if (!engReady || !eng.current) return undefined;
    if (!compare.length) {
      eng.current.setCompare([]);
      return undefined;
    }
    let alive = true;
    const rp = replayRef.current;
    Promise.all(compare.map((c) => fetchCandles(rp ? { symbol: c.symbol, tf, bars: 600, at: rp.at, ahead: rp.ahead } : { symbol: c.symbol, tf, bars: 600 }, 2)
      .then((d) => ({ ...c, rows: d.candles, label: d.display, error: null }))
      .catch((err) => ({ ...c, rows: [], error: err.message || "not available" }))))
      .then((list) => {
        if (!alive || !eng.current) return;
        eng.current.setCompare(list);
        const bad = list.filter((c) => c.error);
        if (bad.length) setCompare((cs) => cs.map((c) => ({ ...c, error: (bad.find((b) => b.symbol === c.symbol) || {}).error || null })));
      });
    return () => { alive = false; };
  }, [engReady, compareKey, tf, replayKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const addCompare = (s0) => {
    const c = cleanSymbol(s0);
    if (!c || c === symbol || compare.some((x) => x.symbol === c)) return;
    const used = new Set(compare.map((x) => x.color));
    setCompare([...compare, { symbol: c, color: COMPARE_COLORS.find((x) => !used.has(x)) || COMPARE_COLORS[0] }].slice(0, 4));
  };
  const removeCompare = (s0) => setCompare(compare.filter((c) => c.symbol !== s0));

  // ───── chart layouts: the market, timeframe, chart type, indicators, panes and compared markets, saved by name
  const layouts = settings.layouts || [];
  const snapshot = () => ({
    symbol, tf, style: settings.candles.style, indicators: { ...settings.indicators },
    chart: Object.fromEntries(LAYOUT_KEYS.map((k) => [k, !!settings.chart[k]])), compare: compare.map((c) => c.symbol),
  });
  const saveLayoutAs = (name) => {
    const id = `l${Date.now().toString(36)}`;
    const next = [...layouts.filter((l) => l.name !== name), { id, name, ...snapshot(), savedAt: Date.now() }].slice(-12);
    updateSettings({ layouts: next, currentLayout: id });
    toast(`Layout “${name}” saved.`, "success");
    setSheet(null);
  };
  const saveLayout = () => {
    const cur = layouts.find((l) => l.id === settings.currentLayout);
    if (!cur) {
      setSheet("layouts");
      return;
    }
    updateSettings({ layouts: layouts.map((l) => (l.id === cur.id ? { ...l, ...snapshot(), savedAt: Date.now() } : l)) });
    toast(`Layout “${cur.name}” saved.`, "success");
    setSheet(null);
  };
  const openLayout = (l) => {
    updateSettings({ currentLayout: l.id, candles: { style: l.style || "candles" }, indicators: { ...l.indicators }, chart: { ...l.chart } });
    setCompare((l.compare || []).slice(0, 4).map((s0, i) => ({ symbol: s0, color: COMPARE_COLORS[i] })));
    if (l.symbol) setSymbol(cleanSymbol(l.symbol));
    if (l.tf && TFS.includes(l.tf)) setTf(l.tf);
    setSheet(null);
    toast(`Opened “${l.name}”.`, "info", 2200);
  };
  const newLayout = () => {
    updateSettings({ currentLayout: null, candles: { style: "candles" }, indicators: { ema20: false, ema50: true, ema200: true, bb: false, vwap: false },
      chart: { volume: true, rsi: false, logScale: false, grid: false, killzones: false, watermark: true } });
    setCompare([]);
    if (eng.current) eng.current.resetView();
    setSheet(null);
    toast("New layout: candles, default indicators. Save it from the hub when you're done.", "info");
  };
  const deleteLayout = (id) => updateSettings({ layouts: layouts.filter((l) => l.id !== id), currentLayout: settings.currentLayout === id ? null : settings.currentLayout });
  const renameLayout = (id, name) => updateSettings({ layouts: layouts.map((l) => (l.id === id ? { ...l, name } : l)) });

  // ───── indicator templates
  const templates = settings.indicatorTemplates || [];
  const saveTemplate = (name) => {
    const next = [...templates.filter((t) => t.name !== name), { name, indicators: { ...settings.indicators }, rsi: !!settings.chart.rsi }].slice(-12);
    updateSettings({ indicatorTemplates: next });
    toast(`Indicator set “${name}” saved.`, "success", 2200);
  };
  const applyTemplate = (t) => {
    updateSettings({ indicators: { ...t.indicators }, chart: { rsi: !!t.rsi } });
    toast(`“${t.name}” applied.`, "info", 2000);
  };
  const deleteTemplate = (name) => updateSettings({ indicatorTemplates: templates.filter((t) => t.name !== name) });

  // ───── publish an idea: the chart as a picture, shared with the phone's share sheet (or saved), with the plan
  const publish = async () => {
    if (!eng.current) return;
    setSheet(null);
    const url = eng.current.screenshot();
    const plan = res && res.plan;
    const text = [`${(meta && meta.display) || symbol} · ${tf} · StreixAnalyst`,
      res ? `${res.verdict.action}${plan ? ` · EP ${fmtPrice(plan.entry, dec)} · SL ${fmtPrice(plan.sl, dec)} · TP ${fmtPrice(plan.tps[0], dec)}` : ""}` : null]
      .filter(Boolean).join("\n");
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], `${symbol}-${tf}-idea.png`, { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text, title: `${symbol} ${tf} idea` });
        return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = `${symbol}-${tf}-idea.png`;
    a.click();
    try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
    toast("Chart image saved, and the idea's text copied to share.", "success");
  };

  const pickType = (id) => {
    updateSettings({ candles: { style: id } });
    setSheet(null);
  };
  const objectAct = {
    select: (id) => { if (eng.current) eng.current.select(id); setSheet(null); },
    toggle: (id, hidden) => eng.current && eng.current.updateDrawing(id, { hidden }),
    lock: (id, locked) => eng.current && eng.current.updateDrawing(id, { locked }),
    del: (id) => eng.current && eng.current.deleteDrawing(id),
  };
  const toggleAnalysis = () => {
    const on = !analysisOn;
    setAnalysisOn(on);
    if (eng.current) eng.current.setAnalysisVisible(on);
  };
  const back = () => setSheet("hub");
  const typeLabel = (CHART_TYPES.find((t) => t.id === settings.candles.style) || {}).label || "Candles";

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
          <AnalysisPanel res={res} busy={busy} step={step} steps={ANALYSIS_STEPS} onAnalyse={analyse} onAsk={ask} onClean={cleanAnalysis} onUpgrade={() => setPaywall({ message: "Upgrade to Pro for both report styles and the model statistics." })}
            hiddenLayers={hiddenLayers} toggleLayer={toggleLayer} layers={layers} detail={detail} setDetail={setDetail} showAlt={showAlt}
            setShowAlt={(b) => { setShowAlt(b); updateSettings({ analysis: { showAlt: b } }); }} stale={stale} symbolLabel={display} tf={tf} symbol={symbol}
            onEditPlan={editPlan} />
        ) : null}
        {tab === "ai" ? (
          <AIChat symbol={symbol} tf={tf} analysisId={res && res.analysis_id} pending={pendingAsk} clearPending={() => setPendingAsk(null)} onLimit={showLimit} />
        ) : null}
        {tab === "watchlist" ? (
          <Watchlist symbols={watch} current={symbol} onPick={pickSymbol} onRemove={(s) => toggleWatch(s, false)} onAdd={() => setSearchOpen(true)} onMove={moveWatch} />
        ) : null}
        {tab === "news" ? <NewsPanel symbol={symbol} tf={tf} /> : null}
        {tab === "divergence" ? <DivergencePanel symbol={symbol} tf={tf} /> : null}
        {tab === "replay" ? <ReplayPanel symbol={symbol} tf={tf} replay={replay} setReplay={setReplay} onAnalysis={drawReplayAnalysis} /> : null}
      </div>
    </>
  );

  return (
    <div className={`term${narrow ? "" : " term-desk"}`} data-tv={scale > 1 ? "1" : undefined}>
      <header className="topbar">
        {mobile ? (width >= 400 ? <Link href="/" aria-label="Home"><Mark size={34} /></Link> : null) : <Brand href="/" size={34} compact={width < 1300} />}
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
        {!mobile ? (
          <Link className="icon-btn" href={`/strategy?s=${encodeURIComponent(symbol)}&tf=${tf}`} data-tour="strategy"
            title="Test a strategy on this market" aria-label="Test a strategy on this market"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="sliders" size={16} />
          </Link>
        ) : null}
        <button className="icon-btn" onClick={() => setSheet("types")} title={`Chart type: ${typeLabel}`} aria-label={`Chart type: ${typeLabel}`}>
          <ChartTypeIcon id={settings.candles.style} size={19} />
        </button>
        <button className="icon-btn" onClick={() => setSheet("hub")} title="Analysis hub" aria-label="Analysis hub" data-tour="hub">
          <Icon name="more" />
        </button>
        {!mobile ? (
          <>
            <span className="sep" />
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
            <button className="icon-btn" onClick={() => setSheet("indicators")} title="Indicators" aria-label="Indicators"><Icon name="indicator" /></button>
          </>
        ) : null}
        <div className="grow" />
        {!mobile && ent && ent.tier === "trial" ? <Link href="/billing" className="trial-chip hide-mobile" title="Your free trial">✦ Trial · {ent.trial_days_left}d left</Link> : null}
        {!mobile && user && user.streak_days > 1 ? <span className="streak hide-mobile" title="Days in a row"><Icon name="flame" size={15} /> {user.streak_days}</span> : null}
        {!mobile ? (
          <button className="btn sm hide-mobile" onClick={() => setReview({ open: true, prefill: null })} title="Grade your own trade idea"><Icon name="review" size={15} /> Review</button>
        ) : null}
        {!mobile ? (
          <button className={`btn primary analyse-btn ${busy ? "busy" : ""}`} data-tour="analyse" onClick={analyse} disabled={busy || !!chartState.error} title="Analyse this chart (A)">
            {busy ? <span className="spinner" /> : <Icon name="zap" size={17} />}
            <span>{busy ? "Analysing" : "Analyse"}</span>
          </button>
        ) : null}
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
                {settings.indicators.ema50 && hover.ema50 ? <span style={{ color: "#ffb020" }}>EMA50 {fmtPrice(hover.ema50, dec)}</span> : null}
                {settings.indicators.ema200 && hover.ema200 ? <span style={{ color: "#b78bff" }}>EMA200 {fmtPrice(hover.ema200, dec)}</span> : null}
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
          {/* size the chart like TradingView: width is the candles along time, height is the price scale */}
          <div className="seg brand glass chart-zoom" role="group" aria-label="Chart size">
            <button onClick={() => eng.current && eng.current.zoom(0.8)} title="Narrower candles" aria-label="Narrower candles">↔−</button>
            <button onClick={() => eng.current && eng.current.zoom(1.25)} title="Wider candles" aria-label="Wider candles">↔+</button>
            <i className="zsep" />
            <button onClick={() => eng.current && eng.current.zoomY(0.8)} title="Shorter price scale (zoom out)" aria-label="Shorter price scale">↕−</button>
            <button onClick={() => eng.current && eng.current.zoomY(1.25)} title="Taller price scale (zoom in)" aria-label="Taller price scale">↕+</button>
            <i className="zsep" />
            <button onClick={() => eng.current && eng.current.resetView()} title="Fit the chart" aria-label="Fit the chart"><Icon name="fit" size={14} /></button>
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
            <div className="chart-msg chart-loading" role="status" aria-live="polite">
              <div className="chart-loading-card">
                <span className="spinner dark" style={{ width: 26, height: 26 }} />
                <b>{symbol.split(":").pop()} · {TF_LABEL[tf] || tf}</b>
                <span className="muted" style={{ fontSize: "0.88rem" }}>Loading the latest candles…</span>
              </div>
            </div>
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
        <aside className={`rpanel ${panelVisible ? "open" : ""} ${narrow && tab === "replay" ? "sheet" : ""}`} aria-label="Analysis and tools" style={!narrow && panelHidden ? { display: "none" } : undefined}>
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
          <button className={!panelOpen ? "on" : ""} onClick={() => setPanelOpen(false)}><Icon name="candles" /><span>Chart</span></button>
          <button className={panelOpen && tab === "watchlist" ? "on" : ""} onClick={() => openTab("watchlist")}><Icon name="list" /><span>Watchlist</span></button>
          <button className="fab" data-tour="analyse" onClick={analyse} aria-label="Analyse"><span className="ring">{busy ? <span className="spinner" /> : <Icon name="zap" size={20} />}</span><span>Analyse</span></button>
          <button className={panelOpen && tab === "replay" ? "on" : ""} onClick={() => openTab("replay")}><Icon name="clock" /><span>Replay</span></button>
          <button className={panelOpen && tab === "ai" ? "on" : ""} onClick={() => openTab("ai")}><Icon name="sparkles" /><span>StreixAI</span></button>
        </nav>
      ) : null}

      <CrossMenu at={crossMenu} onClose={() => setCrossMenu(null)} onLine={(at) => lineAt(at, "hline")} onRay={(at) => lineAt(at, "hray")}
        onAlert={alertAt} onAlertForm={alertForm} onCopy={copyPrice} symbolLabel={display} last={meta ? meta.price : null} />
      <ChartTypeSheet open={sheet === "types"} onClose={() => setSheet(null)} value={settings.candles.style} onPick={pickType}
        favorites={settings.chartFavorites || []} onFavorites={(f) => updateSettings({ chartFavorites: f })}
        onUnavailable={(t) => toast(t.needs, "info", 6000)} tipSeen={!!settings.chartTypeTipSeen} onTipSeen={() => updateSettings({ chartTypeTipSeen: true })} />
      <AnalysisHub open={sheet === "hub"} onClose={() => setSheet(null)} go={setSheet} symbol={symbol} tf={tf}
        act={{ newLayout, saveLayout, publish, note: (m) => toast(m, "info", 6000),
          alerts: () => { setSheet(null); requestAlert({ list: true }); },
          replay: () => { setSheet(null); openTab("replay"); } }} />
      <LayoutPanel open={sheet === "layout"} onClose={() => setSheet(null)} onBack={back} settings={settings} update={updateSettings}
        panelHidden={panelHidden} setPanelHidden={setPanelHidden} narrow={narrow} />
      <LayoutsPanel open={sheet === "layouts"} onClose={() => setSheet(null)} onBack={back} layouts={layouts} current={settings.currentLayout}
        onOpen={openLayout} onDelete={deleteLayout} onSaveAs={saveLayoutAs} onRename={renameLayout} />
      <IndicatorsPanel open={sheet === "indicators" || sheet === "templates"} templatesOnly={sheet === "templates"} onClose={() => setSheet(null)} onBack={back}
        settings={settings} update={updateSettings} templates={templates} onSaveTemplate={saveTemplate} onApplyTemplate={applyTemplate} onDeleteTemplate={deleteTemplate} />
      <ComparePanel open={sheet === "compare"} onClose={() => setSheet(null)} onBack={back} compare={compare} onAdd={addCompare} onRemove={removeCompare} symbol={display} />
      <ObjectTreePanel open={sheet === "objects"} onClose={() => setSheet(null)} onBack={back} drawings={drawList} decimals={dec}
        onSelect={objectAct.select} onToggle={objectAct.toggle} onLock={objectAct.lock} onDelete={objectAct.del}
        hasAnalysis={!!res} analysisOn={analysisOn} onAnalysis={toggleAnalysis} />
      <SymbolDetailsPanel open={sheet === "details"} onClose={() => setSheet(null)} onBack={back} meta={meta} symbol={symbol} tf={tf} />
      <TechnicalsPanel open={sheet === "technicals"} onClose={() => setSheet(null)} onBack={back} candles={eng.current ? eng.current.raw : []}
        symbol={display} tf={tf} decimals={dec} />
      <BrokerPanel open={sheet === "broker"} onClose={() => setSheet(null)} onBack={back} meta={meta} symbol={display} plan={res && res.plan} decimals={dec} toast={toast} />
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

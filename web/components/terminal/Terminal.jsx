"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Icon from "@/components/Icons";
import Brand from "@/components/Brand";
import ChartView from "@/components/chart/ChartView";
import { useAuth } from "@/components/Providers";
import { Menu, Modal } from "@/components/ui";
import Paywall from "@/components/Paywall";
import AlertsBell, { requestAlert } from "@/components/AlertsBell";
import StrategyPicker from "@/components/StrategyPicker";
import { ApiError, del, get, post, put, qs } from "@/lib/api";
import { aiToDrawings, ANALYSIS_STEPS, gradeClass, toOverlay, toUserDrawings, verdictTone } from "@/lib/analysis";
import { ALL_TFS, analysisTf, cleanSymbol, fmtChange, fmtPrice, initials, TF_LABEL, TFS } from "@/lib/format";
import { localGet, localSet } from "@/lib/settings";
import SymbolSearch from "./SymbolSearch";
import { StyleBar, TOOL_KEYS } from "./DrawTools";
import { DrawingStudio, ToolDock } from "./DrawingStudio";
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
import { BrokerPanel, ComparePanel, LayoutPanel, LayoutsPanel, ObjectTreePanel, SymbolDetailsPanel, TechnicalsPanel } from "./HubPanels";
import Toolbox from "./Toolbox";
import IntervalSheet, { IntervalChip } from "./IntervalSheet";
import IndicatorSheet from "./IndicatorSheet";
import { ExplainCard, FromHereChip, WhatIfSheet } from "./ChartNotes";
import ChartHud, { hudOf } from "./ChartHud";
import FullAnalysis from "./FullAnalysis";

const COMPARE_COLORS = ["#f5a524", "#b78bff", "#3fb8ff", "#ff6bcb"];
const LAYOUT_KEYS = ["volume", "rsi", "logScale", "grid", "killzones", "watermark"];
const TABS = [["analysis", "Analyst", "zap"], ["replay", "Replay", "play"], ["ai", "StreixAI", "sparkles"], ["watchlist", "Watchlist", "list"], ["news", "News", "news"], ["divergence", "Divergence", "candles"]];
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

// The phone stays awake while the chart is open, when the person asked for it (Settings > Keep screen on).
function useWakeLock(on) {
  useEffect(() => {
    if (!on || typeof navigator === "undefined" || !navigator.wakeLock) return undefined;
    let lock = null;
    let alive = true;
    const take = async () => {
      try {
        if (alive && document.visibilityState === "visible") lock = await navigator.wakeLock.request("screen");
      } catch { /* not allowed */ }
    };
    take();
    const vis = () => document.visibilityState === "visible" && take();
    document.addEventListener("visibilitychange", vis);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", vis);
      if (lock) lock.release().catch(() => {});
    };
  }, [on]);
}

function StrategyChip({ user, onClick, compact }) {
  const ids = (user && user.strategies) || [];
  return (
    <button className={`strat-chip${ids.length ? "" : " empty"}`} onClick={onClick} data-tour="strategies"
      title={ids.length ? "Strategies the analyst uses" : "Pick the strategies the analyst uses"}>
      <Icon name="target" size={15} />
      {compact ? (ids.length ? <i>{ids.length}</i> : null) : <span>{ids.length ? `${ids.length} strateg${ids.length > 1 ? "ies" : "y"}` : "Pick strategies"}</span>}
    </button>
  );
}

export default function Terminal() {
  const { user, settings, updateSettings, refresh, toast, logout, can } = useAuth();
  const router = useRouter();
  const sp = useSearchParams();
  const width = useWidth();
  const mobile = width <= 760;
  const narrow = width <= 1100;
  const scale = width >= 3200 ? 1.9 : width >= 2200 ? 1.35 : 1;
  useWakeLock(!!settings.keepScreenOn);

  const [symbol, setSymbol] = useState(() => cleanSymbol(sp.get("s") || (settings.rememberChart !== false && settings.lastSymbol) || "BTCUSDT"));
  const [tf, setTf] = useState(() => (ALL_TFS.includes(sp.get("tf")) ? sp.get("tf") : ALL_TFS.includes(settings.lastTf) && settings.rememberChart !== false ? settings.lastTf : "1h"));
  const [meta, setMeta] = useState(null);
  const [chartState, setChartState] = useState({ loading: true, error: null });
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [stale, setStale] = useState(false);
  const [layers, setLayers] = useState([]);
  const [hiddenLayers, setHiddenLayers] = useState(() => new Set(localGet("sa_hidden_layers", [])));
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
  const [keepDrawing, setKeepDrawingState] = useState(false);
  const [lockedAll, setLockedAll] = useState(false);
  const [toolStyle, setToolStyleState] = useState({ emoji: "🎯", glyph: "★" });
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
  const [sheet, setSheet] = useState(null);
  const [compare, setCompare] = useState(() => (localGet("sa_compare", []) || []).filter((c) => c && c.symbol).slice(0, 4));
  const [drawList, setDrawList] = useState([]);
  const [analysisOn, setAnalysisOn] = useState(true);
  const [picker, setPicker] = useState(false);
  const [explain, setExplain] = useState(null);
  const [whatIf, setWhatIf] = useState({ open: false, busy: false, data: null, error: null });
  const [stratOverlay, setStratOverlay] = useState(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [live, setLive] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);
  const eng = useRef(null);
  const [engReady, setEngReady] = useState(false);
  const barsRef = useRef(600);
  const loadingMore = useRef(false);
  const saveTimer = useRef(null);
  const resRef = useRef(null);
  resRef.current = res;
  const replayRef = useRef(null);
  replayRef.current = replay;
  const replayOverlay = useRef(null);

  // the strategy picker: every account sees it once (new and existing) until a choice is saved
  useEffect(() => {
    if (user && user.needs_strategies) setPicker(true);
  }, [user && user.id, user && user.needs_strategies]); // eslint-disable-line react-hooks/exhaustive-deps

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
    else if (type === "explain") setExplain(data);
    else if (type === "copyLevel") copyText(data.text, data.title);
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
    // loadMore and copyText are stable via refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const tfRef = useRef(tf);
  tfRef.current = tf;
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const copyText = async (text, what) => {
    try {
      await navigator.clipboard.writeText(String(text).replace(/,/g, ""));
      toast(`${what || text} copied`, "success", 1600);
    } catch {
      toast(String(text), "info", 5000);
    }
  };

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
    if (eng.current) eng.current.setStudies(settings.studies || []);
  }, [engReady, settings.studies]);
  useEffect(() => {
    if (!eng.current || !res) return;
    const ov = toOverlay(res, theme);
    eng.current.setAnalysis(ov.items, { animate: false, pins: ov.pins });
  }, [theme]); // eslint-disable-line react-hooks/exhaustive-deps

  // analysis only (no entry/stop/target): the plan layer is hidden on the chart too
  const showLevels = settings.analysis.showLevels !== false;
  useEffect(() => {
    if (!eng.current) return;
    const h = new Set(hiddenLayers);
    if (!showLevels) h.add("plan");
    eng.current.setHiddenLayers(h);
    localSet("sa_hidden_layers", [...hiddenLayers]);
  }, [engReady, hiddenLayers, showLevels]);
  useEffect(() => {
    if (eng.current) eng.current.setShowAlt(showAlt);
  }, [engReady, showAlt]);
  // the reasons on the chart (glass HUD): while they show, the chart keeps only the essential analysis drawings and a
  // plan that isn't active yet is drawn faint
  const hudOn = settings.analysis.hud !== false;
  const showHud = !!(res && hudOn && analysisOn && !busy && !replay && !chartState.loading && !chartState.error);
  useEffect(() => {
    if (!eng.current) return;
    const h = showHud ? hudOf(res) : null;
    eng.current.setDetail(h ? 1 : 2);
    eng.current.setPlanDim(false);           // the best entry leads, so its plan is drawn at full strength
  }, [engReady, showHud, res]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (eng.current) eng.current.setDrawingsVisible(drawVisible);
  }, [engReady, drawVisible]);
  // what the chosen strategies use is what the chart shows (no detail levels to pick from)
  useEffect(() => {
    if (eng.current) eng.current.setScope(res && res.layers_scope ? res.layers_scope : null);
  }, [engReady, res]);

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
    e.replayLock = false;
    if (!rp) replayOverlay.current = null;
    setChartState({ loading: true, error: null });
    setMeta(null);
    setHover(null);
    e.setData([], {});
    setRes(null);
    setStale(false);
    setLayers([]);
    setExplain(null);
    e.clearAnalysis();
    e.setStrategyOverlay(null);
    setStratOverlay(null);
    barsRef.current = 600;
    try {
      const d = await fetchCandles(rp ? { symbol: sym, tf: frame, bars: 600, at: rp.at, ahead: rp.ahead } : { symbol: sym, tf: frame, bars: 600 });
      if (sym !== symbolRef.current || frame !== tfRef.current) return;
      e.setData(d.candles, { tfSec: d.tf_seconds, decimals: d.decimals, label: `${d.display} · ${frame}`, keepWidth: true });
      setMeta(d);
      setChartState({ loading: false, error: null });
      const ro = replayOverlay.current;
      if (rp && ro && ro.key === `${sym}|${frame}|${rp.at}`) e.setAnalysis(ro.ov.items, { animate: false, pins: ro.ov.pins });
      if (!rp) restoreAnalysis(sym, analysisTf(frame));
    } catch (err) {
      if (sym !== symbolRef.current) return;
      e.setData([], {});
      setMeta(null);
      if (err instanceof ApiError && err.status === 402) {
        setPaywall({ message: err.message, detail: err.detail });
        setReplay(null);
      }
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
  }, [restoreAnalysis]);

  const loadMore = useCallback(async () => {
    const e = eng.current;
    if (!e || loadingMore.current || e.replayLock) return;
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

  // The whole series again, keeping the view: used when live updates find candles missing.
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
        if (r && r.candles && d.candles.length && r.tf === tf) {
          const lastClosedAnalysed = r.candles[r.candles.length - (r.forming ? 2 : 1)][0];
          const closedNow = d.candles[d.candles.length - 2] ? d.candles[d.candles.length - 2][0] : 0;
          if (closedNow > lastClosedAnalysed) setStale(true);
        }
      } catch { /* keep trying */ }
    };
    const t = setInterval(tick, 5000);
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

  useEffect(() => {
    if (!busy) return undefined;
    setStep(0);
    const t = setInterval(() => setStep((s) => Math.min(ANALYSIS_STEPS.length - 1, s + 1)), 650);
    return () => clearInterval(t);
  }, [busy]);

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
    eng.current.setScope(d.layers_scope || null);
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
  const copyPrice = (at) => {
    setCrossMenu(null);
    copyText(Number(at.price).toFixed(at.decimals ?? 2), `Price ${Number(at.price).toFixed(at.decimals ?? 2)}`);
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

  // "Analyse from this price": both sides from a price on the newest candle
  const runWhatIf = async (price) => {
    setCrossMenu(null);
    setWhatIf({ open: true, busy: true, data: null, error: null });
    try {
      const d = await post("/analysis/whatif", { symbol: symbolRef.current, tf: analysisTf(tfRef.current), price: Number(price) });
      setWhatIf({ open: true, busy: false, data: d, error: null });
      refresh();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 402 || e.status === 429)) {
        setWhatIf({ open: false, busy: false, data: null, error: null });
        showLimit(e);
      } else setWhatIf({ open: true, busy: false, data: null, error: e.message || "That check failed." });
    }
  };

  // `over` lets a control re-run the analysis with a setting it just changed (the target style), before the saved
  // settings come back; a click event passed in is ignored
  const analyse = useCallback(async (over) => {
    const o = over && typeof over === "object" && !over.nativeEvent && !over.target ? over : {};
    if (replayRef.current) {
      setTab("replay");
      setPanelOpen(true);
      setPanelHidden(false);
      toast("Press Analyse this moment in the Replay tab.", "info");
      return;
    }
    if (busy || !eng.current || chartState.error) return;
    const atf = analysisTf(tf);
    if (atf !== tf) toast(`The analyst reads ${atf}, the nearest standard interval to ${tf}.`, "info", 4000);
    setBusy(true);
    setTab("analysis");
    const a = settings.analysis;
    try {
      const d = await post("/analysis/run", {
        symbol, tf: atf, account: Number(a.account) || 1000, risk_pct: Number(a.risk_pct) || 1,
        leverage: a.leverage ? Number(a.leverage) : null, mode: a.mode === "auto" ? null : a.mode,
        target_mode: (o.targetMode || a.targetMode) === "winrate" ? "winrate" : "liquidity",
        drawings: toUserDrawings(eng.current.getDrawings()),
      });
      storeAnalysisLocal(symbol, atf, d);
      put("/user/analysis", { symbol, tf: atf, data: d }).catch(() => {});
      if (symbolRef.current !== symbol || tfRef.current !== tf) return;
      setRes(d);
      setStale(false);
      const ov = toOverlay(d, theme);
      setLayers(ov.layers);
      eng.current.setScope(d.layers_scope || null);
      eng.current.setAnalysis(ov.items, { animate: a.animate !== false, pins: ov.pins });
      if (d.view && d.candles && d.candles.length && atf === tf) {
        const from = d.candles[Math.max(0, Math.min(d.candles.length - 1, d.view.x_from))][0];
        const last = d.candles[d.candles.length - 1][0];
        const stp = (d.meta && d.meta.tf_seconds) || 3600;
        // with the reasons on the chart, the view ends in the future: that's where the scenario, the entry and the
        // news on the clock are drawn
        if (settings.analysis.hud !== false) eng.current.fitTimes(last - (mobile ? 46 : 110) * stp, last + (mobile ? 16 : 30) * stp);
        else eng.current.panTo(from, last + stp * 30);
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

  const cleanAnalysis = useCallback(() => {
    const sym = symbolRef.current;
    const frame = analysisTf(tfRef.current);
    setRes(null);
    setStale(false);
    setLayers([]);
    if (eng.current) {
      eng.current.clearAnalysis();
      eng.current.setScope(null);
    }
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
      if (e.key.toLowerCase() === "i" && !e.repeat) setSheet("indicators");
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
  const setKeepDrawing = (b) => {
    setKeepDrawingState(b);
    if (eng.current) eng.current.keepDrawing = b;
  };
  const setToolStyle = (st) => {
    setToolStyleState(st);
    if (eng.current) eng.current.toolStyle = st;
  };
  useEffect(() => {
    if (eng.current) eng.current.toolStyle = toolStyle;
  }, [engReady]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleLockAll = (b) => {
    setLockedAll(b);
    if (eng.current) eng.current.lockAll(b);
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
  const ask = (q) => {
    setPendingAsk(q);
    setTab("ai");
    setExplain(null);
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
    const stp = (meta && meta.tf_seconds) || 3600;
    const id = eng.current.addDrawing({ type: side === "short" ? "short" : "long", points: [{ t: last, p: entry }, { t: last + stp * 24, p: sl }, { t: last + stp * 24, p: tp }], style: {} });
    eng.current.select(id);
  };

  // Edit: the AI analysis becomes the person's own, with every drawing editable, on the My analysis page
  const editToDesk = async (p) => {
    if (!res) return;
    try {
      const drawings = aiToDrawings(res, themeRef.current, hiddenLayers).concat((eng.current ? eng.current.getDrawings() : []).map((d) => ({ ...d, style: { ...d.style, mine: true } })));
      const plan = p && p.entry && p.sl ? { side: p.side, entry: p.entry, sl: p.sl, tps: (p.tps || []).slice(0, 3) } : null;
      const v = res.verdict || {};
      const d = await post("/my-analyses", {
        symbol, tf: res.tf, title: `${res.symbol} · ${res.tf} · ${v.action || "analysis"}`.slice(0, 120), source: "ai",
        source_analysis_id: res.analysis_id || null, drawings, plan,
        ai: { action: v.action, headline: v.headline, confidence: v.confidence ? v.confidence.level : null, plan, strategies: res.strategies ? res.strategies.chosen : [] },
      });
      toast("Moved to My analysis. Edit anything, then ask the AI to grade it.", "success");
      router.push(`/desk?id=${d.id}`);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 402 || e.status === 429)) showLimit(e);
      else toast(e.message || "Couldn't open it in My analysis.", "error");
    }
  };

  // ───── compare
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

  // ───── layouts: market, interval, chart type, indicators, panes and compared markets, saved by name
  const layouts = settings.layouts || [];
  const snapshot = () => ({
    symbol, tf, style: settings.candles.style, indicators: { ...settings.indicators }, studies: settings.studies || [],
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
    updateSettings({ currentLayout: l.id, candles: { style: l.style || "candles" }, indicators: { ...l.indicators }, chart: { ...l.chart }, studies: l.studies || [] });
    setCompare((l.compare || []).slice(0, 4).map((s0, i) => ({ symbol: s0, color: COMPARE_COLORS[i] })));
    if (l.symbol) setSymbol(cleanSymbol(l.symbol));
    if (l.tf && ALL_TFS.includes(l.tf)) setTf(l.tf);
    setSheet(null);
    toast(`Opened “${l.name}”.`, "info", 2200);
  };
  const deleteLayout = (id) => updateSettings({ layouts: layouts.filter((l) => l.id !== id), currentLayout: settings.currentLayout === id ? null : settings.currentLayout });
  const renameLayout = (id, name) => updateSettings({ layouts: layouts.map((l) => (l.id === id ? { ...l, name } : l)) });

  // ───── indicator templates (the quick switches and the library studies)
  const templates = settings.indicatorTemplates || [];
  const saveTemplate = (name) => {
    const next = [...templates.filter((t) => t.name !== name), { name, indicators: { ...settings.indicators }, rsi: !!settings.chart.rsi, studies: settings.studies || [] }].slice(-12);
    updateSettings({ indicatorTemplates: next });
    toast(`Indicator set “${name}” saved.`, "success", 2200);
  };
  const applyTemplate = (t) => {
    updateSettings({ indicators: { ...t.indicators }, chart: { rsi: !!t.rsi }, studies: t.studies || [] });
    toast(`“${t.name}” applied.`, "info", 2000);
  };
  const deleteTemplate = (name) => updateSettings({ indicatorTemplates: templates.filter((t) => t.name !== name) });

  // ───── a strategy's trades on the chart (Indicators > Strategies)
  const showStrategy = async (id) => {
    if (!id) {
      setStratOverlay(null);
      if (eng.current) eng.current.setStrategyOverlay(null);
      return;
    }
    try {
      const d = await get(`/strategies/overlay?${qs({ symbol, tf: analysisTf(tf), id })}`);
      setStratOverlay(d);
      if (eng.current) eng.current.setStrategyOverlay(d.items);
      toast(`${d.name}: ${d.record && d.record.trades ? `${d.record.trades} trades, ${Math.round((d.record.win_rate || 0) * 100)}% won` : "no trades on these candles"}.`, "info", 4000);
    } catch (e) {
      toast(e.message || "Couldn't show that strategy.", "error");
    }
  };

  // ───── publish an idea to Ideas (and share the picture)
  const [idea, setIdea] = useState({ title: "", body: "", side: "" });
  const openPublish = () => {
    setSheet(null);
    const v = res && res.verdict;
    setIdea({
      title: `${(meta && meta.display) || symbol} ${tf}: ${v ? v.action : "my view"}`.slice(0, 140),
      body: v ? `${v.headline}\n\n${(res.how_to_enter || []).join("\n")}` : "",
      side: res && res.plan ? res.plan.side : "",
    });
    setPublishOpen(true);
  };
  const publishIdea = async () => {
    try {
      await post("/ideas", { symbol, tf, side: idea.side || null, title: idea.title, body: idea.body,
        drawings: eng.current ? eng.current.getDrawings() : [], plan: res && res.plan ? { side: res.plan.side, entry: res.plan.entry, sl: res.plan.sl, tps: res.plan.tps } : null,
        price: meta ? meta.price : null });
      setPublishOpen(false);
      toast("Published to Ideas.", "success");
    } catch (e) {
      toast(e.message || "Couldn't publish.", "error");
    }
  };
  const shareImage = async () => {
    if (!eng.current) return;
    const url = eng.current.screenshot();
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], `${symbol}-${tf}-idea.png`, { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: idea.title, title: idea.title });
        return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
    screenshot();
  };

  // ───── teachers: show my chart to my students (TV mode: no account size, email or risk settings go out)
  const isTeacher = !!(user && (user.role === "admin" || (user.org && ["owner", "teacher"].includes(user.org.role))));
  const isStudent = !!(user && user.org && user.org.role === "member");
  useEffect(() => {
    if (!live) return undefined;
    let alive = true;
    const push = () => {
      if (!alive) return;
      const r = resRef.current;
      put("/class/live", {
        symbol: symbolRef.current, tf: tfRef.current, replay: replayRef.current,
        drawings: eng.current ? eng.current.getDrawings() : [],
        analysis: r ? { drawings: r.drawings, candles: (r.candles || []).map((c) => [c[0]]), meta: { tf_seconds: r.meta && r.meta.tf_seconds }, layers_scope: r.layers_scope,
          verdict: { action: r.verdict.action, headline: r.verdict.headline, grade: r.verdict.grade, trade: r.verdict.trade, side: r.verdict.side },
          plan: r.plan ? { side: r.plan.side, entry: r.plan.entry, sl: r.plan.sl, tps: r.plan.tps, setup: r.plan.setup } : null, tf: r.tf, symbol: r.symbol } : null,
        view: eng.current && eng.current.d.length ? { right: eng.current.right, spacing: eng.current.spacing } : null,
      }).catch((e) => {
        if (e instanceof ApiError && (e.status === 402 || e.status === 403)) {
          setLive(false);
          toast(e.message, "error");
        }
      });
    };
    push();
    const t = setInterval(push, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleLive = async () => {
    setSheet(null);
    if (live) {
      setLive(false);
      del("/class/live").catch(() => {});
      toast("Your students no longer see your chart.", "info");
    } else {
      setLive(true);
      toast("Live: your students can watch your chart. Private details stay hidden.", "success", 5000);
    }
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
  const back = () => setSheet("toolbox");
  const typeLabel = (CHART_TYPES.find((t) => t.id === settings.candles.style) || {}).label || "Candles";
  const clearAll = () => {
    if (window.confirm("Remove all your drawings on this chart?") && eng.current) eng.current.clearDrawings();
  };

  const ent = user && user.entitlements;
  const display = (meta && meta.display) || symbol;
  const legendCandle = hover && hover.candle ? hover.candle : eng.current && eng.current.d.length ? eng.current.d[eng.current.d.length - 1] : null;
  const dec = meta ? meta.decimals : 2;
  const prevClose = eng.current && eng.current.d.length > 1 ? eng.current.d[eng.current.d.length - 2].c : null;
  const dayChange = hover && hover.change !== null && hover.change !== undefined ? hover.change : legendCandle && prevClose ? (legendCandle.c / prevClose - 1) * 100 : null;
  const vTone = res ? verdictTone(res.verdict) : null;
  const panelVisible = !narrow ? !panelHidden : panelOpen;
  const latestTime = eng.current && eng.current.d.length ? eng.current.d[eng.current.d.length - 1].t : null;
  const favTfs = (settings.intervalFavorites || []).filter((t) => ALL_TFS.includes(t));
  const favTools = (settings.toolFavorites || ["trendline", "hline", "rect", "fib", "long"]).slice(0, mobile ? 4 : 8);

  const toolboxAct = {
    types: () => setSheet("types"),
    indicators: () => setSheet("indicators"),
    interval: () => setSheet("interval"),
    strategies: () => { setSheet(null); setPicker(true); },
    fit: () => { setSheet(null); setPicker(true); },
    replay: () => { setSheet(null); openTab("replay"); },
    news: () => { setSheet(null); openTab("news"); },
    review: () => { setSheet(null); setReview({ open: true, prefill: null }); },
    alerts: () => { setSheet(null); requestAlert({ list: true }); },
    publish: openPublish,
    golive: toggleLive,
    image: () => { setSheet(null); screenshot(); },
  };

  const panelContent = (
    <>
      <div className="tabs" role="tablist">
        {TABS.map(([id, label, icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)} title={label}>
            <Icon name={icon} /> <span>{label}</span>
          </button>
        ))}
        {narrow ? (
          <button onClick={() => setPanelOpen(false)} aria-label="Close panel" style={{ flex: "none", width: 40 }}><Icon name="x" /></button>
        ) : (
          <button onClick={() => setPanelHidden(true)} aria-label="Hide panel" title="Hide panel" style={{ flex: "none", width: 36 }}><Icon name="chevronRight" /></button>
        )}
      </div>
      <div className={`panel-body ${tab === "ai" || tab === "watchlist" ? "flush" : ""}`} style={tab === "ai" ? { overflow: "hidden", display: "flex", flexDirection: "column" } : undefined}>
        {tab === "analysis" ? (
          <AnalysisPanel res={res} busy={busy} step={step} steps={ANALYSIS_STEPS} onAnalyse={analyse} onAsk={ask} onClean={cleanAnalysis}
            onUpgrade={() => setPaywall({ message: "Upgrade to Pro for both report styles and the model statistics." })}
            hiddenLayers={hiddenLayers} toggleLayer={toggleLayer} layers={layers} showAlt={showAlt}
            setShowAlt={(b) => { setShowAlt(b); updateSettings({ analysis: { showAlt: b } }); }} stale={stale} symbolLabel={display} tf={analysisTf(tf)} symbol={symbol}
            onEditPlan={editToDesk} onStrategies={() => setPicker(true)} onFull={() => setFullOpen(true)}
            onTf={(t) => { if (ALL_TFS.includes(t)) setTf(t); }} />
        ) : null}
        {tab === "ai" ? (
          <AIChat symbol={symbol} tf={analysisTf(tf)} analysisId={res && res.analysis_id} pending={pendingAsk} clearPending={() => setPendingAsk(null)} onLimit={showLimit} />
        ) : null}
        {tab === "watchlist" ? (
          <Watchlist symbols={watch} current={symbol} onPick={pickSymbol} onRemove={(s) => toggleWatch(s, false)} onAdd={() => setSearchOpen(true)} onMove={moveWatch} />
        ) : null}
        {tab === "news" ? <NewsPanel symbol={symbol} tf={analysisTf(tf)} /> : null}
        {tab === "divergence" ? <DivergencePanel symbol={symbol} tf={analysisTf(tf)} /> : null}
        {tab === "replay" ? <ReplayPanel symbol={symbol} tf={tf} replay={replay} setReplay={setReplay} onAnalysis={drawReplayAnalysis} onLimit={showLimit}
          chartType={settings.candles.style} onChartType={() => setSheet("types")} eng={eng} /> : null}
      </div>
    </>
  );

  return (
    <div className={`term${narrow ? "" : " term-desk"}${live ? " is-live" : ""}`} data-tv={scale > 1 ? "1" : undefined}>
      <header className="topbar">
        {mobile ? null : <Brand href="/" size={30} compact={width < 1300} />}
        {!mobile ? <span className="sep" /> : null}
        <button className="mkt-chip" data-tour="market" onClick={() => setSearchOpen(true)} aria-label={`Market: ${display}. Change market`}>
          <span className="mkt-sym">{display}</span>
          {meta && !mobile ? <span className={`mkt-px num ${dayChange !== null && dayChange < 0 ? "down" : "up"}`}>{fmtPrice(meta.price, dec)}</span> : null}
          {meta && meta.perp ? <span className="badge violet hide-mobile">PERP</span> : null}
          <Icon name="chevronDown" size={14} />
        </button>
        <IntervalChip tf={tf} onClick={() => setSheet("interval")} />
        {!mobile && favTfs.length ? (
          <div className="tf-favs" role="radiogroup" aria-label="Favourite intervals">
            {favTfs.map((t) => (
              <button key={t} className={tf === t ? "on" : ""} onClick={() => setTf(t)} role="radio" aria-checked={tf === t} title={TF_LABEL[t]}>{t}</button>
            ))}
          </div>
        ) : null}
        <StrategyChip user={user} onClick={() => setPicker(true)} compact={mobile} />
        {!mobile ? (
          <>
            <button className="icon-btn" onClick={() => setSheet("types")} title={`Chart type: ${typeLabel}`} aria-label={`Chart type: ${typeLabel}`}>
              <ChartTypeIcon id={settings.candles.style} size={19} />
            </button>
            <button className="icon-btn" onClick={() => setSheet("indicators")} title="Indicators (I)" aria-label="Indicators"><Icon name="indicator" /></button>
          </>
        ) : null}
        <button className="icon-btn" onClick={() => setSheet("toolbox")} title="Toolbox" aria-label="Toolbox" data-tour="hub">
          <Icon name="grid" />
        </button>
        <div className="grow" />
        {live ? <button className="live-pill" onClick={toggleLive} title="Your students can see your chart. Tap to stop."><i /> Live</button> : null}
        {!mobile && ent && ent.tier === "trial" ? <Link href="/billing" className="trial-chip hide-mobile" title="Your free trial">Trial · {ent.trial_days_left}d left</Link> : null}
        {!mobile ? (
          <>
            <Link className="btn sm ghost" href="/desk" title="My analysis" data-tour="desk"><Icon name="book" size={15} /> My analysis</Link>
            <button className={`btn primary analyse-btn ${busy ? "busy" : ""}`} data-tour="analyse" onClick={analyse} disabled={busy || !!chartState.error} title="Analyse this chart (A)">
              {busy ? <span className="spinner" /> : <Icon name="zap" size={17} />}
              <span>{busy ? "Analysing" : "Analyse"}</span>
            </button>
          </>
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
            <Link href="/desk"><Icon name="book" size={16} /> My analysis</Link>
            <Link href="/markets"><Icon name="globe" size={16} /> Markets & ideas</Link>
            <Link href={`/practice?s=${encodeURIComponent(symbol)}&tf=${["15m", "1h", "4h", "1D"].includes(tf) ? tf : "1h"}`}><Icon name="target" size={16} /> Draw & score this chart</Link>
            <Link href={`/strategy?s=${encodeURIComponent(symbol)}&tf=${analysisTf(tf)}`}><Icon name="sliders" size={16} /> Strategy lab</Link>
            <Link href="/track-record"><Icon name="shield" size={16} /> Track record</Link>
            {isStudent ? <Link href="/class"><Icon name="users" size={16} /> Watch my teacher</Link> : null}
            <hr />
            <button onClick={() => { setMenu(null); setPicker(true); }}><Icon name="target" size={16} /> My strategies</button>
            <Link href="/settings"><Icon name="settings" size={16} /> Settings</Link>
            <Link href="/billing"><Icon name="card" size={16} /> Plan & billing</Link>
            {user && user.role === "admin" ? <Link href="/admin"><Icon name="shield" size={16} /> Admin</Link> : null}
            <hr />
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
        <div className="chart-wrap" style={{ "--chart-bg": theme.bg }}>
          <ChartView onReady={onReady} onEvent={onEvent} scale={scale} />
          <div className="legend">
            <div className="l1">
              <b>{display}</b><span className="faint">{TF_LABEL[tf] || tf}{meta ? ` · ${meta.source}` : ""}</span>
            </div>
            {legendCandle ? (
              <div className="ohlc num">
                <span>O <i>{fmtPrice(legendCandle.o, dec)}</i></span><span>H <i>{fmtPrice(legendCandle.h, dec)}</i></span>
                <span>L <i>{fmtPrice(legendCandle.l, dec)}</i></span><span>C <i>{fmtPrice(legendCandle.c, dec)}</i></span>
                {dayChange !== null ? <span className={dayChange >= 0 ? "up" : "down"}>{fmtChange(dayChange)}</span> : null}
              </div>
            ) : null}
            {hover && hover.studies && hover.studies.length ? (
              <div className="ind num">
                {hover.studies.filter((s) => s.kind === "overlay" && s.vals.length).slice(0, 4).map((s) => (
                  <span key={s.key} style={{ color: s.vals[0].color }}>{s.name} {s.vals.slice(0, 3).map((v) => fmtPrice(v.v, dec)).join(" ")}</span>
                ))}
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
              <button className={`icon-btn glass ${drawMobile ? "active" : ""}`} onClick={() => setDrawMobile(!drawMobile)} aria-label="Drawing tools" data-tour="tools"><Icon name="pen" /></button>
            ) : null}
            {!mobile && panelHidden ? (
              <button className="btn sm glass" onClick={() => setPanelHidden(false)}><Icon name="chevronLeft" size={15} /> Panel</button>
            ) : null}
          </div>
          <div className="seg glass chart-zoom" role="group" aria-label="Chart size">
            <button onClick={() => eng.current && eng.current.zoom(0.8)} title="Narrower candles" aria-label="Narrower candles">↔−</button>
            <button onClick={() => eng.current && eng.current.zoom(1.25)} title="Wider candles" aria-label="Wider candles">↔+</button>
            <i className="zsep" />
            <button onClick={() => eng.current && eng.current.zoomY(0.8)} title="Shorter price scale" aria-label="Shorter price scale">↕−</button>
            <button onClick={() => eng.current && eng.current.zoomY(1.25)} title="Taller price scale" aria-label="Taller price scale">↕+</button>
            <i className="zsep" />
            <button onClick={() => eng.current && eng.current.resetView()} title="Fit the chart" aria-label="Fit the chart"><Icon name="fit" size={14} /></button>
          </div>
          <ToolDock tool={tool} setTool={setTool} favorites={favTools} onStudio={() => setSheet("studio")} magnet={magnet} setMagnet={setMagnet}
            keep={keepDrawing} setKeep={setKeepDrawing} locked={lockedAll} setLocked={toggleLockAll} visible={drawVisible} setVisible={setDrawVisible}
            onUndo={() => eng.current && eng.current.undo()} onRedo={() => eng.current && eng.current.redo()} onClear={clearAll} hidden={mobile && !drawMobile} />
          <FromHereChip hover={replay ? null : hover} decimals={dec} onPick={runWhatIf} />
          <ChartHud eng={engReady ? eng.current : null} res={showHud ? res : null} mobile={mobile} dec={dec} showLevels={showLevels} stale={stale}
            bottomInset={drawMobile ? 66 : 28} onHide={() => updateSettings({ analysis: { hud: false } })} onOpen={() => openTab("analysis")} onAnalyse={analyse}
            onAlert={(a) => requestAlert({ symbol, tf, price: Number(Number(a.price).toFixed(dec)), op: a.op, note: a.note })} />
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
          {mobile && res && !panelOpen && !busy && !showHud ? (
            <button className={`verdict-pill ${vTone}`} onClick={() => openTab("analysis")} style={{ bottom: drawMobile ? 70 : 34 }}>
              <div className="grow">
                <b>{showLevels ? res.verdict.action : res.verdict.side === "long" ? "Leaning up" : res.verdict.side === "short" ? "Leaning down" : "No clear edge"}</b>
                {res.plan && showLevels ? (
                  <div className="num faint" style={{ fontSize: "0.78rem" }}>EP {fmtPrice(res.plan.entry, dec)} · SL {fmtPrice(res.plan.sl, dec)} · TP {fmtPrice(res.plan.tps[0], dec)}</div>
                ) : <div className="faint" style={{ fontSize: "0.78rem" }}>{res.verdict.confidence ? `${res.verdict.confidence.level} confidence` : ""}</div>}
              </div>
              {showLevels ? <span className={`grade ${gradeClass(res.verdict.grade)}`} style={{ width: 34, height: 34 }}>{res.verdict.grade}</span> : null}
            </button>
          ) : null}
          {meta && !chartState.loading ? (
            <div className="chart-status hide-mobile">
              {replay ? (
                <>
                  <span className="live-dot" style={{ background: "var(--warn)" }} /> Replay · {utcLabel(replay.at)}{replay.ahead ? " · future shown" : " · future hidden"}
                  <button className="btn sm" style={{ marginLeft: 8, pointerEvents: "auto" }} onClick={() => setReplay(null)}>Back to live</button>
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
      </div>

      {mobile ? (
        <nav className="bottom-nav" aria-label="Sections">
          <Link href="/markets" className=""><Icon name="globe" /><span>Markets</span></Link>
          <button className={!panelOpen ? "on" : ""} onClick={() => setPanelOpen(false)}><Icon name="candles" /><span>Chart</span></button>
          <button className="fab" data-tour="analyse" onClick={analyse} aria-label="Analyse"><span className="ring">{busy ? <span className="spinner" /> : <Icon name="zap" size={20} />}</span><span>Analyse</span></button>
          <Link href="/desk" data-tour="desk"><Icon name="book" /><span>My analysis</span></Link>
          <button className={panelOpen && tab !== "analysis" ? "on" : ""} onClick={() => openTab(tab === "analysis" ? "ai" : tab)}><Icon name="sparkles" /><span>StreixAI</span></button>
        </nav>
      ) : null}

      <CrossMenu at={crossMenu} onClose={() => setCrossMenu(null)} onLine={(at) => lineAt(at, "hline")} onRay={(at) => lineAt(at, "hray")}
        onAlert={alertAt} onAlertForm={alertForm} onCopy={copyPrice} symbolLabel={display} last={meta ? meta.price : null}
        latestTime={replay ? null : latestTime} onWhatIf={(at) => runWhatIf(at.price)} />
      <ExplainCard data={explain} onClose={() => setExplain(null)} onCopy={(t, w) => { copyText(t, w); setExplain(null); }} onAsk={ask} />
      <WhatIfSheet open={whatIf.open} onClose={() => setWhatIf({ open: false, busy: false, data: null, error: null })} data={whatIf.data} busy={whatIf.busy} error={whatIf.error}
        onUse={(s) => { placeTrade({ side: s.side, entry: s.entry, sl: s.sl, tp: s.tps[Math.min(1, s.tps.length - 1)] }); setWhatIf({ open: false, busy: false, data: null, error: null }); }} />
      <StrategyPicker open={picker} onClose={() => setPicker(false)} symbol={symbol} tf={analysisTf(tf)} forced={!!(user && user.needs_strategies)}
        onSaved={() => { if (res) toast("Analyse again to use your new strategies.", "info", 3500); }} />
      <Toolbox open={sheet === "toolbox"} onClose={() => setSheet(null)} go={setSheet} act={toolboxAct} symbol={symbol} tf={tf}
        teacher={isTeacher} student={isStudent} live={live} />
      <IntervalSheet open={sheet === "interval"} onClose={() => setSheet(null)} value={tf} onPick={setTf}
        favorites={settings.intervalFavorites || []} onFavorites={(f) => updateSettings({ intervalFavorites: f })}
        onRange={(r) => eng.current && eng.current.showRange(r)} onGoTo={(t) => eng.current && eng.current.goTo(t)} />
      <DrawingStudio open={sheet === "studio"} onClose={() => setSheet(null)} tool={tool} setTool={setTool}
        favorites={settings.toolFavorites || ["trendline", "hline", "rect", "fib", "long"]} onFavorites={(f) => updateSettings({ toolFavorites: f })}
        toolStyle={toolStyle} setToolStyle={setToolStyle} />
      <IndicatorSheet open={sheet === "indicators" || sheet === "templates"} startTab={sheet === "templates" ? "templates" : "library"} onClose={() => setSheet(null)}
        studies={settings.studies || []} setStudies={(list) => updateSettings({ studies: list })}
        legacy={{ ...settings.indicators, rsi: settings.chart.rsi }} setLegacy={(k, v) => (k === "rsi" ? updateSettings({ chart: { rsi: v } }) : updateSettings({ indicators: { [k]: v } }))}
        templates={templates} onSaveTemplate={saveTemplate} onApplyTemplate={applyTemplate} onDeleteTemplate={deleteTemplate}
        strategyOverlay={stratOverlay} onStrategy={showStrategy} />
      <ChartTypeSheet open={sheet === "types"} onClose={() => setSheet(null)} value={settings.candles.style} onPick={pickType}
        favorites={settings.chartFavorites || []} onFavorites={(f) => updateSettings({ chartFavorites: f })}
        onUnavailable={(t) => toast(t.needs, "info", 6000)} tipSeen={!!settings.chartTypeTipSeen} onTipSeen={() => updateSettings({ chartTypeTipSeen: true })} />
      <LayoutPanel open={sheet === "layout"} onClose={() => setSheet(null)} onBack={back} settings={settings} update={updateSettings}
        panelHidden={panelHidden} setPanelHidden={setPanelHidden} narrow={narrow} />
      <LayoutsPanel open={sheet === "layouts"} onClose={() => setSheet(null)} onBack={back} layouts={layouts} current={settings.currentLayout}
        onOpen={openLayout} onDelete={deleteLayout} onSaveAs={saveLayoutAs} onRename={renameLayout} onSave={saveLayout} />
      <ComparePanel open={sheet === "compare"} onClose={() => setSheet(null)} onBack={back} compare={compare} onAdd={addCompare} onRemove={removeCompare} symbol={display} />
      <ObjectTreePanel open={sheet === "objects"} onClose={() => setSheet(null)} onBack={back} drawings={drawList} decimals={dec}
        onSelect={objectAct.select} onToggle={objectAct.toggle} onLock={objectAct.lock} onDelete={objectAct.del}
        hasAnalysis={!!res} analysisOn={analysisOn} onAnalysis={toggleAnalysis} />
      <SymbolDetailsPanel open={sheet === "details"} onClose={() => setSheet(null)} onBack={back} meta={meta} symbol={symbol} tf={tf} />
      <TechnicalsPanel open={sheet === "technicals"} onClose={() => setSheet(null)} onBack={back} candles={eng.current ? eng.current.raw : []}
        symbol={display} tf={tf} decimals={dec} />
      <BrokerPanel open={sheet === "broker"} onClose={() => setSheet(null)} onBack={back} meta={meta} symbol={display} plan={res && res.plan} decimals={dec} toast={toast} />
      <ReviewModal open={review.open} onClose={() => setReview({ open: false, prefill: null })} symbol={symbol} tf={analysisTf(tf)} prefill={review.prefill}
        price={meta && meta.price} decimals={dec} settings={settings} onLimit={showLimit} onShowOnChart={placeTrade} />
      <Paywall open={!!paywall} onClose={() => setPaywall(null)} info={paywall} />
      <FullAnalysis open={fullOpen && !!res} onClose={() => setFullOpen(false)} res={res} can={can}
        onUpgrade={() => { setFullOpen(false); setPaywall({ message: "Upgrade to Pro for both report styles and the model statistics." }); }} />
      <Modal open={publishOpen} onClose={() => setPublishOpen(false)} title="Publish an idea">
        <form className="stack" onSubmit={(e) => { e.preventDefault(); publishIdea(); }}>
          <div className="field"><label>Title</label><input className="input" value={idea.title} onChange={(e) => setIdea({ ...idea, title: e.target.value })} maxLength={140} required minLength={3} /></div>
          <div className="field"><label>Direction</label>
            <div className="seg">
              {[["", "Education"], ["long", "Long"], ["short", "Short"]].map(([v, l]) => <button type="button" key={l} className={idea.side === v ? "on" : ""} onClick={() => setIdea({ ...idea, side: v })}>{l}</button>)}
            </div>
          </div>
          <div className="field"><label>Your reasoning</label><textarea className="textarea" rows={6} value={idea.body} onChange={(e) => setIdea({ ...idea, body: e.target.value })} maxLength={6000} /></div>
          <div className="hint">Your drawings on this chart are published with it. Ideas are public to every StreixAnalyst user.</div>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn" onClick={shareImage}><Icon name="camera" size={15} /> Share image</button>
            <button className="btn primary"><Icon name="upload" size={15} /> Publish</button>
          </div>
        </form>
      </Modal>
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
              placeholder="e.g. Liquidity above: wait for the sweep" />
            <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary">Save</button></div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}

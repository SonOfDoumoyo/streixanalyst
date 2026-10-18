"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Icon from "@/components/Icons";
import ChartView from "@/components/chart/ChartView";
import Paywall from "@/components/Paywall";
import SubNav from "@/components/SubNav";
import { useAuth } from "@/components/Providers";
import { Modal, RequireAuth, Spinner } from "@/components/ui";
import { DrawToolbar, PRACTICE_GROUPS, StyleBar } from "@/components/terminal/DrawTools";
import SymbolSearch from "@/components/terminal/SymbolSearch";
import AIChat from "@/components/terminal/AIChat";
import { ApiError, get, post, qs } from "@/lib/api";
import { toOverlay, toUserDrawings } from "@/lib/analysis";
import { cleanSymbol, fmtDateTime, fmtPct, fmtPrice, TF_LABEL } from "@/lib/format";
import { localGet, localSet } from "@/lib/settings";
import { chartThemeFor } from "@/lib/chartTheme";

const RANDOM = [["BTCUSDT", "1h"], ["ETHUSDT", "4h"], ["SOLUSDT", "1h"], ["XAUUSD", "1h"], ["EURUSD", "15m"], ["GBPUSD", "1h"],
  ["NAS100", "1h"], ["US30", "4h"], ["XRPUSDT", "4h"], ["USDJPY", "1h"], ["BNBUSDT", "1D"], ["GBPJPY", "4h"]];
const TFS = ["15m", "1h", "4h", "1D"];
const BIAS_WORD = { long: "Bullish", short: "Bearish", neutral: "No clear direction" };

function ScoreRing({ score, grade }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const col = score >= 70 ? "#2fd3a6" : score >= 55 ? "#2962ff" : score >= 40 ? "#f5b342" : "#ff6b6b";
  return (
    <div style={{ position: "relative", width: 132, height: 132, flex: "none" }}>
      <svg viewBox="0 0 132 132" width="132" height="132" style={{ transform: "rotate(-90deg)" }}>
        <circle cx="66" cy="66" r={r} fill="none" stroke="var(--bg-4)" strokeWidth="11" />
        <circle cx="66" cy="66" r={r} fill="none" stroke={col} strokeWidth="11" strokeLinecap="round"
          strokeDasharray={`${(c * score) / 100} ${c}`} style={{ transition: "stroke-dasharray 0.9s var(--ease)" }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
        <div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "2.2rem", lineHeight: 1 }}>{score}</div>
          <div style={{ fontSize: "0.78rem", fontWeight: 800, color: col }}>{grade}</div>
        </div>
      </div>
    </div>
  );
}

function Bar({ label, v, of }) {
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", fontSize: "0.84rem" }}><span className="muted">{label}</span><b className="num">{v}/{of}</b></div>
      <div className="prob-bar" style={{ marginTop: 4 }}><i style={{ width: `${(v / of) * 100}%` }} /></div>
    </div>
  );
}

function PracticeInner() {
  const { settings, toast, refresh } = useAuth();
  const sp = useSearchParams();
  const [width, setWidth] = useState(1400);
  useEffect(() => {
    const f = () => setWidth(window.innerWidth);
    f();
    if (window.innerWidth <= 760) setPanelOpen(false);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  const mobile = width <= 760;
  const narrow = width <= 1100;
  const [symbol, setSymbol] = useState(cleanSymbol(sp.get("s") || "BTCUSDT"));
  const [tf, setTf] = useState(TFS.includes(sp.get("tf")) ? sp.get("tf") : "1h");
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tool, setToolState] = useState("cursor");
  const [sel, setSel] = useState(null);
  const [bias, setBias] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [showFix, setShowFix] = useState(true);
  const [reveal, setReveal] = useState(false);
  const [challenge, setChallenge] = useState(null);
  const [useChallenge, setUseChallenge] = useState(false);
  const [tab, setTab] = useState("practice");
  const [hist, setHist] = useState(null);
  const [board, setBoard] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [textEdit, setTextEdit] = useState(null);
  const [paywall, setPaywall] = useState(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [count, setCount] = useState(0);
  const [magnet, setMagnetState] = useState(false);
  const [visible, setVisibleState] = useState(true);
  const eng = useRef(null);
  const [ready, setReady] = useState(false);
  const symRef = useRef(symbol);
  symRef.current = symbol;

  // the chart follows the app's light or dark mode (see lib/chartTheme.js)
  const theme = useMemo(() => chartThemeFor(settings.theme, settings.chart, settings.candles),
    [settings.theme, settings.chart, settings.candles]);

  useEffect(() => {
    if (!ready) return;
    eng.current.setTheme(theme);
    eng.current.setOptions({ style: settings.candles.style, volume: true, indicators: { ema20: false, ema50: false, ema200: false, bb: false, vwap: false } });
    eng.current.drawingDefaults = { ...settings.drawingDefaults, color: "#ffd166" };
    eng.current.setDetail(3);
  }, [ready, theme, settings.candles.style, settings.drawingDefaults]);

  useEffect(() => {
    get("/practice/challenge").then(setChallenge).catch(() => {});
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    let alive = true;
    setLoading(true);
    setResult(null);
    setReveal(false);
    eng.current.clearAnalysis();
    get(`/market/candles?${qs({ symbol, tf, bars: 500 })}`).then((d) => {
      if (!alive) return;
      eng.current.setData(d.candles, { tfSec: d.tf_seconds, decimals: d.decimals, label: `${d.display} · ${tf}` });
      setMeta(d);
      const saved = localGet(`sa_practice_${symbol}_${tf}`, []);
      eng.current.setDrawings(saved);
      setCount(saved.length);
    }).catch((e) => toast(e.message, "error")).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [ready, symbol, tf, toast]);

  const onEvent = useCallback((type, data) => {
    if (type === "select") setSel(data);
    else if (type === "toolDone") setToolState("cursor");
    else if (type === "drawings") {
      localSet(`sa_practice_${symRef.current}_${tf}`, data);
      setCount(data.length);
    } else if (type === "requestText") {
      const d = eng.current.drawings.find((x) => x.id === data);
      setTextEdit({ id: data, value: (d && d.style.text) || "" });
    }
  }, [tf]);

  const setMagnet = (v) => {
    setMagnetState(v);
    if (eng.current) eng.current.magnet = v;
  };
  const setVisible = (v) => {
    setVisibleState(v);
    if (eng.current) eng.current.setDrawingsVisible(v);
  };
  const setTool = (t) => {
    setToolState(t);
    eng.current && eng.current.setTool(t);
  };

  const overlay = useCallback((res, fix, rev) => {
    if (!eng.current) return;
    let items = [];
    if (res && fix) items = items.concat(res.corrections || []);
    if (res && rev) items = items.concat(toOverlay(res.analysis, theme).items.filter((it) => it.prio <= 1));
    if (items.length) eng.current.setAnalysis(items, { animate: true, pins: [] });
    else eng.current.clearAnalysis();
  }, [theme]);

  useEffect(() => { overlay(result, showFix, reveal); }, [result, showFix, reveal, overlay]);

  const submit = async () => {
    if (!eng.current) return;
    const ds = eng.current.getDrawings();
    const pos = [...ds].reverse().find((d) => d.type === "long" || d.type === "short");
    const trade = pos ? { side: pos.type, entry: pos.points[0].p, sl: pos.points[1].p, tp: pos.points[2].p } : null;
    setBusy(true);
    try {
      const d = await post("/practice/score", {
        symbol, tf, bias, drawings: toUserDrawings(ds), trade,
        challenge: useChallenge && challenge && challenge.symbol === symbol && challenge.tf === tf ? challenge.id : null,
      });
      setResult(d);
      setShowFix(true);
      setReveal(false);
      setTab("practice");
      setPanelOpen(true);
      if (d.new_best && d.score > 0) toast(`New personal best: ${d.score}!`, "success");
      refresh();
      get("/practice/challenge").then(setChallenge).catch(() => {});
    } catch (e) {
      if (e instanceof ApiError && (e.status === 402 || e.status === 429)) setPaywall({ message: e.message, detail: e.detail });
      else toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const fresh = () => {
    const [s, t] = RANDOM[Math.floor(Math.random() * RANDOM.length)];
    setUseChallenge(false);
    setSymbol(s);
    setTf(t);
    setBias(null);
  };
  const playChallenge = () => {
    if (!challenge) return;
    setUseChallenge(true);
    setSymbol(challenge.symbol);
    setTf(challenge.tf);
    setBias(null);
  };
  const clearAll = () => {
    if (eng.current) eng.current.clearDrawings();
    setResult(null);
    setBias(null);
  };
  useEffect(() => {
    if (tab === "history") get("/practice/history").then(setHist).catch(() => setHist({ items: [], stats: {} }));
    if (tab === "board") get("/practice/leaderboard").then(setBoard).catch(() => setBoard({ entries: [] }));
  }, [tab, result]);

  const dec = meta ? meta.decimals : 2;
  const r = result;
  return (
    <div className="term" style={mobile ? { gridTemplateRows: "52px 1fr" } : undefined}>
      <SubNav mobile={mobile} />
      <div className="term-body">
        {!mobile ? (
          <DrawToolbar groups={PRACTICE_GROUPS} tool={tool} setTool={setTool} magnet={magnet} setMagnet={setMagnet} visible={visible} setVisible={setVisible}
            onUndo={() => eng.current && eng.current.undo()} onRedo={() => eng.current && eng.current.redo()} onClear={clearAll} />
        ) : null}
        <div className="chart-wrap" style={{ "--chart-bg": theme.bg }}>
          <ChartView onReady={(e) => { eng.current = e; setReady(!!e); }} onEvent={onEvent} />
          <div className="legend">
            <div className="l1"><b>{meta ? meta.display : symbol}</b><span className="faint">{TF_LABEL[tf]} · practice</span></div>
            {!r ? <div className="faint" style={{ fontSize: "0.78rem" }}>Mark your levels, zones and trendlines — the analysis stays hidden until you submit.</div> : null}
          </div>
          {sel ? (
            <StyleBar drawing={sel} onStyle={(s) => eng.current.updateSelected({ style: s })} onDelete={() => eng.current.deleteSelected()}
              onClone={() => eng.current.cloneSelected()} onLock={() => eng.current.updateSelected({ locked: !sel.locked })}
              onEditText={() => setTextEdit({ id: sel.id, value: sel.style.text || "" })} />
          ) : null}
          {mobile ? (
            <DrawToolbar groups={PRACTICE_GROUPS} tool={tool} setTool={setTool} magnet={magnet} setMagnet={setMagnet} visible={visible} setVisible={setVisible}
              onUndo={() => eng.current && eng.current.undo()} onRedo={() => eng.current && eng.current.redo()} onClear={clearAll} />
          ) : null}
          {loading ? <div className="chart-msg"><div><Spinner /></div></div> : null}
          {busy ? <><div className="scanline" /><div className="analysing-card glass"><span className="spinner dark" /> Grading your analysis…</div></> : null}
          {narrow && !panelOpen ? (
            <button className="btn primary" style={{ position: "absolute", right: mobile ? 74 : 80, bottom: mobile ? 84 : 40, zIndex: 9 }} onClick={() => setPanelOpen(true)}>
              {r ? `Score ${r.score}` : "Submit"} <Icon name="chevronUp" size={15} />
            </button>
          ) : null}
        </div>
        <aside className={`rpanel ${panelOpen ? "open" : ""}`} style={mobile ? { bottom: 0 } : undefined}>
          <div className="tabs">
            {[["practice", "Practice", "target"], ["coach", "Coach", "sparkles"], ["history", "History", "clock"], ["board", "Today", "star"]].map(([id, l, ic]) => (
              <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}><Icon name={ic} /> <span>{l}</span></button>
            ))}
            {narrow ? <button onClick={() => setPanelOpen(false)} style={{ flex: "none", width: 40 }} aria-label="Close"><Icon name="x" /></button> : null}
          </div>
          <div className={`panel-body ${tab === "coach" ? "flush" : ""}`} style={tab === "coach" ? { overflow: "hidden", display: "flex", flexDirection: "column" } : undefined}>
            {tab === "practice" ? (
              <div className="stack" style={{ gap: 12 }}>
                <div className="card" style={{ padding: 14 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <div>
                      <div className="eyebrow">Draw & score</div>
                      <b style={{ fontSize: "1.05rem" }}>{meta ? meta.display : symbol} · {tf}</b>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn sm" onClick={() => setSearchOpen(true)}><Icon name="search" size={14} /> Market</button>
                      <button className="btn sm ghost" onClick={fresh} title="Random chart"><Icon name="refresh" size={14} /></button>
                    </div>
                  </div>
                  <div className="seg" style={{ marginTop: 10 }}>
                    {TFS.map((t) => <button key={t} className={tf === t ? "on" : ""} onClick={() => setTf(t)}>{t}</button>)}
                  </div>
                  {challenge ? (
                    <button className="row" onClick={playChallenge} style={{ marginTop: 12, width: "100%", textAlign: "left", border: "1px solid rgba(155,123,255,.35)", background: "rgba(155,123,255,.1)", borderRadius: 12, padding: "10px 12px", color: "var(--text)" }}>
                      <Icon name="star" size={18} style={{ color: "#c4b3ff" }} />
                      <div className="grow">
                        <b>Today's challenge: {challenge.symbol} · {challenge.tf}</b>
                        <div className="faint" style={{ fontSize: "0.78rem" }}>{challenge.players} player{challenge.players === 1 ? "" : "s"}{challenge.your_best !== null && challenge.your_best !== undefined ? ` · your best ${challenge.your_best}` : ""}</div>
                      </div>
                      {useChallenge && challenge.symbol === symbol && challenge.tf === tf ? <span className="badge violet">playing</span> : <Icon name="chevronRight" size={16} />}
                    </button>
                  ) : null}
                </div>
                {!r ? (
                  <>
                    <ul className="check-list">
                      <li className={count ? "ok" : ""}><span className="ic">{count ? "✓" : "1"}</span><span>Mark the key levels: horizontal lines or zones where price reacts ({count} drawn)</span></li>
                      <li><span className="ic">2</span><span>Add trendlines if you see them</span></li>
                      <li><span className="ic">3</span><span>Optional: place a long or short position with your entry, stop and target</span></li>
                      <li className={bias ? "ok" : ""}><span className="ic">{bias ? "✓" : "4"}</span><span>Call the bias</span></li>
                    </ul>
                    <div className="seg brand" role="radiogroup" aria-label="Your bias" style={{ alignSelf: "flex-start" }}>
                      {[["long", "Bullish"], ["short", "Bearish"], ["neutral", "No trade"]].map(([v, l]) => (
                        <button key={v} className={bias === v ? "on" : ""} onClick={() => setBias(v)}>{l}</button>
                      ))}
                    </div>
                    <button className="btn primary lg block" onClick={submit} disabled={busy || loading}>
                      {busy ? <span className="spinner" /> : <Icon name="target" size={18} />} Score my analysis
                    </button>
                    <div className="hint">The analyst runs on the same chart, then compares: levels 40 pts · bias 20 pts · your trade 40 pts.</div>
                  </>
                ) : (
                  <>
                    <div className="card row" style={{ gap: 16, padding: 16 }}>
                      <ScoreRing score={r.score} grade={r.grade} />
                      <div className="stack grow" style={{ gap: 8 }}>
                        <Bar label="Levels" v={r.breakdown.levels.score} of={40} />
                        <Bar label="Bias" v={r.breakdown.bias.score} of={20} />
                        <Bar label="Trade" v={r.breakdown.trade.score} of={40} />
                        <div className="faint" style={{ fontSize: "0.76rem" }}>Personal best {r.personal_best}{r.challenge ? " · counted for today's challenge" : ""}</div>
                      </div>
                    </div>
                    {r.good.length ? (
                      <div>
                        <div className="section-title">What you did well</div>
                        <ul className="check-list">{r.good.map((g, i) => <li key={i} className="ok"><span className="ic">✓</span><span>{g}</span></li>)}</ul>
                      </div>
                    ) : null}
                    {r.improve.length ? (
                      <div>
                        <div className="section-title">How to improve</div>
                        <ul className="check-list">{r.improve.map((g, i) => <li key={i} className="no"><span className="ic">→</span><span>{g}</span></li>)}</ul>
                      </div>
                    ) : null}
                    <details className="fold" open>
                      <summary><span>Levels: found {r.breakdown.levels.hit.length} of {r.breakdown.levels.key.length}</span>{r.breakdown.levels.count ? <span className="faint" style={{ fontSize: "0.78rem", fontWeight: 600, whiteSpace: "nowrap" }}>{fmtPct(r.breakdown.levels.precision)} of yours solid</span> : null}</summary>
                      <div className="stack" style={{ gap: 6, fontSize: "0.85rem" }}>
                        {r.breakdown.levels.key.map((k, i) => {
                          const hit = r.breakdown.levels.hit.some((h) => h.price === k.price);
                          return (
                            <div key={i} className="row" style={{ alignItems: "flex-start" }}>
                              <span className={`badge ${hit ? "up" : "warn"}`} style={{ minWidth: 62, justifyContent: "center" }}>{hit ? "found" : "missed"}</span>
                              <span className="num" style={{ fontWeight: 700 }}>{fmtPrice(k.price, dec)}</span>
                              <span className="muted">{k.labels.slice(0, 2).join(" + ")}</span>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                    <div className="card" style={{ padding: 12, fontSize: "0.86rem" }}>
                      <b>Bias</b>: you said <b>{BIAS_WORD[r.breakdown.bias.yours] || "nothing"}</b>, the chart reads <b>{BIAS_WORD[r.breakdown.bias.expected] || r.breakdown.bias.expected}</b> — {r.breakdown.bias.why}.
                      <div style={{ marginTop: 6 }}><b>Trade</b>: {r.breakdown.trade.verdict}</div>
                    </div>
                    <label className="check"><input type="checkbox" checked={showFix} onChange={(e) => setShowFix(e.target.checked)} /> Show corrections on the chart</label>
                    <label className="check"><input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> Reveal the analyst's full analysis</label>
                    <div className="row wrap" style={{ gap: 8 }}>
                      <button className="btn primary" onClick={() => setTab("coach")}><Icon name="sparkles" size={16} /> Coach me</button>
                      <button className="btn" onClick={() => { setResult(null); setBias(null); }}><Icon name="pen" size={16} /> Edit & retry</button>
                      <button className="btn ghost" onClick={() => { clearAll(); fresh(); }}><Icon name="refresh" size={16} /> New chart</button>
                    </div>
                  </>
                )}
              </div>
            ) : null}
            {tab === "coach" ? (
              r ? <AIChat symbol={symbol} tf={tf} analysisId={r.analysis_id} pending={r._asked ? null : `Coach me on this practice: I scored ${r.score}. What did I miss and how do I improve?`}
                clearPending={() => setResult((x) => ({ ...x, _asked: true }))} onLimit={(e) => setPaywall({ message: e.message, detail: e.detail })} />
                : <div className="empty">Submit an analysis first — then StreixAI coaches you on it.</div>
            ) : null}
            {tab === "history" ? (
              !hist ? <Spinner /> : (
                <div className="stack">
                  <div className="stats" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
                    <div className="card stat"><div className="k">Attempts</div><div className="v">{hist.stats.attempts || 0}</div></div>
                    <div className="card stat"><div className="k">Best</div><div className="v">{hist.stats.best ?? "—"}</div></div>
                    <div className="card stat"><div className="k">Last 5 avg</div><div className="v">{hist.stats.last5 ?? "—"}</div></div>
                  </div>
                  {hist.items.map((h) => (
                    <div key={h.id} className="row" style={{ fontSize: "0.86rem", borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
                      <b className="num" style={{ width: 34 }}>{h.score}</b>
                      <div className="grow"><b>{h.symbol} · {h.tf}</b> <span className="faint">{h.grade}{h.challenge ? " · challenge" : ""}</span>
                        <div className="faint" style={{ fontSize: "0.76rem" }}>{fmtDateTime(h.created_at)} · levels {h.breakdown.levels ?? "—"} · bias {h.breakdown.bias ?? "—"} · trade {h.breakdown.trade ?? "—"}</div></div>
                    </div>
                  ))}
                  {!hist.items.length ? <div className="empty">No attempts yet.</div> : null}
                </div>
              )
            ) : null}
            {tab === "board" ? (
              !board ? <Spinner /> : (
                <div className="stack">
                  <div className="muted" style={{ fontSize: "0.88rem" }}>Best scores on today's challenge{challenge ? ` (${challenge.symbol} · ${challenge.tf})` : ""}.</div>
                  {board.entries.map((e) => (
                    <div key={e.rank} className="row" style={{ padding: "8px 10px", borderRadius: 10, background: e.you ? "rgba(47,134,246,.12)" : "var(--bg-3)" }}>
                      <b style={{ width: 26 }}>#{e.rank}</b><span className="grow">{e.name}{e.you ? " (you)" : ""} <span className="faint" style={{ textTransform: "capitalize", fontSize: "0.78rem" }}>{e.experience}</span></span><b className="num">{e.score}</b>
                    </div>
                  ))}
                  {!board.entries.length ? <div className="empty">Nobody has played today's challenge yet — be first.</div> : null}
                  <button className="btn primary" onClick={() => { setTab("practice"); playChallenge(); }}><Icon name="star" size={16} /> Play today's challenge</button>
                </div>
              )
            ) : null}
          </div>
        </aside>
      </div>
      <SymbolSearch open={searchOpen} onClose={() => setSearchOpen(false)} onPick={(s) => { setUseChallenge(false); setSymbol(cleanSymbol(s)); }} />
      <Paywall open={!!paywall} onClose={() => setPaywall(null)} info={paywall} />
      <Modal open={!!textEdit} onClose={() => setTextEdit(null)} title="Label">
        {textEdit ? (
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const d = eng.current.drawings.find((x) => x.id === textEdit.id);
            if (d && d.type === "text") eng.current.setText(textEdit.id, textEdit.value.trim());
            else { eng.current.select(textEdit.id); eng.current.updateSelected({ style: { text: textEdit.value.trim() } }); }
            setTextEdit(null);
          }}>
            <input className="input" autoFocus maxLength={60} value={textEdit.value} onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })} placeholder="e.g. Demand zone" />
            <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary">Save</button></div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}

export default function PracticePage() {
  return (
    <RequireAuth>
      <Suspense fallback={null}><PracticeInner /></Suspense>
    </RequireAuth>
  );
}

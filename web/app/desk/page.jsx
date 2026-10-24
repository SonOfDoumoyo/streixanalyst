"use client";
// My analysis: the analyses a person made their own. An AI analysis they edit arrives here with every drawing
// editable; they can move the entry, stop and target, add their own levels and notes, and ask the AI to grade it.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Icon from "@/components/Icons";
import { Mark } from "@/components/Brand";
import ChartView from "@/components/chart/ChartView";
import { AvatarMenu } from "@/components/SubNav";
import { useAuth } from "@/components/Providers";
import { FullScreenLoader, Modal, RequireAuth, Spinner } from "@/components/ui";
import Paywall from "@/components/Paywall";
import { ApiError, del, get, patch, post, qs } from "@/lib/api";
import { planFromDrawings } from "@/lib/analysis";
import { chartThemeFor } from "@/lib/chartTheme";
import { ALL_TFS, analysisTf, cleanSymbol, fmtPrice, timeAgo, TFS } from "@/lib/format";
import { StyleBar } from "@/components/terminal/DrawTools";
import { DrawingStudio, ToolDock } from "@/components/terminal/DrawingStudio";
import SymbolSearch from "@/components/terminal/SymbolSearch";

const SOURCE = { ai: ["From the analyst", "brand"], own: ["My own", ""], replay: ["Replay", "violet"] };

function useMobile() {
  const [m, setM] = useState(false);
  useEffect(() => {
    const f = () => setM(window.innerWidth <= 760);
    f();
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return m;
}

function ScoreRing({ score }) {
  if (score === null || score === undefined) return null;
  const tone = score >= 75 ? "up" : score >= 55 ? "brand" : "down";
  return (
    <span className={`desk-score ${tone}`} title="The AI's score for your plan, out of 100">
      <b className="num">{score}</b><small>/100</small>
    </span>
  );
}

function List({ items, busy, onNew, onOpen, onDelete }) {
  return (
    <div className="desk-list">
      <div className="desk-list-head">
        <div className="grow">
          <h1>My analysis</h1>
          <p className="muted">Your own analyses and the analyst&apos;s ones you edited. Open one to change it, then ask the AI to grade it.</p>
        </div>
        <button className="btn primary" onClick={onNew}><Icon name="plus" size={16} /> New analysis</button>
      </div>
      {busy ? <div className="empty"><Spinner /></div> : null}
      {!busy && !items.length ? (
        <div className="desk-empty">
          <Icon name="book" size={28} />
          <b>Nothing here yet</b>
          <p className="muted">On the chart, run the analyst and tap <b>Edit</b> on its plan: it arrives here with every drawing, ready to change. Or start your own.</p>
          <div className="row" style={{ gap: 8, justifyContent: "center" }}>
            <Link className="btn" href="/terminal"><Icon name="candles" size={15} /> Open the chart</Link>
            <button className="btn primary" onClick={onNew}><Icon name="plus" size={15} /> Start my own</button>
          </div>
        </div>
      ) : null}
      <div className="desk-cards">
        {items.map((it) => {
          const [src, tone] = SOURCE[it.source] || SOURCE.own;
          const p = it.plan;
          return (
            <div key={it.id} className="desk-card">
              <button className="desk-card-main" onClick={() => onOpen(it.id)}>
                <span className="row" style={{ gap: 8 }}>
                  <b className="grow">{it.title}</b>
                  {it.grade ? <ScoreRing score={it.grade.score} /> : null}
                </span>
                <span className="row wrap" style={{ gap: 6 }}>
                  <span className={`badge ${tone}`}>{src}</span>
                  <span className="badge">{it.symbol} · {it.tf}</span>
                  {p ? <span className={`badge ${p.side === "long" ? "up" : "down"}`}>{p.side === "long" ? "Buy" : "Sell"} {fmtPrice(p.entry, 5).replace(/0+$/, "").replace(/\.$/, "")}</span> : <span className="badge">no plan</span>}
                  {it.replay_at ? <span className="badge violet">{it.replay_at.slice(0, 16).replace("T", " ")}</span> : null}
                </span>
                <small className="faint">{it.drawings_count} drawings · edited {timeAgo(it.updated_at)}{it.graded_at ? ` · graded ${timeAgo(it.graded_at)}` : ""}</small>
              </button>
              <button className="icon-btn" onClick={() => onDelete(it)} aria-label="Delete"><Icon name="trash" size={16} /></button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GradeCard({ g, dec }) {
  if (!g) return null;
  const rev = g.review || {};
  return (
    <div className="desk-grade">
      <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        <div className="grow">
          <b>The AI&apos;s grade</b>
          <div className="hint">{timeAgo(g.at)} · on the candles at that moment</div>
        </div>
        <ScoreRing score={g.score} />
      </div>
      <p className="desk-sum">{g.summary}</p>
      {(rev.issues || []).length ? (
        <>
          <div className="desk-sub">What to fix</div>
          <ul className="check-list">{rev.issues.slice(0, 5).map((t, i) => <li key={i} className="no"><span className="ic">✗</span><span>{t}</span></li>)}</ul>
        </>
      ) : null}
      {(rev.fixes || []).length ? (
        <>
          <div className="desk-sub">Better levels</div>
          <ul className="check-list">{rev.fixes.slice(0, 4).map((f, i) => <li key={i} className="ok"><span className="ic">→</span><span>{typeof f === "string" ? f : f.text || JSON.stringify(f)}</span></li>)}</ul>
        </>
      ) : null}
      {(g.liquidity || []).map((n, i) => (
        <div key={i} className={`lc-note${n.ok ? "" : " warn"}`}><Icon name={n.ok ? "shield" : "alert"} size={14} /> {n.text}</div>
      ))}
      {g.ai && g.ai.action ? (
        <div className="desk-ai">
          <div className="desk-sub">The analyst now</div>
          <b>{g.ai.action}</b>{g.ai.confidence ? <span className={`conf conf-${g.ai.confidence}`} style={{ marginLeft: 8 }}>{g.ai.confidence}</span> : null}
          {g.ai.plan && g.ai.plan.entry ? <div className="hint num">EP {fmtPrice(g.ai.plan.entry, dec)} · SL {fmtPrice(g.ai.plan.sl, dec)} · TP {fmtPrice((g.ai.plan.tps || [])[0], dec)}</div> : null}
          {g.agrees_with_ai === false ? <div className="lc-note warn"><Icon name="alert" size={14} /> You and the analyst lean opposite ways.</div> : null}
        </div>
      ) : null}
      {g.mtf ? <div className="hint" style={{ marginTop: 8 }}>{g.mtf}</div> : null}
      {(g.levels || []).length ? (
        <details className="fold" style={{ marginTop: 10 }}>
          <summary>Your levels <span className="faint">{g.levels.length}</span></summary>
          <div className="stack" style={{ gap: 6, fontSize: "0.84rem" }}>
            {g.levels.map((u, i) => (
              <div key={i}><b>{u.label || u.type}</b>{" "}
                <span className="muted">{u.error || [u.level !== undefined ? fmtPrice(u.level, dec) : "", u.role, u.confluence && u.confluence.length ? `lines up with ${u.confluence.slice(0, 2).join(", ")}` : "no other level agrees"].filter(Boolean).join(" · ")}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function Editor({ id, onBack }) {
  const { settings, updateSettings, toast, refresh } = useAuth();
  const mobile = useMobile();
  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState(null);
  const [candleState, setCandleState] = useState({ loading: true, error: null, dec: 2 });
  const [tool, setToolState] = useState("cursor");
  const [magnet, setMagnetState] = useState(false);
  const [keep, setKeepState] = useState(false);
  const [locked, setLocked] = useState(false);
  const [visible, setVisible] = useState(true);
  const [studio, setStudio] = useState(false);
  const [toolStyle, setToolStyle] = useState({ emoji: "🎯", glyph: "★" });
  const [sel, setSel] = useState(null);
  const [plan, setPlan] = useState(null);
  const [grading, setGrading] = useState(false);
  const [saving, setSaving] = useState("");
  const [paywall, setPaywall] = useState(null);
  const [panel, setPanel] = useState(false);
  const [textEdit, setTextEdit] = useState(null);
  const eng = useRef(null);
  const [ready, setReady] = useState(false);
  const saveT = useRef(null);
  const theme = useMemo(() => chartThemeFor(settings.theme, settings.chart, settings.candles), [settings.theme, settings.chart, settings.candles]);

  useEffect(() => {
    get(`/my-analyses/${id}`).then((d) => {
      setDoc(d);
      const r = (x) => String(+Number(x).toPrecision(7));
      setPlan(d.plan ? { side: d.plan.side, entry: r(d.plan.entry), sl: r(d.plan.sl), tps: (d.plan.tps || []).map(r) } : null);
    }).catch((e) => setErr(e.message || "Couldn't open this analysis."));
  }, [id]);

  useEffect(() => {
    if (!eng.current) return;
    eng.current.setTheme(theme);
    eng.current.setOptions({ style: settings.candles.style, volume: settings.chart.volume, grid: settings.chart.grid, watermark: true, indicators: settings.indicators, rsi: false });
    eng.current.toolStyle = toolStyle;
  }, [ready, theme, settings.candles.style, settings.chart, settings.indicators, toolStyle]);

  // candles at the analysis' moment (now, or the replay moment) and the drawings
  useEffect(() => {
    if (!ready || !doc || !eng.current) return;
    let alive = true;
    const params = { symbol: doc.symbol, tf: doc.tf, bars: 600 };
    if (doc.replay_at) Object.assign(params, { at: doc.replay_at, ahead: 0 });
    setCandleState({ loading: true, error: null, dec: 2 });
    get(`/market/candles?${qs(params)}`).then((d) => {
      if (!alive || !eng.current) return;
      eng.current.setData(d.candles, { tfSec: d.tf_seconds, decimals: d.decimals, label: `${d.display} · ${doc.tf}` });
      eng.current.setDrawings(doc.drawings || []);
      setCandleState({ loading: false, error: null, dec: d.decimals });
    }).catch((e) => {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 402) setPaywall({ message: e.message, detail: e.detail });
      setCandleState({ loading: false, error: e.message || "The chart didn't load.", dec: 2 });
      if (eng.current) eng.current.setDrawings(doc.drawings || []);
    });
    return () => { alive = false; };
  }, [ready, doc && doc.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const savePatch = useCallback((body, quiet = true) => {
    setSaving("Saving…");
    return patch(`/my-analyses/${id}`, body).then((d) => {
      setSaving("Saved");
      setDoc((x) => (x ? { ...x, ...d, drawings: x.drawings } : d));
      return d;
    }).catch((e) => {
      setSaving("");
      if (!quiet || e.status !== 422) toast(e.message || "Couldn't save.", "error");
      throw e;
    });
  }, [id, toast]);

  const onEvent = useCallback((type, data) => {
    if (type === "select") setSel(data);
    else if (type === "toolDone") setToolState("cursor");
    else if (type === "requestText") {
      const d = eng.current && eng.current.drawings.find((x) => x.id === data);
      setTextEdit({ id: data, value: (d && d.style.text) || "" });
    } else if (type === "drawings") {
      clearTimeout(saveT.current);
      setSaving("Unsaved changes");
      saveT.current = setTimeout(() => savePatch({ drawings: data }).catch(() => {}), 900);
      const p = planFromDrawings(data);
      if (p) setPlan((cur) => ({ side: p.side, entry: String(+p.entry.toPrecision(7)), sl: String(+p.sl.toPrecision(7)),
        tps: [String(+p.tps[0].toPrecision(7)), ...((cur && cur.tps) || []).slice(1)] }));
    }
  }, [savePatch]);

  const setTool = (t) => { setToolState(t); if (eng.current) eng.current.setTool(t); };
  const setMagnet = (m) => { setMagnetState(m); if (eng.current) eng.current.magnet = m; };
  const setKeep = (b) => { setKeepState(b); if (eng.current) eng.current.keepDrawing = b; };
  const setLock = (b) => { setLocked(b); if (eng.current) eng.current.lockAll(b); };
  const setVis = (b) => { setVisible(b); if (eng.current) eng.current.setDrawingsVisible(b); };

  const planBody = () => {
    if (!plan) return null;
    const n = (x) => Number(String(x).replace(/,/g, ""));
    const tps = (plan.tps || []).map(n).filter((x) => Number.isFinite(x) && x > 0);
    return { side: plan.side, entry: n(plan.entry), sl: n(plan.sl), tps };
  };
  const savePlan = async () => {
    const b = planBody();
    try {
      await savePatch(b ? { plan: b } : { clear_plan: true }, false);
      toast("Plan saved.", "success", 1600);
    } catch { /* toast shown */ }
  };
  const putOnChart = () => {
    const b = planBody();
    if (!b || !eng.current || !eng.current.raw.length) return;
    const last = eng.current.raw[eng.current.raw.length - 1].t;
    const step = eng.current.tfSec || 3600;
    const old = eng.current.getDrawings().filter((d) => d.type === "long" || d.type === "short");
    old.forEach((d) => eng.current.deleteDrawing(d.id));
    eng.current.addDrawing({ type: b.side === "short" ? "short" : "long", points: [{ t: last + step, p: b.entry }, { t: last + step * 25, p: b.sl }, { t: last + step * 25, p: b.tps[0] || b.entry }], style: {} });
  };
  const gradeIt = async () => {
    const b = planBody();
    setGrading(true);
    try {
      clearTimeout(saveT.current);
      await savePatch({ drawings: eng.current ? eng.current.getDrawings() : doc.drawings, ...(b ? { plan: b } : {}) }, false);
      const d = await post(`/my-analyses/${id}/grade`);
      setDoc((x) => ({ ...x, grade: d.grade, graded_at: d.graded_at }));
      if (mobile) setPanel(true);
      refresh();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 402 || e.status === 429)) setPaywall({ message: e.message, detail: e.detail });
      else if (e.message) toast(e.message, "error");
    } finally {
      setGrading(false);
    }
  };
  const rename = (title) => savePatch({ title }).catch(() => {});
  const copyPlan = async () => {
    const b = planBody();
    if (!b) return;
    const text = `${doc.symbol} ${doc.tf} ${b.side === "long" ? "BUY" : "SELL"}\nEP ${b.entry}\nSL ${b.sl}\n${b.tps.map((t, i) => `TP${i + 1} ${t}`).join("\n")}`;
    try { await navigator.clipboard.writeText(text); toast("Plan copied", "success", 1500); } catch { toast(text, "info", 6000); }
  };

  if (err) return <div className="desk-wrap"><div className="desk-empty"><Icon name="alert" size={26} /><b>{err}</b><button className="btn" onClick={onBack}>Back to my analyses</button></div></div>;
  if (!doc) return <FullScreenLoader text="Opening your analysis" />;
  const dec = candleState.dec;
  const d1 = plan && Number(plan.entry) && Number(plan.sl) ? Math.abs(Number(plan.entry) - Number(plan.sl)) : 0;
  const rr = plan && d1 ? (plan.tps || []).map((t) => (Number(t) ? Math.abs(Number(t) - Number(plan.entry)) / d1 : null)) : [];
  const side = (
    <div className="desk-side">
      <section>
        <div className="row" style={{ marginBottom: 8 }}>
          <b className="grow">Your plan</b>
          {plan ? <button className="btn sm ghost" onClick={() => { setPlan(null); savePatch({ clear_plan: true }).catch(() => {}); }}>Remove</button> : null}
        </div>
        {plan ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className="seg">
              <button className={plan.side === "long" ? "on" : ""} onClick={() => setPlan({ ...plan, side: "long" })}>Buy</button>
              <button className={plan.side === "short" ? "on" : ""} onClick={() => setPlan({ ...plan, side: "short" })}>Sell</button>
            </div>
            {[["entry", "Entry (EP)"], ["sl", "Stop loss (SL)"]].map(([k, l]) => (
              <label key={k} className="desk-lvl"><span>{l}</span>
                <input className="input sm num" inputMode="decimal" value={plan[k]} onChange={(e) => setPlan({ ...plan, [k]: e.target.value })} />
              </label>
            ))}
            {[0, 1, 2].map((i) => (
              <label key={i} className="desk-lvl"><span>TP{i + 1}{rr[i] ? <small className="faint num"> {rr[i].toFixed(1)}R</small> : null}</span>
                <input className="input sm num" inputMode="decimal" value={(plan.tps || [])[i] || ""} placeholder={i ? "optional" : ""}
                  onChange={(e) => { const tps = [...(plan.tps || [])]; tps[i] = e.target.value; setPlan({ ...plan, tps }); }} />
              </label>
            ))}
            <div className="row wrap" style={{ gap: 6 }}>
              <button className="btn sm" onClick={savePlan}><Icon name="check" size={14} /> Save plan</button>
              <button className="btn sm" onClick={putOnChart}><Icon name="pen" size={14} /> Show on chart</button>
              <button className="btn sm" onClick={copyPlan}><Icon name="copy" size={14} /> Copy</button>
            </div>
            <div className="hint">Drag the position on the chart and these numbers follow.</div>
          </div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            <p className="hint" style={{ margin: 0 }}>No trade plan. Draw a long or short position on the chart, or type the levels.</p>
            <button className="btn sm" onClick={() => setPlan({ side: "long", entry: "", sl: "", tps: [""] })}><Icon name="plus" size={14} /> Add entry, stop and target</button>
          </div>
        )}
      </section>
      <button className="btn primary block" onClick={gradeIt} disabled={grading}>
        {grading ? <span className="spinner" /> : <Icon name="sparkles" size={16} />} {grading ? "Grading…" : doc.grade ? "Grade it again" : "Grade my analysis"}
      </button>
      <GradeCard g={doc.grade} dec={dec} />
      {doc.ai && doc.ai.action ? (
        <section className="desk-ai">
          <div className="desk-sub">The analyst&apos;s original call</div>
          <b>{doc.ai.action}</b>
          {doc.ai.headline ? <div className="hint">{doc.ai.headline}</div> : null}
          {doc.ai.plan && doc.ai.plan.entry ? <div className="hint num">EP {fmtPrice(doc.ai.plan.entry, dec)} · SL {fmtPrice(doc.ai.plan.sl, dec)} · TP {fmtPrice((doc.ai.plan.tps || [])[0], dec)}</div> : null}
        </section>
      ) : null}
      <section>
        <div className="desk-sub">Notes</div>
        <textarea className="textarea" rows={4} defaultValue={doc.notes || ""} maxLength={4000} placeholder="Why you'd take it, what would cancel it…"
          onBlur={(e) => e.target.value !== (doc.notes || "") && savePatch({ notes: e.target.value }).catch(() => {})} />
      </section>
      <div className="hint">Analysis can change with every new candle and differs between timeframes. A grade is a second opinion, not a promise.</div>
    </div>
  );
  return (
    <div className="desk-ed">
      <header className="topbar">
        <button className="icon-btn" onClick={onBack} aria-label="Back to my analyses"><Icon name="chevronLeft" /></button>
        {!mobile ? <Mark size={28} /> : null}
        <input className="desk-title" defaultValue={doc.title} maxLength={120} aria-label="Title" onBlur={(e) => e.target.value.trim() && e.target.value !== doc.title && rename(e.target.value.trim())} />
        <span className="badge hide-mobile">{doc.symbol} · {doc.tf}</span>
        {doc.replay_at ? <span className="badge violet hide-mobile">Replay {doc.replay_at.slice(0, 16).replace("T", " ")}</span> : null}
        <div className="grow" />
        <span className="faint hide-mobile" style={{ fontSize: "0.8rem" }}>{saving}</span>
        <Link className="btn sm ghost hide-mobile" href={`/terminal?s=${encodeURIComponent(doc.symbol)}&tf=${doc.tf}`}><Icon name="candles" size={15} /> Live chart</Link>
        {mobile ? <button className={`icon-btn ${panel ? "active" : ""}`} onClick={() => setPanel(!panel)} aria-label="Plan and grade"><Icon name="list" /></button> : null}
        <AvatarMenu />
      </header>
      <div className="desk-body">
        <div className="chart-wrap" style={{ "--chart-bg": theme.bg }}>
          <ChartView onReady={(e) => { eng.current = e; setReady(!!e); }} onEvent={onEvent} />
          <div className="legend"><div className="l1"><b>{doc.symbol}</b><span className="faint">{doc.tf}{doc.replay_at ? " · replay" : ""}</span></div></div>
          {sel ? (
            <StyleBar drawing={sel} onStyle={(s) => eng.current && eng.current.updateSelected({ style: s })}
              onDelete={() => eng.current && eng.current.deleteSelected()} onClone={() => eng.current && eng.current.cloneSelected()}
              onLock={() => eng.current && eng.current.updateSelected({ locked: !sel.locked })} onReview={null}
              onEditText={() => setTextEdit({ id: sel.id, value: sel.style.text || "" })} />
          ) : null}
          <ToolDock tool={tool} setTool={setTool} favorites={(settings.toolFavorites || ["trendline", "hline", "rect", "fib", "long"]).slice(0, mobile ? 4 : 8)}
            onStudio={() => setStudio(true)} magnet={magnet} setMagnet={setMagnet} keep={keep} setKeep={setKeep} locked={locked} setLocked={setLock}
            visible={visible} setVisible={setVis} onUndo={() => eng.current && eng.current.undo()} onRedo={() => eng.current && eng.current.redo()}
            onClear={() => window.confirm("Remove every drawing in this analysis?") && eng.current && eng.current.clearDrawings()} />
          {candleState.loading ? <div className="chart-msg chart-loading"><div className="chart-loading-card"><Spinner /><span className="muted">Loading {doc.symbol}…</span></div></div> : null}
          {candleState.error ? <div className="chart-msg"><div className="card"><b>{candleState.error}</b><p className="hint">Your drawings and plan are safe.</p></div></div> : null}
        </div>
        <aside className={`desk-panel${!mobile || panel ? " open" : ""}`}>{side}</aside>
      </div>
      <DrawingStudio open={studio} onClose={() => setStudio(false)} tool={tool} setTool={setTool}
        favorites={settings.toolFavorites || ["trendline", "hline", "rect", "fib", "long"]} onFavorites={(f) => updateSettings({ toolFavorites: f })}
        toolStyle={toolStyle} setToolStyle={setToolStyle} />
      <Paywall open={!!paywall} onClose={() => setPaywall(null)} info={paywall} />
      <Modal open={!!textEdit} onClose={() => setTextEdit(null)} title="Label">
        {textEdit ? (
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            if (eng.current) {
              const d = eng.current.drawings.find((x) => x.id === textEdit.id);
              if (d && d.type === "text") eng.current.setText(textEdit.id, textEdit.value.trim());
              else { eng.current.select(textEdit.id); eng.current.updateSelected({ style: { text: textEdit.value.trim() } }); }
            }
            setTextEdit(null);
          }}>
            <input className="input" autoFocus maxLength={80} value={textEdit.value} onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })} />
            <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary">Save</button></div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}

function Desk() {
  const sp = useSearchParams();
  const router = useRouter();
  const { toast, settings } = useAuth();
  const id = sp.get("id");
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const [symbol, setSymbol] = useState(() => cleanSymbol(settings.lastSymbol || "BTCUSDT"));
  const [tf, setTf] = useState(() => (ALL_TFS.includes(settings.lastTf) ? analysisTf(settings.lastTf) : "1h"));
  const [search, setSearch] = useState(false);
  const load = useCallback(() => {
    setBusy(true);
    get("/my-analyses").then((d) => setItems(d.items || [])).catch(() => {}).finally(() => setBusy(false));
  }, []);
  useEffect(() => { if (!id) load(); }, [id, load]);
  const open = (x) => router.push(`/desk?id=${x}`);
  const create = async () => {
    try {
      const d = await post("/my-analyses", { symbol, tf, title: `${symbol} · ${tf} · my analysis`, source: "own", drawings: [] });
      setNewOpen(false);
      open(d.id);
    } catch (e) {
      toast(e.message || "Couldn't start it.", "error");
    }
  };
  const remove = async (it) => {
    if (!window.confirm(`Delete “${it.title}”?`)) return;
    try {
      await del(`/my-analyses/${it.id}`);
      setItems((xs) => xs.filter((x) => x.id !== it.id));
    } catch (e) {
      toast(e.message || "Couldn't delete it.", "error");
    }
  };
  if (id) return <Editor id={Number(id)} onBack={() => router.push("/desk")} />;
  return (
    <div className="page desk-page">
      <header className="topbar">
        <Link href="/terminal" className="icon-btn" aria-label="Back to the chart"><Icon name="chevronLeft" /></Link>
        <Mark size={28} />
        <b style={{ fontSize: "1rem" }}>My analysis</b>
        <div className="grow" />
        <Link className="btn sm ghost" href="/terminal"><Icon name="candles" size={15} /> Chart</Link>
        <AvatarMenu />
      </header>
      <main className="desk-wrap">
        <List items={items} busy={busy} onNew={() => setNewOpen(true)} onOpen={open} onDelete={remove} />
      </main>
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New analysis">
        <div className="stack">
          <div className="field"><label>Market</label>
            <button className="mkt-chip" onClick={() => {setSearch(true); setNewOpen(false)}} style={{ maxWidth: "none" }}><span className="mkt-sym">{symbol}</span><Icon name="chevronDown" size={14} /></button>
          </div>
          <div className="field"><label>Timeframe</label>
            <div className="seg" style={{ flexWrap: "wrap" }}>{TFS.filter((t) => t !== "3D" && t !== "1M").map((t) => <button key={t} className={tf === t ? "on" : ""} onClick={() => setTf(t)}>{t}</button>)}</div>
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary" onClick={create}><Icon name="pen" size={15} /> Start drawing</button></div>
        </div>
      </Modal>
      <SymbolSearch open={search} onClose={() => setSearch(false)} onPick={(s) => { setSymbol(cleanSymbol(s)); setSearch(false); setNewOpen(true)}} watchlist={[]} onToggleWatch={() => {}} />
    </div>
  );
}

export default function DeskPage() {
  return (
    <RequireAuth>
      <Suspense fallback={<FullScreenLoader text="Opening My analysis" />}>
        <Desk />
      </Suspense>
    </RequireAuth>
  );
}

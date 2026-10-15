"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import Brand from "@/components/Brand";
import Icon from "@/components/Icons";
import ChartView from "@/components/chart/ChartView";
import Paywall from "@/components/Paywall";
import { useAuth } from "@/components/Providers";
import { RequireAuth } from "@/components/ui";
import { ApiError, get, post, qs } from "@/lib/api";
import { gradeClass, toOverlay, verdictTone } from "@/lib/analysis";
import { cleanSymbol, fmtChange, fmtPct, fmtPrice, TFS } from "@/lib/format";

function TV() {
  const { settings, toast } = useAuth();
  const sp = useSearchParams();
  const [list, setList] = useState([]);
  const [symbol, setSymbol] = useState(cleanSymbol(sp.get("s") || settings.lastSymbol || "BTCUSDT"));
  const [tf, setTf] = useState(TFS.includes(sp.get("tf")) ? sp.get("tf") : "1h");
  const [meta, setMeta] = useState(null);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState(1);
  const [rotate, setRotate] = useState(false);
  const [quotes, setQuotes] = useState({});
  const [paywall, setPaywall] = useState(null);
  const eng = useRef(null);
  const [ready, setReady] = useState(false);
  const scale = typeof window !== "undefined" && window.innerWidth >= 2200 ? 1.6 : 1.25;

  useEffect(() => {
    document.documentElement.setAttribute("data-tv", "1");
    get("/user/watchlist").then((d) => setList(d.symbols || [])).catch(() => {});
    return () => document.documentElement.removeAttribute("data-tv");
  }, []);

  useEffect(() => {
    if (!ready || !eng.current) return;
    const e = eng.current;
    e.setTheme({ bg: settings.chart.background, grid: settings.chart.gridColor, text: settings.chart.textColor, up: settings.candles.up, down: settings.candles.down,
      wickUp: settings.candles.wickUp, wickDown: settings.candles.wickDown, borderUp: settings.candles.borderUp, borderDown: settings.candles.borderDown });
    e.setOptions({ style: settings.candles.style, volume: true, indicators: settings.indicators });
    e.setDetail(detail);
  }, [ready, settings, detail]);

  useEffect(() => {
    if (!ready || !eng.current) return undefined;
    let alive = true;
    setRes(null);
    eng.current.clearAnalysis();
    get(`/market/candles?${qs({ symbol, tf, bars: 400 })}`).then((d) => {
      if (!alive || !eng.current) return;
      eng.current.setData(d.candles, { tfSec: d.tf_seconds, decimals: d.decimals, label: `${d.display} · ${tf}` });
      setMeta(d);
    }).catch((e) => toast(e.message, "error"));
    const t = setInterval(() => {
      get(`/market/latest?${qs({ symbol, tf })}`).then((d) => { if (alive && eng.current) { eng.current.updateTail(d.candles); setMeta((m) => (m ? { ...m, price: d.price } : m)); } }).catch(() => {});
    }, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [ready, symbol, tf, toast]);

  useEffect(() => {
    if (!list.length) return undefined;
    const load = () => get(`/market/quotes?${qs({ symbols: list.join(",") })}`).then((d) => {
      const m = {};
      for (const q of d.quotes || []) m[q.symbol.toUpperCase()] = q;
      setQuotes(m);
    }).catch(() => {});
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [list]);

  const analyse = useCallback(async () => {
    if (busy || !eng.current) return;
    setBusy(true);
    try {
      const a = settings.analysis;
      const d = await post("/analysis/run", { symbol, tf, account: Number(a.account) || 1000, risk_pct: Number(a.risk_pct) || 1, mode: "beginner" });
      setRes(d);
      const ov = toOverlay(d, { up: settings.candles.up, down: settings.candles.down, text: settings.chart.textColor });
      eng.current.setAnalysis(ov.items, { animate: true, pins: ov.pins });
      if (d.view) eng.current.fitTimes(d.candles[Math.max(0, d.view.x_from)][0], d.candles[d.candles.length - 1][0] + d.meta.tf_seconds * 30, 6);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 402 || e.status === 429)) setPaywall({ message: e.message, detail: e.detail });
      else toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  }, [busy, symbol, tf, settings, toast]);

  const step = useCallback((dir) => {
    if (!list.length) return;
    const i = list.findIndex((s) => s.toUpperCase() === symbol.toUpperCase());
    setSymbol(list[(i + dir + list.length) % list.length]);
  }, [list, symbol]);

  useEffect(() => {
    if (!rotate) return undefined;
    const t = setInterval(() => step(1), 20000);
    return () => clearInterval(t);
  }, [rotate, step]);

  useEffect(() => {
    const k = (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") step(1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") step(-1);
      else if (e.key.toLowerCase() === "a" || e.key === "Enter") analyse();
      else if (e.key.toLowerCase() === "d") setDetail((d) => (d % 3) + 1);
      else if (e.key.toLowerCase() === "f") document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
      else if (e.key.toLowerCase() === "r") setRotate((r) => !r);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [step, analyse]);

  const v = res && res.verdict;
  const p = res && res.plan;
  const dec = meta ? meta.decimals : 2;
  return (
    <div className="tv">
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        <div className="tv-head">
          <Brand href="/terminal" size={44} />
          <div className="grow" />
          <b style={{ fontSize: "1.6rem", fontFamily: "var(--font-display)" }}>{meta ? meta.display : symbol}</b>
          <span className="num" style={{ fontSize: "1.5rem", fontWeight: 800 }}>{meta ? fmtPrice(meta.price, dec) : ""}</span>
          <div className="seg brand">{["15m", "1h", "4h", "1D"].map((t) => <button key={t} className={tf === t ? "on" : ""} onClick={() => setTf(t)}>{t}</button>)}</div>
        </div>
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <ChartView scale={scale} onReady={(e) => { eng.current = e; setReady(!!e); }} />
          {busy ? <><div className="scanline" /><div className="analysing-card glass"><span className="spinner dark" /> Analysing…</div></> : null}
        </div>
        <div className="row" style={{ gap: 22, padding: "0.6rem 1.2rem", borderTop: "1px solid var(--line)", overflow: "hidden", whiteSpace: "nowrap" }}>
          {list.map((s) => {
            const q = quotes[s.toUpperCase()];
            return (
              <button key={s} onClick={() => setSymbol(s)} style={{ border: 0, background: "transparent", color: s === symbol ? "var(--brand-2)" : "var(--text)", fontWeight: 700, fontSize: "1rem" }}>
                {s.split(":").pop()} <span className={q && q.change >= 0 ? "up" : "down"}>{q ? fmtChange(q.change) : ""}</span>
              </button>
            );
          })}
        </div>
      </div>
      <aside className="tv-side">
        {!res ? (
          <div className="card" style={{ textAlign: "center", padding: "2rem 1.4rem" }}>
            <Icon name="zap" size={44} style={{ margin: "0 auto 0.8rem", color: "var(--brand-2)" }} />
            <h2 style={{ margin: "0 0 0.4rem", fontFamily: "var(--font-display)" }}>Press A to analyse</h2>
            <p className="muted" style={{ margin: "0 0 1.2rem" }}>← → change market · D detail · R rotate · F full screen</p>
            <button className="btn primary lg block" onClick={analyse} disabled={busy}><Icon name="zap" size={20} /> Analyse {meta ? meta.display : symbol}</button>
          </div>
        ) : (
          <>
            <div className={`verdict ${verdictTone(v)}`} style={{ padding: "1.2rem" }}>
              <div className="row">
                <div className="grow"><div className="act" style={{ fontSize: "1.7rem" }}>{v.action}</div><div className="muted">{p ? p.setup : v.headline}</div></div>
                <span className={`grade ${gradeClass(v.grade)}`} style={{ width: "3.4rem", height: "3.4rem", fontSize: "1.5rem" }}>{v.grade}</span>
              </div>
            </div>
            {p ? (
              <div className="plan-grid">
                <div className="plan-cell ep"><div className="k">Entry</div><div className="v num" style={{ fontSize: "1.3rem" }}>{fmtPrice(p.entry, dec)}</div></div>
                <div className="plan-cell sl"><div className="k">Stop</div><div className="v num" style={{ fontSize: "1.3rem" }}>{fmtPrice(p.sl, dec)}</div></div>
                <div className="plan-cell tp"><div className="k">Target</div><div className="v num" style={{ fontSize: "1.3rem" }}>{fmtPrice(p.tps[0], dec)}</div></div>
              </div>
            ) : null}
            {p ? (
              <div className="card" style={{ padding: "1rem" }}>
                <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">Target before stop</span><b>{fmtPct(p.p_tp[0])} <span className="faint">vs {fmtPct(p.breakeven[0])} needed</span></b></div>
                <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">Reward : risk</span><b>{Number(p.rr[0]).toFixed(2)}</b></div>
              </div>
            ) : null}
            <ul className="check-list" style={{ fontSize: "1rem" }}>
              {(p ? p.checklist : []).slice(0, 7).map((c, i) => <li key={i} className={c.ok ? "ok" : "no"}><span className="ic">{c.ok ? "✓" : "✗"}</span><span>{c.text}</span></li>)}
            </ul>
            {res.news && res.news.risk !== "low" ? <div className="badge down" style={{ height: "auto", padding: "0.6rem 0.8rem", whiteSpace: "normal" }}>{res.news.note}</div> : null}
            <div className="grow" />
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={analyse} disabled={busy}><Icon name="refresh" size={18} /> Refresh</button>
              <button className={`btn ${rotate ? "primary" : ""}`} onClick={() => setRotate(!rotate)}><Icon name={rotate ? "pause" : "play"} size={18} /> Rotate</button>
              <Link className="btn ghost" href={`/terminal?s=${encodeURIComponent(symbol)}&tf=${tf}`}>Exit</Link>
            </div>
          </>
        )}
      </aside>
      <Paywall open={!!paywall} onClose={() => setPaywall(null)} info={paywall} />
    </div>
  );
}

export default function TVPage() {
  return (
    <RequireAuth>
      <Suspense fallback={null}><TV /></Suspense>
    </RequireAuth>
  );
}

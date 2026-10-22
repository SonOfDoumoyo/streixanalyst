"use client";
// Watch my teacher: the live sessions of the teachers in my organization, and a read-only view of the chart a teacher
// is showing (TV mode: the teacher's account size, risk settings and email are never shared).
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Icon from "@/components/Icons";
import { Mark } from "@/components/Brand";
import ChartView from "@/components/chart/ChartView";
import { AvatarMenu } from "@/components/SubNav";
import { useAuth } from "@/components/Providers";
import { FullScreenLoader, RequireAuth, Spinner } from "@/components/ui";
import { ApiError, get, qs } from "@/lib/api";
import { gradeClass, toOverlay, verdictTone } from "@/lib/analysis";
import { chartThemeFor } from "@/lib/chartTheme";
import { fmtPrice, timeAgo } from "@/lib/format";

function Sessions() {
  const router = useRouter();
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => get("/class/live").then((x) => alive && setD(x)).catch((e) => alive && setD({ items: [], note: e.message }));
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return (
    <main className="mk-wrap">
      <h1 className="mk-title">Watch my teacher</h1>
      <p className="muted" style={{ maxWidth: "60ch" }}>When a teacher in your organization shows their chart, it appears here. You see their market, drawings and analysis as they work, live or in a replay.</p>
      {d === null ? <div className="empty"><Spinner /></div> : null}
      {d && !d.items.length ? (
        <div className="desk-empty">
          <Icon name="tv" size={26} />
          <b>No teacher is live right now</b>
          <p className="muted">{d.note || "This page checks every few seconds. Leave it open and the session appears when your teacher starts."}</p>
        </div>
      ) : null}
      <div className="idea-grid">
        {(d ? d.items : []).map((s) => (
          <button key={s.teacher_id} className="idea-card" onClick={() => router.push(`/class?t=${s.teacher_id}`)}>
            <span className="row" style={{ gap: 8 }}><span className="live-pill"><i /> Live</span><span className="grow" /><span className="faint" style={{ fontSize: "0.78rem" }}>since {timeAgo(s.started_at)}</span></span>
            <b className="idea-title">{s.title || `${s.teacher}'s chart`}</b>
            <span className="idea-ex">{s.teacher} · {s.symbol} · {s.tf}{s.replay ? " · replay" : ""}</span>
          </button>
        ))}
      </div>
    </main>
  );
}

function Watch({ tid }) {
  const { settings } = useAuth();
  const router = useRouter();
  const [live, setLive] = useState(null);
  const [err, setErr] = useState(null);
  const [chartErr, setChartErr] = useState(null);
  const eng = useRef(null);
  const [ready, setReady] = useState(false);
  const loadedKey = useRef("");
  const theme = useMemo(() => chartThemeFor(settings.theme, settings.chart, settings.candles), [settings.theme, settings.chart, settings.candles]);

  useEffect(() => {
    document.documentElement.setAttribute("data-tv", "1");
    return () => document.documentElement.removeAttribute("data-tv");
  }, []);
  useEffect(() => {
    if (!eng.current) return;
    eng.current.setTheme(theme);
    eng.current.setOptions({ style: settings.candles.style, volume: true, watermark: true, indicators: settings.indicators });
  }, [ready, theme, settings.candles.style, settings.indicators]);

  // the teacher's state, every 3 seconds
  useEffect(() => {
    let alive = true;
    const poll = () => get(`/class/live/${tid}`).then((d) => { if (alive) { setLive(d); setErr(null); } })
      .catch((e) => alive && setErr(e.message || "This session isn't available."));
    poll();
    const t = setInterval(() => document.visibilityState === "visible" && poll(), 3000);
    return () => { alive = false; clearInterval(t); };
  }, [tid]);

  const st = live && live.state;
  const key = st ? `${st.symbol}|${st.tf}|${st.replay ? `${st.replay.at}|${st.replay.ahead}` : "live"}` : "";
  // candles when the teacher changes market, interval or replay moment
  useEffect(() => {
    if (!ready || !st || !eng.current || loadedKey.current === key) return;
    loadedKey.current = key;
    const params = { symbol: st.symbol, tf: st.tf, bars: 600 };
    if (st.replay) Object.assign(params, { at: st.replay.at, ahead: st.replay.ahead || 0 });
    setChartErr(null);
    get(`/market/candles?${qs(params)}`).then((d) => {
      if (!eng.current) return;
      eng.current.setData(d.candles, { tfSec: d.tf_seconds, decimals: d.decimals, label: `${d.display} · ${st.tf}` });
    }).catch((e) => setChartErr(e instanceof ApiError && e.status === 402 ? "Replays need Pro or the free trial to watch." : e.message));
  }, [ready, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // drawings and analysis on every update; the chart follows the latest candle while live
  useEffect(() => {
    if (!ready || !st || !eng.current) return;
    eng.current.setDrawings(st.drawings || []);
    eng.current.lockAll(true);
    const a = st.analysis;
    if (a && a.drawings) {
      const ov = toOverlay(a, theme);
      eng.current.setScope(a.layers_scope || null);
      eng.current.setAnalysis(ov.items, { animate: false, pins: ov.pins });
    } else eng.current.clearAnalysis();
  }, [ready, live]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ready || !st || st.replay) return undefined;
    const t = setInterval(() => {
      if (document.hidden) return;
      get(`/market/latest?${qs({ symbol: st.symbol, tf: st.tf })}`).then((d) => eng.current && eng.current.updateTail(d.candles)).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [ready, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const a = st && st.analysis;
  const v = a && a.verdict;
  const p = a && a.plan;
  const dec = p && p.entry ? (p.entry >= 1000 ? 2 : p.entry >= 10 ? 3 : p.entry >= 1 ? 4 : 6) : 2;
  return (
    <div className="class-watch">
      <header className="topbar">
        <button className="icon-btn" onClick={() => router.push("/class")} aria-label="All sessions"><Icon name="chevronLeft" /></button>
        <Mark size={28} />
        <b className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{live ? (live.title || `${live.teacher}'s chart`) : "Joining…"}</b>
        {live && live.live ? <span className="live-pill"><i /> Live</span> : live ? <span className="badge">Offline</span> : null}
        {st ? <span className="badge hide-mobile">{st.symbol} · {st.tf}{st.replay ? ` · replay ${String(st.replay.at).slice(0, 16).replace("T", " ")}` : ""}</span> : null}
        <AvatarMenu />
      </header>
      <div className="chart-wrap" style={{ "--chart-bg": theme.bg }}>
        <ChartView onReady={(e) => { eng.current = e; setReady(!!e); }} />
        {v ? (
          <div className={`class-verdict ${verdictTone(v)}`}>
            <div className="row" style={{ gap: 10 }}>
              <b className="grow">{v.action}</b>
              {v.grade ? <span className={`grade ${gradeClass(v.grade)}`} style={{ width: 32, height: 32 }}>{v.grade}</span> : null}
            </div>
            {p && p.entry ? <div className="num faint" style={{ fontSize: "0.82rem" }}>EP {fmtPrice(p.entry, dec)} · SL {fmtPrice(p.sl, dec)} · TP {fmtPrice((p.tps || [])[0], dec)}</div> : null}
          </div>
        ) : null}
        {st && st.note ? <div className="class-note">{st.note}</div> : null}
        {err || (live && !live.live) ? (
          <div className="chart-msg"><div className="card"><Icon name="tv" size={26} style={{ margin: "0 auto 8px" }} /><b>{err || "Your teacher stopped sharing."}</b><p className="hint">This page reconnects when they start again.</p></div></div>
        ) : null}
        {chartErr ? <div className="chart-msg"><div className="card"><b>{chartErr}</b></div></div> : null}
        {!live && !err ? <div className="chart-msg chart-loading"><div className="chart-loading-card"><Spinner /><span className="muted">Joining the session…</span></div></div> : null}
      </div>
    </div>
  );
}

function ClassPage() {
  const sp = useSearchParams();
  const t = sp.get("t");
  if (t) return <Watch tid={Number(t)} />;
  return (
    <div className="page mk-page">
      <header className="topbar">
        <Link href="/terminal" className="icon-btn" aria-label="Back to the chart"><Icon name="chevronLeft" /></Link>
        <Mark size={28} />
        <b>Classroom</b>
        <div className="grow" />
        <AvatarMenu />
      </header>
      <Sessions />
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <Suspense fallback={<FullScreenLoader text="Opening the classroom" />}>
        <ClassPage />
      </Suspense>
    </RequireAuth>
  );
}

"use client";
// Markets & ideas: prices across crypto, forex, metals and indices, today's biggest moves, the week's calendar, and
// ideas other traders published. Every market opens on the chart.
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Icon from "@/components/Icons";
import { Mark } from "@/components/Brand";
import { AvatarMenu } from "@/components/SubNav";
import { useAuth } from "@/components/Providers";
import { FullScreenLoader, Modal, RequireAuth, Spinner } from "@/components/ui";
import { del, get, post, qs } from "@/lib/api";
import { fmtChange, fmtPrice, minutesHuman, timeAgo } from "@/lib/format";

const SECTIONS = [
  ["Crypto", ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "ADAUSDT", "PEPEUSDT"]],
  ["Forex", ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "EURJPY", "GBPJPY"]],
  ["Metals & indices", ["XAUUSD", "XAGUSD", "US30", "NAS100", "US500", "GER40"]],
];
const TABS = [["overview", "Markets"], ["ideas", "Ideas"], ["calendar", "Calendar"], ["news", "News"]];

const chartHref = (s, tf = "1h") => `/terminal?s=${encodeURIComponent(s)}&tf=${tf}`;

function Tile({ q, sym }) {
  const ch = q && q.change;
  return (
    <Link href={chartHref(sym)} className={`mk-tile${ch === null || ch === undefined ? "" : ch >= 0 ? " up" : " down"}`}>
      <b>{(q && q.display) || sym}</b>
      <span className="num mk-px">{q && !q.error ? fmtPrice(q.price, q.decimals) : "–"}</span>
      <span className={`num mk-ch ${ch >= 0 ? "up" : "down"}`}>{ch === null || ch === undefined ? (q && q.error ? "no data" : "") : fmtChange(ch)}</span>
    </Link>
  );
}

function Overview({ watch }) {
  const all = useMemo(() => [...new Set([...watch, ...SECTIONS.flatMap(([, s]) => s)])], [watch]);
  const [quotes, setQuotes] = useState({});
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let alive = true;
    const load = () => get(`/market/quotes?${qs({ symbols: all.slice(0, 40).join(",") })}`)
      .then((d) => alive && setQuotes(Object.fromEntries((d.quotes || []).map((q) => [q.symbol, q]))))
      .catch(() => {}).finally(() => alive && setBusy(false));
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 30000);
    return () => { alive = false; clearInterval(t); };
  }, [all]);
  const movers = Object.values(quotes).filter((q) => !q.error && Number.isFinite(q.change)).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 6);
  return (
    <div className="stack" style={{ gap: 22 }}>
      {busy ? <div className="empty"><Spinner /></div> : null}
      {movers.length ? (
        <section>
          <h2 className="mk-h">Biggest moves today</h2>
          <div className="mk-movers">
            {movers.map((q) => (
              <Link key={q.symbol} href={chartHref(q.symbol)} className="mk-mover">
                <span className={`mk-bar ${q.change >= 0 ? "up" : "down"}`} style={{ "--w": `${Math.min(100, Math.abs(q.change) * 12)}%` }} />
                <b>{q.display}</b>
                <span className={`num ${q.change >= 0 ? "up" : "down"}`}>{fmtChange(q.change)}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      {watch.length ? (
        <section>
          <h2 className="mk-h">Your watchlist</h2>
          <div className="mk-grid">{watch.map((s) => <Tile key={s} sym={s} q={quotes[s]} />)}</div>
        </section>
      ) : null}
      {SECTIONS.map(([name, syms]) => (
        <section key={name}>
          <h2 className="mk-h">{name}</h2>
          <div className="mk-grid">{syms.map((s) => <Tile key={s} sym={s} q={quotes[s]} />)}</div>
        </section>
      ))}
      <p className="hint">Change is against today&apos;s open. Tap a market to open its chart and run the analyst.</p>
    </div>
  );
}

function IdeaCard({ it, onOpen }) {
  return (
    <button className="idea-card" onClick={() => onOpen(it)}>
      <span className="row" style={{ gap: 6 }}>
        <span className={`badge ${it.side === "long" ? "up" : it.side === "short" ? "down" : ""}`}>{it.side === "long" ? "Long" : it.side === "short" ? "Short" : "Education"}</span>
        <span className="badge">{it.symbol} · {it.tf}</span>
        <span className="grow" />
        <span className="faint" style={{ fontSize: "0.78rem" }}><Icon name="star" size={12} style={{ display: "inline", verticalAlign: -2 }} /> {it.likes}</span>
      </span>
      <b className="idea-title">{it.title}</b>
      {it.excerpt ? <span className="idea-ex">{it.excerpt}</span> : null}
      <small className="faint">{it.author ? it.author.name : "A trader"} · {timeAgo(it.created_at)}</small>
    </button>
  );
}

function Ideas() {
  const { user, toast } = useAuth();
  const router = useRouter();
  const [scope, setScope] = useState("latest");
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(true);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => {
    setBusy(true);
    get(`/ideas?${qs({ scope })}`).then((d) => setItems(d.items || [])).catch(() => setItems([])).finally(() => setBusy(false));
  }, [scope]);
  useEffect(load, [load]);
  const view = async (it) => {
    setOpen({ ...it, loading: true });
    try {
      setOpen(await get(`/ideas/${it.id}`));
    } catch (e) {
      toast(e.message || "Couldn't open the idea.", "error");
      setOpen(null);
    }
  };
  const like = async () => {
    try {
      const d = await post(`/ideas/${open.id}/like`);
      setOpen((o) => ({ ...o, ...d }));
      setItems((xs) => xs.map((x) => (x.id === open.id ? { ...x, likes: d.likes, liked: d.liked } : x)));
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const remove = async () => {
    if (!window.confirm("Delete this idea?")) return;
    try {
      await del(`/ideas/${open.id}`);
      setItems((xs) => xs.filter((x) => x.id !== open.id));
      setOpen(null);
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const dec = open && open.price ? (open.price >= 1000 ? 2 : open.price >= 10 ? 3 : open.price >= 1 ? 4 : 6) : 2;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="ds-cats" style={{ margin: 0 }}>
          {[["latest", "Latest"], ["top", "Most liked"], ["mine", "Mine"]].map(([id, l]) => <button key={id} className={scope === id ? "on" : ""} onClick={() => setScope(id)}>{l}</button>)}
        </div>
        <span className="grow" />
        <Link className="btn sm" href="/terminal"><Icon name="upload" size={14} /> Publish from the chart</Link>
      </div>
      {busy ? <div className="empty"><Spinner /></div> : null}
      {!busy && !items.length ? (
        <div className="desk-empty">
          <Icon name="users" size={26} />
          <b>{scope === "mine" ? "You haven't published an idea yet" : "No ideas yet"}</b>
          <p className="muted">On the chart, open the toolbox and choose Publish an idea. Your drawings and reasoning go with it.</p>
        </div>
      ) : null}
      <div className="idea-grid">{items.map((it) => <IdeaCard key={it.id} it={it} onOpen={view} />)}</div>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? open.title : ""} wide>
        {open && !open.loading ? (
          <div className="stack" style={{ gap: 12 }}>
            <div className="row wrap" style={{ gap: 6 }}>
              <span className={`badge ${open.side === "long" ? "up" : open.side === "short" ? "down" : ""}`}>{open.side === "long" ? "Long" : open.side === "short" ? "Short" : "Education"}</span>
              <span className="badge">{open.symbol} · {open.tf}</span>
              {open.price ? <span className="badge num">at {fmtPrice(open.price, dec)}</span> : null}
              <span className="faint" style={{ fontSize: "0.8rem" }}>{open.author ? open.author.name : ""} · {timeAgo(open.created_at)}</span>
            </div>
            {open.plan && open.plan.entry ? (
              <div className="wi-levels num">
                <span>EP <b>{fmtPrice(open.plan.entry, dec)}</b></span><span>SL <b className="down">{fmtPrice(open.plan.sl, dec)}</b></span>
                {(open.plan.tps || []).slice(0, 2).map((t, i) => <span key={i}>TP{i + 1} <b className="up">{fmtPrice(t, dec)}</b></span>)}
              </div>
            ) : null}
            <div className="idea-body">{open.body || "No write-up."}</div>
            <div className="hint">{(open.drawings || []).length} drawings were published with it. Ideas are opinions, not advice.</div>
            <div className="row wrap" style={{ gap: 8, justifyContent: "flex-end" }}>
              {user && open.author && open.author.id === user.id ? <button className="btn sm danger" onClick={remove}><Icon name="trash" size={14} /> Delete</button> : null}
              <button className={`btn sm${open.liked ? " primary" : ""}`} onClick={like}><Icon name="star" size={14} /> {open.liked ? "Liked" : "Like"} · {open.likes}</button>
              <button className="btn sm primary" onClick={() => router.push(chartHref(open.symbol, open.tf))}><Icon name="candles" size={14} /> Open the chart</button>
            </div>
          </div>
        ) : <div className="empty"><Spinner /></div>}
      </Modal>
    </div>
  );
}

function Calendar() {
  const [events, setEvents] = useState(null);
  const [impact, setImpact] = useState("High");
  useEffect(() => {
    setEvents(null);
    get(`/news/calendar?${qs({ days: 7, impact: impact === "High" ? "High" : "High,Medium" })}`).then((d) => setEvents(d.events || [])).catch(() => setEvents([]));
  }, [impact]);
  const byDay = useMemo(() => {
    const m = new Map();
    for (const e of events || []) {
      const day = new Date(Date.now() + e.minutes_until * 60000).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
      if (!m.has(day)) m.set(day, []);
      m.get(day).push(e);
    }
    return [...m.entries()];
  }, [events]);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="ds-cats" style={{ margin: 0 }}>
        {[["High", "High impact"], ["Medium", "High & medium"]].map(([id, l]) => <button key={id} className={impact === id ? "on" : ""} onClick={() => setImpact(id)}>{l}</button>)}
      </div>
      {events === null ? <div className="empty"><Spinner /></div> : null}
      {events && !events.length ? <p className="muted">No events in the next 7 days, or the calendar couldn&apos;t be reached.</p> : null}
      {byDay.map(([day, evs]) => (
        <section key={day}>
          <h2 className="mk-h">{day}</h2>
          <div className="cal-list">
            {evs.map((e, i) => (
              <div key={i} className="cal-row">
                <span className="num cal-t">{new Date(Date.now() + e.minutes_until * 60000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
                <span className={`badge ${e.impact === "High" ? "down" : "warn"}`}>{e.country}</span>
                <span className="grow"><b>{e.title}</b><small className="faint">{e.minutes_until > 0 ? `in ${minutesHuman(e.minutes_until)}` : "released"}{e.forecast ? ` · forecast ${e.forecast}` : ""}{e.previous ? ` · previous ${e.previous}` : ""}</small></span>
              </div>
            ))}
          </div>
        </section>
      ))}
      <p className="hint">Times are in your time zone. Spreads widen and stops slip around high-impact releases.</p>
    </div>
  );
}

function News() {
  const [sym, setSym] = useState("BTCUSDT");
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    get(`/news/for?${qs({ symbol: sym, tf: "1h" })}`).then(setD).catch(() => setD({ headlines: [] }));
  }, [sym]);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="ds-cats" style={{ margin: 0 }}>
        {["BTCUSDT", "ETHUSDT", "EURUSD", "GBPUSD", "XAUUSD", "US30"].map((s) => <button key={s} className={sym === s ? "on" : ""} onClick={() => setSym(s)}>{s}</button>)}
      </div>
      {d === null ? <div className="empty"><Spinner /></div> : null}
      {d && d.note ? <div className={`lc-note${d.risk === "high" ? " down" : d.risk === "medium" ? " warn" : ""}`}><Icon name="info" size={14} /> {d.note}</div> : null}
      <div className="cal-list">
        {(d && d.headlines || []).map((h, i) => (
          <a key={i} className="cal-row news-row" href={h.link} target="_blank" rel="noopener noreferrer">
            <span className={`news-dot ${h.tone || ""}`} />
            <span className="grow"><b>{h.title}</b><small className="faint">{h.source}{h.published ? ` · ${timeAgo(h.published)}` : ""}</small></span>
            <Icon name="external" size={14} />
          </a>
        ))}
      </div>
      {d && !(d.headlines || []).length ? <p className="muted">No fresh headlines for {sym}.</p> : null}
    </div>
  );
}

function Markets() {
  const sp = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState(TABS.some(([t]) => t === sp.get("tab")) ? sp.get("tab") : "overview");
  const [watch, setWatch] = useState([]);
  useEffect(() => { get("/user/watchlist").then((d) => setWatch(d.symbols || [])).catch(() => {}); }, []);
  const pick = (t) => {
    setTab(t);
    router.replace(`/markets?tab=${t}`);
  };
  return (
    <div className="page mk-page">
      <header className="topbar">
        <Link href="/terminal" className="icon-btn" aria-label="Back to the chart"><Icon name="chevronLeft" /></Link>
        <span className="hide-mobile"><Mark size={28} /></span>
        <nav className="mk-tabs" role="tablist">
          {TABS.map(([id, l]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => pick(id)}>{l}</button>)}
        </nav>
        <div className="grow" />
        <Link className="btn sm ghost hide-mobile" href="/desk"><Icon name="book" size={15} /> My analysis</Link>
        <AvatarMenu />
      </header>
      <main className="mk-wrap">
        {tab === "overview" ? <Overview watch={watch} /> : null}
        {tab === "ideas" ? <Ideas /> : null}
        {tab === "calendar" ? <Calendar /> : null}
        {tab === "news" ? <News /> : null}
      </main>
    </div>
  );
}

export default function MarketsPage() {
  return (
    <RequireAuth>
      <Suspense fallback={<FullScreenLoader text="Loading markets" />}>
        <Markets />
      </Suspense>
    </RequireAuth>
  );
}

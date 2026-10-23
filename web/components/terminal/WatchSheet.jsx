"use client";
// Watch a pair for strategies: pick the pair and timeframe, tick the strategies, choose where the alert goes, press
// Start. The server scans every closed candle and sends each new setup to the bell, by email and to this phone or
// browser. Below the form: the watches you have, to pause or delete.
import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icons";
import Sheet from "@/components/terminal/Sheet";
import { useAuth } from "@/components/Providers";
import { useCatalog } from "@/components/StrategyPicker";
import { ApiError, del, get, patch, post } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { currentPushState, disablePush, enablePush, pushSupported } from "@/lib/push";

const TFS = ["1m", "5m", "15m", "30m", "1h", "4h", "1D"];

function pickTf(tf) {
  return TFS.includes(tf) ? tf : "15m";
}

export default function WatchSheet({ open, onClose, symbol, tf, onLimit, onBroker }) {
  const { user, toast } = useAuth();
  const cat = useCatalog();
  const [sym, setSym] = useState(symbol || "");
  const [frame, setFrame] = useState(pickTf(tf));
  const [sel, setSel] = useState([]);
  const [group, setGroup] = useState("all");
  const [email, setEmail] = useState(true);
  const [phone, setPhone] = useState(false);
  const [pushState, setPushState] = useState("off");
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [brokers, setBrokers] = useState([]);
  const [bid, setBid] = useState(null);
  const [auto, setAuto] = useState(false);
  const [liveOk, setLiveOk] = useState(false);

  const load = useCallback(() => get("/watches").then(setList).catch(() => setList({ items: [], active: 0, limit: null, email: false })), []);

  useEffect(() => {
    if (!open) return;
    setSym(symbol || "");
    setFrame(pickTf(tf));
    setNote(null);
    setSel((s) => (s.length ? s : ((user && user.strategies) || []).slice(0, 12)));
    load();
    setAuto(false);
    setLiveOk(false);
    get("/brokers").then((d) => { setBrokers(d.accounts || []); setBid((b) => (b && (d.accounts || []).some((a) => a.id === b) ? b : null)); }).catch(() => setBrokers([]));
    currentPushState().then((st) => { setPushState(st); setPhone(st === "on"); }).catch(() => {});
  }, [open, symbol, tf, user, load]);

  const byId = useMemo(() => Object.fromEntries(((cat && cat.strategies) || []).map((s) => [s.id, s])), [cat]);
  const shown = useMemo(() => ((cat && cat.strategies) || []).filter((s) => group === "all" || s.group === group), [cat, group]);
  const toggle = (id) => setSel((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : xs.length >= 12 ? xs : [...xs, id]));
  const emailOk = !!(list && list.email);

  const fail = (e) => {
    if (e instanceof ApiError && (e.status === 402 || e.status === 429) && onLimit) onLimit({ message: e.message, detail: e.detail });
    else toast(e.message, "error");
  };

  const togglePhone = async () => {
    if (phone) {
      setPhone(false);
      return;
    }
    if (pushState !== "on") {
      try {
        await enablePush();
        setPushState("on");
      } catch (e) {
        toast(e.message, "error", 6000);
        return;
      }
    }
    setPhone(true);
  };

  const start = async () => {
    if (!sel.length) return toast("Tick at least one strategy to watch for.", "error");
    if (!sym.trim()) return toast("Type the pair to watch, e.g. XAUUSD.", "error");
    setBusy(true);
    try {
      const r = await post("/watches", { symbol: sym.trim(), tf: frame, strategies: sel, email: email && emailOk, push: phone, broker_id: bid, auto_send: !!(bid && auto), live_ok: liveOk });
      const live = r.live || [];
      setNote(live.length
        ? `Watching ${r.watch.symbol} ${r.watch.tf}. ${live.map((x) => x.name).join(", ")} ${live.length > 1 ? "are" : "is"} already live, so you won't get that one again; the next new setup alerts you.`
        : `Watching ${r.watch.symbol} ${r.watch.tf}. You'll be alerted when one of ${sel.length === 1 ? "your strategy" : `your ${sel.length} strategies`} fires.`);
      load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const flip = async (w) => {
    try {
      await patch(`/watches/${w.id}`, { status: w.status === "active" ? "paused" : "active" });
      load();
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (w) => {
    try {
      await del(`/watches/${w.id}`);
      load();
    } catch (e) {
      fail(e);
    }
  };
  const testEmail = async () => {
    try {
      const r = await post("/watches/test-email", {});
      toast(`Test email sent to ${r.to}. Check your inbox and spam.`, "success", 6000);
    } catch (e) {
      toast(e.message, "error", 6000);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Watch for setups" wide
      footer={<button className="btn primary" style={{ width: "100%", justifyContent: "center" }} onClick={start} disabled={busy || !sel.length}>
        {busy ? <span className="spinner" /> : <Icon name="eye" size={16} />} Start watching{sel.length ? ` · ${sel.length} strateg${sel.length > 1 ? "ies" : "y"}` : ""}
      </button>}>
      <div className="wt">
        <p className="wt-lead">Pick a pair and the strategies you trade. When one of them finds a setup on a closed candle, you get an alert with the entry, stop and target.</p>

        <section className="wt-sec">
          <h4>Pair</h4>
          <div className="wt-pair">
            <input className="input" value={sym} onChange={(e) => setSym(e.target.value.toUpperCase())} placeholder="XAUUSD, BTCUSDT, EURUSD…" aria-label="Pair to watch" autoCapitalize="characters" spellCheck={false} />
            <div className="seg wt-tfs" role="group" aria-label="Timeframe">
              {TFS.map((t) => <button key={t} className={frame === t ? "on" : ""} onClick={() => setFrame(t)}>{t}</button>)}
            </div>
          </div>
        </section>

        <section className="wt-sec">
          <div className="wt-row">
            <h4>Strategies</h4>
            <span className="faint">{sel.length} of 12</span>
            <span className="grow" />
            {user && user.strategies && user.strategies.length ? <button className="wt-link" onClick={() => setSel(user.strategies.slice(0, 12))}>Use mine</button> : null}
            {sel.length ? <button className="wt-link" onClick={() => setSel([])}>Clear</button> : null}
          </div>
          <div className="sp-groups" role="tablist">
            <button className={group === "all" ? "on" : ""} onClick={() => setGroup("all")}>All</button>
            {((cat && cat.groups) || []).map((g) => <button key={g.id} className={group === g.id ? "on" : ""} onClick={() => setGroup(g.id)}>{g.name}</button>)}
          </div>
          <div className="wt-chips">
            {!cat ? <span className="faint">Loading strategies…</span> : shown.map((s) => (
              <button key={s.id} className={`chip${sel.includes(s.id) ? " on" : ""}`} onClick={() => toggle(s.id)} title={s.how} aria-pressed={sel.includes(s.id)}>
                {sel.includes(s.id) ? <Icon name="check" size={12} /> : null} {s.name}
              </button>
            ))}
          </div>
        </section>

        <section className="wt-sec">
          <h4>Send the alert to</h4>
          <div className="wt-ch on"><Icon name="bell" size={17} /><span><b>This site</b><i>The bell and a pop-up while you have the site open</i></span><em>Always on</em></div>
          <button className={`wt-ch${email && emailOk ? " on" : ""}`} onClick={() => emailOk && setEmail(!email)} disabled={!emailOk} aria-pressed={email && emailOk}>
            <Icon name="send" size={17} /><span><b>Email</b><i>{emailOk ? `To ${list.user_email}` : "Email isn't set up on this server yet"}</i></span>
            <span className={`switch-ui${email && emailOk ? " on" : ""}`} aria-hidden="true" />
          </button>
          {emailOk ? <button className="wt-link wt-test" onClick={testEmail}>Send me a test email</button> : null}
          <button className={`wt-ch${phone ? " on" : ""}`} onClick={togglePhone} disabled={!pushSupported()} aria-pressed={phone}>
            <Icon name="phone" size={17} /><span><b>Phone & browser notification</b><i>{pushSupported() ? "Pops up even when the site is closed. Your browser will ask to allow it." : "This browser can't show these"}</i></span>
            <span className={`switch-ui${phone ? " on" : ""}`} aria-hidden="true" />
          </button>
        </section>

        {brokers.length ? (
          <section className="wt-sec">
            <h4>Send to your broker</h4>
            <div className="bk-kinds">
              <button className={`chip${bid === null ? " on" : ""}`} onClick={() => { setBid(null); setAuto(false); }}>Alerts only</button>
              {brokers.map((a) => (
                <button key={a.id} className={`chip${bid === a.id ? " on" : ""}`} onClick={() => setBid(a.id)}>
                  {a.label} <span className={`bk-tag ${a.live ? "live" : "demo"}`}>{a.live ? "LIVE" : "Demo"}</span>
                </button>
              ))}
            </div>
            {bid !== null ? (() => {
              const a = brokers.find((x) => x.id === bid);
              const size = a && a.settings.auto_size;
              return (
                <>
                  <button className={`wt-ch${auto ? " on" : ""}`} onClick={() => size && setAuto(!auto)} disabled={!size} aria-pressed={auto}>
                    <Icon name="zap" size={17} /><span><b>Place the order by itself</b><i>{size ? `Each new setup is sent as ${size} ${a.unit}, with its stop and target, within your limits` : "Set an auto-send size first (Connect a broker, then Limits)"}</i></span>
                    <span className={`switch-ui${auto ? " on" : ""}`} aria-hidden="true" />
                  </button>
                  {auto && a.live ? <label className="check bk-warn"><input type="checkbox" checked={liveOk} onChange={(e) => setLiveOk(e.target.checked)} /> This is a live account. Orders will use real money without asking me each time.</label> : null}
                  {!size ? <button className="wt-link" onClick={onBroker}>Open broker settings</button> : null}
                </>
              );
            })() : null}
          </section>
        ) : onBroker ? (
          <section className="wt-sec">
            <h4>Send to your broker</h4>
            <button className="wt-ch" onClick={onBroker}><Icon name="bank" size={17} /><span><b>Connect a broker</b><i>Also send each setup's entry, stop and target to MetaTrader, Binance, Bybit or OANDA</i></span></button>
          </section>
        ) : null}

        {note ? <div className="wt-note"><Icon name="check" size={15} /> {note}</div> : null}

        <section className="wt-sec">
          <div className="wt-row">
            <h4>Your watches</h4>
            <span className="grow" />
            {list && list.limit !== null && list.limit !== undefined ? <span className="faint">{list.active} of {list.limit} active</span> : null}
          </div>
          {!list ? <div className="faint">Loading…</div> : list.items.length === 0 ? (
            <div className="faint wt-empty">Nothing watched yet. Pick a pair and strategies above, then press Start watching.</div>
          ) : list.items.map((w) => (
            <div key={w.id} className={`wt-item${w.status === "active" ? "" : " off"}`}>
              <div className="grow">
                <b>{w.symbol} <i>{w.tf}</i></b>
                {w.auto_send ? <span className="wt-auto"><Icon name="zap" size={12} /> sends orders by itself</span> : null}
                <span className="wt-names">{w.names.map((n) => n).join(" · ") || w.strategies.map((i) => (byId[i] ? byId[i].name : i)).join(" · ")}</span>
                <span className="faint wt-meta">
                  {w.status === "paused" ? "Paused" : w.error ? `Couldn't check: ${w.error}` : w.fired ? `${w.fired} alert${w.fired > 1 ? "s" : ""} · last ${timeAgo(w.last_fired_at)}` : "Watching, nothing yet"}
                  {w.status === "active" && w.checked_at && !w.error ? ` · checked ${timeAgo(w.checked_at)}` : ""}
                </span>
              </div>
              <button className="icon-btn" onClick={() => flip(w)} title={w.status === "active" ? "Pause" : "Resume"} aria-label={w.status === "active" ? "Pause watch" : "Resume watch"}>
                <Icon name={w.status === "active" ? "pause" : "play"} size={15} />
              </button>
              <button className="icon-btn" onClick={() => remove(w)} aria-label="Delete watch"><Icon name="trash" size={15} /></button>
            </div>
          ))}
        </section>
      </div>
    </Sheet>
  );
}

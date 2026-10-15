"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/Icons";
import { useAuth } from "@/components/Providers";
import { useClickOutside } from "@/components/ui";
import { ApiError, del, get, patch, post } from "@/lib/api";
import { fmtPrice, timeAgo } from "@/lib/format";

const OP_LABEL = { above: "rises to", below: "falls to", cross: "crosses" };
const POLL_MS = 30000;

/** Ask the bell (wherever it is mounted) to open the new-alert form, or to set alerts for a whole plan. */
export function requestAlert(detail) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sa:new-alert", { detail }));
}

function browserNotify(title, body) {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
      new Notification(title, { body, icon: "/icons/icon-192.png" });
    }
  } catch {
    /* some browsers throw outside a service worker; the in-app toast still shows */
  }
}

export default function AlertsBell({ symbol, tf, price, decimals = 2, onLimit }) {
  const { user, toast } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("inbox");
  const [notes, setNotes] = useState([]);
  const [unread, setUnread] = useState(0);
  const [alerts, setAlerts] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const lastId = useRef(0);
  const first = useRef(true);
  useClickOutside(ref, () => setOpen(false), open);

  const poll = useCallback(async () => {
    if (!user) return;
    try {
      const d = await get(`/alerts/notifications${lastId.current ? `?after=${lastId.current}` : ""}`);
      setUnread(d.unread);
      if (d.items.length) {
        const maxId = Math.max(...d.items.map((n) => n.id));
        if (!first.current) {
          d.items.filter((n) => n.id > lastId.current).slice(0, 3).forEach((n) => {
            toast(n.title, "info", 8000);
            browserNotify(n.title, n.body);
          });
        }
        lastId.current = Math.max(lastId.current, maxId);
        setNotes((xs) => {
          const seen = new Set(xs.map((x) => x.id));
          return [...d.items.filter((x) => !seen.has(x.id)), ...xs].slice(0, 60);
        });
      }
      first.current = false;
    } catch {
      /* offline for a moment: try again next round */
    }
  }, [user, toast]);

  useEffect(() => {
    poll();
    const id = setInterval(() => { if (document.visibilityState === "visible") poll(); }, POLL_MS);
    const vis = () => { if (document.visibilityState === "visible") poll(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", vis); };
  }, [poll]);

  const loadAlerts = useCallback(() => get("/alerts").then(setAlerts).catch(() => setAlerts({ items: [], active: 0, limit: null })), []);
  useEffect(() => { if (open) loadAlerts(); }, [open, loadAlerts]);

  const askPermission = () => {
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
    } catch {
      /* not supported */
    }
  };

  const fail = useCallback((e) => {
    if (e instanceof ApiError && (e.status === 402 || e.status === 429) && onLimit) onLimit({ message: e.message, detail: e.detail });
    else toast(e.message, "error");
  }, [onLimit, toast]);

  const createPlanAlerts = useCallback(async ({ symbol: sym, tf: t, plan, decimals: dec = 2 }) => {
    const levels = [["entry", plan.entry, "Entry"], ["sl", plan.sl, "Stop"], ["tp", plan.tp, "Target"]].filter((x) => Number.isFinite(x[1]));
    let made = 0;
    for (const [, lvl, label] of levels) {
      try {
        await post("/alerts", { symbol: sym, tf: t, op: "cross", price: lvl, note: `${label} of the ${plan.side === "long" ? "buy" : "sell"} plan` });
        made += 1;
      } catch (e) {
        fail(e);
        break;
      }
    }
    if (made) {
      askPermission();
      toast(`${made} alert${made > 1 ? "s" : ""} set for this plan (${levels.slice(0, made).map((l) => `${l[2].toLowerCase()} ${fmtPrice(l[1], dec)}`).join(", ")}).`, "success", 6000);
      if (open) loadAlerts();
    }
  }, [fail, toast, open, loadAlerts]);

  useEffect(() => {
    const h = (e) => {
      const d = e.detail || {};
      if (d.plan) createPlanAlerts(d);
      else {
        setOpen(true);
        setTab("alerts");
        setForm({ symbol: d.symbol || symbol, tf: d.tf || tf, price: String(d.price ?? price ?? ""), op: d.op || "auto", note: d.note || "", email: false, repeat: false });
      }
    };
    window.addEventListener("sa:new-alert", h);
    return () => window.removeEventListener("sa:new-alert", h);
  }, [createPlanAlerts, symbol, tf, price]);

  const newForm = () => setForm({ symbol, tf, price: price ? String(Number(price.toFixed(decimals))) : "", op: "auto", note: "", email: false, repeat: false });

  const create = async (e) => {
    e.preventDefault();
    const lvl = parseFloat(form.price);
    if (!Number.isFinite(lvl) || lvl <= 0) return toast("Enter the price level for the alert.", "error");
    const op = form.op === "auto" ? (price && lvl < price ? "below" : "above") : form.op;
    setBusy(true);
    try {
      await post("/alerts", { symbol: form.symbol, tf: form.tf, op, price: lvl, note: form.note || null, email: form.email, repeat: form.repeat });
      askPermission();
      toast(`Alert set: ${form.symbol} ${OP_LABEL[op]} ${fmtPrice(lvl, decimals)}`, "success");
      setForm(null);
      loadAlerts();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (a) => {
    try {
      await patch(`/alerts/${a.id}`, { status: a.status === "active" ? "paused" : "active" });
      loadAlerts();
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (a) => {
    try {
      await del(`/alerts/${a.id}`);
      loadAlerts();
    } catch (e) {
      fail(e);
    }
  };
  const readAll = async () => {
    try {
      await post("/alerts/notifications/read", { all: true });
      setUnread(0);
      setNotes((xs) => xs.map((n) => ({ ...n, read: true })));
    } catch {
      /* ignore */
    }
  };
  const openNote = (n) => {
    if (!n.read) post("/alerts/notifications/read", { ids: [n.id] }).then(() => setUnread((u) => Math.max(0, u - 1))).catch(() => {});
    setNotes((xs) => xs.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    setOpen(false);
    if (n.link) router.push(n.link);
  };

  if (!user) return null;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className={`icon-btn bell ${unread ? "has" : ""}`} onClick={() => setOpen(!open)} aria-label={`Alerts${unread ? ` (${unread} new)` : ""}`} title="Alerts">
        <Icon name="bell" />
        {unread ? <span className="bell-dot">{unread > 9 ? "9+" : unread}</span> : null}
      </button>
      {open ? (
        <div className="glass bell-pop" role="dialog" aria-label="Alerts and notifications">
          <div className="seg" style={{ width: "100%", marginBottom: 8 }}>
            <button className={tab === "inbox" ? "on" : ""} onClick={() => setTab("inbox")} style={{ flex: 1 }}>Inbox{unread ? ` (${unread})` : ""}</button>
            <button className={tab === "alerts" ? "on" : ""} onClick={() => setTab("alerts")} style={{ flex: 1 }}>My alerts{alerts ? ` (${alerts.active})` : ""}</button>
          </div>
          {tab === "inbox" ? (
            <div className="bell-list">
              {notes.length ? notes.map((n) => (
                <button key={n.id} className={`bell-note ${n.read ? "" : "new"}`} onClick={() => openNote(n)}>
                  <b>{n.title}</b>
                  {n.body ? <span className="faint">{n.body}</span> : null}
                  <span className="faint" style={{ fontSize: "0.72rem" }}>{timeAgo(n.created_at)}</span>
                </button>
              )) : <div className="faint" style={{ padding: 12, fontSize: "0.86rem" }}>Nothing yet. Set a price alert, or alerts for a plan from its card, and they land here.</div>}
              {unread ? <button className="btn ghost sm" onClick={readAll} style={{ width: "100%", justifyContent: "center" }}>Mark all as read</button> : null}
            </div>
          ) : (
            <div className="bell-list">
              {form ? (
                <form className="stack" style={{ gap: 8, padding: 4 }} onSubmit={create}>
                  <div className="row" style={{ gap: 6 }}>
                    <input className="input sm" value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} aria-label="Symbol" style={{ flex: 1.2 }} />
                    <select className="select input sm" value={form.op} onChange={(e) => setForm({ ...form, op: e.target.value })} aria-label="Condition" style={{ flex: 1 }}>
                      <option value="auto">reaches</option><option value="above">rises to</option><option value="below">falls to</option><option value="cross">crosses</option>
                    </select>
                  </div>
                  <input className="input sm num" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="Price" aria-label="Price" autoFocus />
                  <input className="input sm" value={form.note} maxLength={120} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Note (optional), e.g. retest of the breakout" aria-label="Note" />
                  <label className="check" style={{ fontSize: "0.82rem" }}><input type="checkbox" checked={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.checked })} /> Keep watching after it fires</label>
                  <label className="check" style={{ fontSize: "0.82rem" }}><input type="checkbox" checked={form.email} onChange={(e) => setForm({ ...form, email: e.target.checked })} /> Also email me</label>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn primary sm grow" disabled={busy}>{busy ? <span className="spinner" /> : <Icon name="bell" size={14} />} Create alert</button>
                    <button type="button" className="btn ghost sm" onClick={() => setForm(null)}>Cancel</button>
                  </div>
                </form>
              ) : (
                <button className="btn sm" onClick={newForm} style={{ width: "100%", justifyContent: "center" }}><Icon name="plus" size={14} /> New price alert{symbol ? ` on ${symbol}` : ""}</button>
              )}
              {!alerts ? <div className="faint" style={{ padding: 10 }}>Loading…</div> : alerts.items.map((a) => (
                <div key={a.id} className="bell-alert">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <b>{a.kind === "strategy" ? `${a.strategy || "Strategy"} · ${a.symbol} ${a.tf}` : `${a.symbol} ${OP_LABEL[a.op]} ${fmtPrice(a.price, decimals)}`}</b>
                    <div className="faint" style={{ fontSize: "0.74rem" }}>
                      {a.status === "triggered" ? `fired ${timeAgo(a.triggered_at)}` : a.status === "paused" ? "paused" : a.kind === "strategy" ? "watching every closed candle" : a.repeat ? "watching (repeats)" : "watching"}
                      {a.note ? ` · ${a.note}` : ""}{a.error ? ` · ${a.error}` : ""}
                    </div>
                  </div>
                  <button className="icon-btn" onClick={() => toggle(a)} title={a.status === "active" ? "Pause" : "Re-arm"} aria-label={a.status === "active" ? "Pause alert" : "Re-arm alert"}>
                    <Icon name={a.status === "active" ? "pause" : "play"} size={15} />
                  </button>
                  <button className="icon-btn" onClick={() => remove(a)} aria-label="Delete alert"><Icon name="trash" size={15} /></button>
                </div>
              ))}
              {alerts && alerts.limit !== null && alerts.limit !== undefined ? <div className="hint" style={{ padding: "6px 4px 0" }}>{alerts.active} of {alerts.limit} active alerts on your plan. Checked about every 30 seconds.</div> : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

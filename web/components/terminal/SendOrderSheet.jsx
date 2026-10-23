"use client";
// Review a plan's entry, stop loss, take profits and size, pick the broker account, and send it. Nothing is sent
// until the person confirms here. The server checks the numbers again and applies the account's limits.
import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icons";
import Sheet from "@/components/terminal/Sheet";
import { useAuth } from "@/components/Providers";
import { ApiError, get, post } from "@/lib/api";

const fmt = (x, d) => (Number.isFinite(Number(x)) && x !== null && x !== undefined ? Number(x).toFixed(d) : "");

function sizeFor(plan, kind) {
  const s = plan && plan.sizing;
  if (!s) return "";
  if (kind === "mt") return s.lots_rounded !== undefined ? Number(s.lots_rounded).toFixed(2) : "";
  if (kind === "oanda") return s.units ? String(Math.max(1, Math.floor(s.units))) : "";
  return s.units ? String(Number(Number(s.units).toPrecision(3))) : "";
}

export default function SendOrderSheet({ open, onClose, res, onConnect, onLimit }) {
  const { toast } = useAuth();
  const p = res && res.plan;
  const [data, setData] = useState(null);
  const [bid, setBid] = useState(null);
  const [f, setF] = useState({});
  const [mode, setMode] = useState("first");
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [err, setErr] = useState(null);
  const [ref, setRef] = useState("");

  useEffect(() => {
    if (!open || !p) return;
    setDone(null);
    setErr(null);
    setOk(false);
    setMode("first");
    setRef(`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`);
    get("/brokers").then((d) => { setData(d); setBid((b) => (b && d.accounts.some((a) => a.id === b) ? b : d.accounts[0] ? d.accounts[0].id : null)); }).catch(() => setData({ accounts: [], available: {} }));
  }, [open, p]);

  const acct = useMemo(() => (data ? data.accounts.find((a) => a.id === bid) : null), [data, bid]);
  useEffect(() => {
    if (!open || !p) return;
    const tps = (p.tps || []).slice(0, 3);
    const d = Number.isFinite(res.decimals) ? res.decimals : 5;
    setF({ entry: fmt(p.entry, d), sl: fmt(p.sl, d), tp1: fmt(tps[0], d), tp2: fmt(tps[1], d), tp3: fmt(tps[2], d), size: sizeFor(p, acct && acct.kind), kind: p.type === "market" ? "market" : "limit" });
  }, [open, p, acct && acct.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p) return null;
  const long = p.side === "long";
  const tps = [f.tp1, f.tp2, f.tp3].map(Number).filter((x) => Number.isFinite(x) && x > 0);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const canSplit = acct && acct.kind !== "binance" && tps.length > 1;
  const need = acct && acct.live ? ok : true;

  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post("/brokers/send", {
        broker_id: acct.id, symbol: res.symbol, side: p.side, kind: f.kind, entry: Number(f.entry), sl: Number(f.sl), tps,
        size: Number(f.size), tp_mode: canSplit ? mode : "first", confirm: true, ref,
      });
      setDone(r);
      toast(`Sent to ${r.broker}.`, "success", 5000);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 402 || e.status === 429) && e.detail && e.detail.code && onLimit) onLimit({ message: e.message, detail: e.detail });
      else setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Send to your broker" wide
      footer={done ? <button className="btn primary" style={{ width: "100%", justifyContent: "center" }} onClick={onClose}>Done</button>
        : acct ? <button className={`btn primary${acct.live ? " bk-live" : ""}`} style={{ width: "100%", justifyContent: "center" }} onClick={send} disabled={busy || !need || !f.size}>
          {busy ? <span className="spinner" /> : <Icon name="send" size={16} />} {acct.live ? "Send to LIVE account" : `Send to ${acct.label}`}
        </button> : null}>
      <div className="bk">
        {!data ? <div className="faint">Loading…</div> : data.accounts.length === 0 ? (
          <div className="bk-none">
            <p>You haven't connected a broker yet.</p>
            <button className="btn primary" onClick={() => { onClose(); onConnect && onConnect(); }}><Icon name="plus" size={15} /> Connect a broker</button>
          </div>
        ) : done ? (
          <div className="wt-note"><Icon name="check" size={15} /> <span>Sent to {done.broker}{done.live ? " (live)" : " (demo)"}: {done.note}. {done.duplicate ? "This had already been sent." : "Check your broker's app to see it."}</span></div>
        ) : (
          <>
            <div className="bk-plan">
              <b className={long ? "up" : "down"}>{long ? "Buy" : "Sell"} {res.symbol} {res.tf}</b>
              <span className="faint">{p.strategy_name || p.setup}</span>
            </div>
            <section className="wt-sec">
              <h4>Account</h4>
              <div className="bk-kinds">
                {data.accounts.map((a) => (
                  <button key={a.id} className={`chip${a.id === bid ? " on" : ""}`} onClick={() => setBid(a.id)}>
                    {a.label} <span className={`bk-tag ${a.live ? "live" : "demo"}`}>{a.live ? "LIVE" : "Demo"}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="wt-sec">
              <h4>Order</h4>
              <div className="seg" role="group" aria-label="Order type">
                <button className={f.kind === "market" ? "on" : ""} onClick={() => setF({ ...f, kind: "market" })}>At market</button>
                <button className={f.kind === "limit" ? "on" : ""} onClick={() => setF({ ...f, kind: "limit" })}>Limit at entry</button>
              </div>
              <div className="bk-grid">
                <label className="bk-f"><span>Entry</span><input className="input sm num" inputMode="decimal" value={f.entry || ""} onChange={set("entry")} /></label>
                <label className="bk-f"><span>Stop loss</span><input className="input sm num" inputMode="decimal" value={f.sl || ""} onChange={set("sl")} /></label>
                <label className="bk-f"><span>Take profit 1</span><input className="input sm num" inputMode="decimal" value={f.tp1 || ""} onChange={set("tp1")} /></label>
                {f.tp2 ? <label className="bk-f"><span>Take profit 2</span><input className="input sm num" inputMode="decimal" value={f.tp2 || ""} onChange={set("tp2")} /></label> : null}
                {f.tp3 ? <label className="bk-f"><span>Take profit 3</span><input className="input sm num" inputMode="decimal" value={f.tp3 || ""} onChange={set("tp3")} /></label> : null}
                <label className="bk-f"><span>Size ({acct ? acct.unit : ""})</span><input className="input sm num" inputMode="decimal" value={f.size || ""} onChange={set("size")} placeholder="e.g. 0.10" /></label>
              </div>
              {canSplit ? (
                <div className="seg" role="group" aria-label="Targets">
                  <button className={mode === "first" ? "on" : ""} onClick={() => setMode("first")}>All on take profit 1</button>
                  <button className={mode === "split" ? "on" : ""} onClick={() => setMode("split")}>Split across targets</button>
                </div>
              ) : acct && acct.kind === "binance" && tps.length > 1 ? <p className="faint bk-note">Binance takes one take profit here: TP1.</p> : null}
              {!f.size ? <p className="faint bk-note">Enter the size to trade. The analysis suggests one when you set your account size and risk in Settings.</p> : null}
            </section>
            {acct && acct.live ? (
              <label className="check bk-warn"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> This is a live account. I checked the entry, stop, targets and size, and I understand this uses real money.</label>
            ) : null}
            {err ? <div className="bk-error"><Icon name="alert" size={15} /> <span>{err}</span></div> : null}
          </>
        )}
      </div>
    </Sheet>
  );
}

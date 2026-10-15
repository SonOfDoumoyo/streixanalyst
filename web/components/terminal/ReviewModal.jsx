"use client";
import { useEffect, useState } from "react";
import Icon from "@/components/Icons";
import { Modal } from "@/components/ui";
import { ApiError, post } from "@/lib/api";
import { fmtPct, fmtPrice } from "@/lib/format";
import { gradeClass } from "@/lib/analysis";

export default function ReviewModal({ open, onClose, symbol, tf, prefill, price, decimals, settings, onLimit, onShowOnChart }) {
  const [f, setF] = useState({ side: "long", entry: "", sl: "", tp: "", tp2: "" });
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!open) return;
    setRes(null);
    setErr(null);
    if (prefill) setF({ side: prefill.side, entry: prefill.entry, sl: prefill.sl, tp: prefill.tp, tp2: prefill.tp2 || "" });
    else if (price) setF((x) => ({ ...x, entry: x.entry || Number(price).toFixed(decimals || 2) }));
  }, [open, prefill, price, decimals]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const a = settings.analysis;
      const d = await post("/analysis/review", {
        symbol, tf, side: f.side, entry: Number(f.entry), sl: Number(f.sl), tp: Number(f.tp), tp2: f.tp2 ? Number(f.tp2) : null,
        account: Number(a.account) || 1000, risk_pct: Number(a.risk_pct) || 1, leverage: a.leverage ? Number(a.leverage) : null,
      });
      setRes(d);
    } catch (ex) {
      if (ex instanceof ApiError && (ex.status === 429 || ex.status === 402)) {
        onClose();
        onLimit(ex);
      } else setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };
  const p = res && res.plan;
  const vColor = res && res.verdict ? (res.verdict.startsWith("GOOD") ? "#4fe0c9" : res.verdict.startsWith("OK") ? "var(--brand-2)" : res.verdict.startsWith("WEAK") ? "#ffc766" : "#ff8a87") : undefined;
  return (
    <Modal open={open} onClose={onClose} title="Review my trade" subtitle={`${symbol} · ${tf} — the analyst grades your entry, stop and target`} wide>
      <form onSubmit={submit} className="stack">
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="seg brand">
            <button type="button" className={f.side === "long" ? "on" : ""} onClick={() => setF((x) => ({ ...x, side: "long" }))}>Buy / Long</button>
            <button type="button" className={f.side === "short" ? "on" : ""} onClick={() => setF((x) => ({ ...x, side: "short" }))}>Sell / Short</button>
          </div>
          {price ? <span className="faint" style={{ fontSize: "0.85rem" }}>Price now <b className="num">{fmtPrice(price, decimals)}</b></span> : null}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
          {[["entry", "Entry"], ["sl", "Stop loss"], ["tp", "Take profit"], ["tp2", "TP 2 (optional)"]].map(([k, l]) => (
            <div key={k} className="field">
              <label>{l}</label>
              <input className="input num" type="number" step="any" inputMode="decimal" required={k !== "tp2"} value={f[k]} onChange={set(k)} />
            </div>
          ))}
        </div>
        {err ? <div className="error-text">{err}</div> : null}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={busy}>{busy ? <span className="spinner" /> : <Icon name="review" size={16} />} Grade my trade</button>
        </div>
      </form>
      {res ? (
        res.ok === false ? (
          <div className="badge down" style={{ marginTop: 16, height: "auto", padding: 10, whiteSpace: "normal" }}>{res.text}</div>
        ) : (
          <div className="stack" style={{ marginTop: 18 }}>
            <div className="verdict" style={{ borderColor: vColor }}>
              <div className="row">
                <div className="grow">
                  <div className="act" style={{ color: vColor }}>{res.verdict}</div>
                  {p ? (
                    <div className="muted num" style={{ fontSize: "0.86rem" }}>
                      R:R {Number(p.rr[p.rr.length - 1]).toFixed(2)} · target before stop {fmtPct(p.p_tp[p.p_tp.length - 1])} vs {fmtPct(p.breakeven[p.breakeven.length - 1])} needed · EV {Number(p.ev[p.ev.length - 1]).toFixed(2)}R
                    </div>
                  ) : null}
                </div>
                {p ? <span className={`grade ${gradeClass(p.grade)}`}>{p.grade}</span> : null}
              </div>
            </div>
            {res.issues && res.issues.length ? (
              <div>
                <div className="section-title">What's wrong</div>
                <ul className="check-list">{res.issues.map((x, i) => <li key={i} className="no"><span className="ic">✗</span><span>{x}</span></li>)}</ul>
              </div>
            ) : null}
            {res.fixes && res.fixes.length ? (
              <div>
                <div className="section-title">How to improve it</div>
                <ul className="check-list">{res.fixes.map((x, i) => <li key={i} className="ok"><span className="ic">→</span><span>{x}</span></li>)}</ul>
              </div>
            ) : null}
            {p && p.checklist ? (
              <details className="fold">
                <summary>Full checklist</summary>
                <div><ul className="check-list">{p.checklist.map((c, i) => <li key={i} className={c.ok ? "ok" : "no"}><span className="ic">{c.ok ? "✓" : "✗"}</span><span>{c.text}</span></li>)}</ul></div>
              </details>
            ) : null}
            {onShowOnChart && p ? (
              <button className="btn" onClick={() => { onShowOnChart({ side: f.side, entry: Number(f.entry), sl: Number(f.sl), tp: Number(f.tp) }); onClose(); }}>
                <Icon name="long" size={16} /> Put this trade on my chart
              </button>
            ) : null}
          </div>
        )
      ) : null}
    </Modal>
  );
}

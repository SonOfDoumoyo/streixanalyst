"use client";
// Small things that appear over the chart: why a drawing is there (tap any of the analyst's drawings), the
// "analyse from this price" button on the newest candle, and the what-if result for that price.
import { useEffect, useState } from "react";
import Icon from "@/components/Icons";
import { fmtPrice } from "@/lib/format";
import Sheet from "./Sheet";

/** Why the analyst drew this: title, the explanation, and a copy button for plan prices. */
export function ExplainCard({ data, onClose, onCopy, onAsk }) {
  useEffect(() => {
    if (!data) return undefined;
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [data, onClose]);
  if (!data) return null;
  const it = data.item;
  const phone = typeof window !== "undefined" && window.innerWidth <= 760;
  const style = phone ? undefined : {
    left: Math.max(8, Math.min(data.x + 12, window.innerWidth - 380)),
    top: Math.max(8, Math.min(data.y + 12, window.innerHeight - 260)),
  };
  return (
    <div className="explain-wrap" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`explain${phone ? " phone" : ""}`} style={style} role="dialog" aria-label={it.title || it.text || "Drawing"}>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <span className="explain-dot" style={{ background: it.color || it.fill || "var(--brand)" }} />
          <b className="grow">{it.title || it.text || "Analysis"}</b>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <p>{it.why}</p>
        <div className="row" style={{ gap: 8 }}>
          {it.copy ? <button className="btn sm primary" onClick={() => onCopy(it.copy, it.title || it.text)}><Icon name="copy" size={14} /> Copy {it.copy}</button> : null}
          {onAsk ? <button className="btn sm" onClick={() => onAsk(`On my chart the analyst drew "${it.title || it.text}". ${it.why} Explain this to me with an example.`)}><Icon name="sparkles" size={14} /> Ask StreixAI</button> : null}
        </div>
      </div>
    </div>
  );
}

/** The button that follows the touch crosshair on the newest candle. */
export function FromHereChip({ hover, decimals, onPick }) {
  if (!hover || !hover.touch || !hover.latest || !hover.inPlot || hover.cx === null) return null;
  const left = Math.min(Math.max(8, hover.cx - 150), (typeof window !== "undefined" ? window.innerWidth : 400) - 200);
  const top = Math.max(60, hover.cy - 64);
  return (
    <button className="fromhere" style={{ left, top }} onClick={() => onPick(hover.price)}>
      <Icon name="zap" size={14} /> Analyse from {fmtPrice(hover.price, decimals)}
    </button>
  );
}

function Side({ s, dec }) {
  const j = Math.min(1, (s.tps || []).length - 1);
  const good = s.ev_main > 0.02 && ["A+", "A", "B"].includes(s.grade);
  return (
    <div className={`wi-side ${s.side === "long" ? "up" : "down"}${good ? " good" : ""}`}>
      <div className="row">
        <b className="grow">{s.side === "long" ? "If you buy" : "If you sell"} · {s.type}</b>
        <span className="badge">{s.grade}</span>
      </div>
      <div className="wi-levels num">
        <span>EP <b>{fmtPrice(s.entry, dec)}</b></span>
        <span>SL <b className="down">{fmtPrice(s.sl, dec)}</b></span>
        {(s.tps || []).slice(0, 2).map((t, i) => <span key={i}>TP{i + 1} <b className="up">{fmtPrice(t, dec)}</b></span>)}
      </div>
      <div className="hint num">TP{j + 1} before the stop: {Math.round((s.p_tp[j] || 0) * 100)}% vs {Math.round((s.breakeven[j] || 0) * 100)}% needed · {s.ev_main >= 0 ? "+" : ""}{Number(s.ev_main).toFixed(2)}R expected</div>
      {s.liquidity_guard ? <div className="hint"><Icon name="shield" size={12} /> Stop past the liquidity at {fmtPrice(s.liquidity_guard.pool, dec)}.</div> : null}
      {(s.warnings || []).map((w, i) => <div key={i} className="lc-note warn"><Icon name="alert" size={13} /> {w}</div>)}
    </div>
  );
}

/** "If I enter here, now": both sides from the chosen price. */
export function WhatIfSheet({ open, onClose, data, busy, error, onUse }) {
  const [, force] = useState(0);
  useEffect(() => force((x) => x + 1), [data]);
  const dec = data ? data.decimals : 2;
  return (
    <Sheet open={open} onClose={onClose} title={data ? `From ${fmtPrice(data.price, dec)} on ${data.symbol}` : "Analyse from here"}>
      {busy ? <div className="empty"><span className="spinner dark" /> <div className="hint">Checking both sides…</div></div> : null}
      {error ? <div className="lc-note down"><Icon name="alert" size={14} /> {error}</div> : null}
      {data && !busy ? (
        <div className="stack" style={{ gap: 10 }}>
          <div className={`wi-verdict ${data.better === "long" ? "up" : data.better === "short" ? "down" : ""}`}>{data.text}</div>
          {data.sides.map((s) => <Side key={s.side} s={s} dec={dec} />)}
          <div className="hint">{data.tf_note} Odds are estimates from history, not promises.</div>
          {data.better && onUse ? (
            <button className="btn primary" onClick={() => onUse(data.sides.find((s) => s.side === data.better))}><Icon name="pen" size={15} /> Put the {data.better === "long" ? "buy" : "sell"} on my chart</button>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

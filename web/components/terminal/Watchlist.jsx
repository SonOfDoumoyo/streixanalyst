"use client";
import { useEffect, useState } from "react";
import Icon from "@/components/Icons";
import { get, qs } from "@/lib/api";
import { fmtChange, fmtPrice } from "@/lib/format";
import { Empty } from "@/components/ui";
import { SymbolIcon } from "./SymbolSearch";

export default function Watchlist({ symbols, current, onPick, onRemove, onAdd, onMove }) {
  const [quotes, setQuotes] = useState({});
  const [edit, setEdit] = useState(false);
  useEffect(() => {
    if (!symbols.length) return undefined;
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      get(`/market/quotes?${qs({ symbols: symbols.join(",") })}`)
        .then((d) => {
          if (!alive) return;
          const m = {};
          for (const q of d.quotes || []) m[q.symbol.toUpperCase()] = q;
          setQuotes(m);
        })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [symbols]);

  return (
    <div>
      <div className="row" style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
        <b className="grow">Watchlist</b>
        <button className={`btn sm ${edit ? "primary" : "ghost"}`} onClick={() => setEdit(!edit)}>{edit ? "Done" : "Edit"}</button>
        <button className="btn sm" onClick={onAdd}><Icon name="plus" size={15} /> Add</button>
      </div>
      {!symbols.length ? <Empty icon="star" title="Nothing here yet">Add markets you follow and see their prices at a glance.</Empty> : null}
      {symbols.map((s, i) => {
        const q = quotes[s.toUpperCase()];
        return (
          <div key={s} className={`wl-row ${current && current.toUpperCase() === s.toUpperCase() ? "on" : ""}`} onClick={() => !edit && onPick(s)}>
            <div className="row" style={{ gap: 10, minWidth: 0 }}>
              <SymbolIcon symbol={s.split(":").pop()} size={28} />
              <div style={{ minWidth: 0 }}>
                <div className="s">{s.split(":").pop()}</div>
                <div className="faint" style={{ fontSize: "0.72rem" }}>{q && q.display ? q.display : s.includes(":") ? s.split(":")[0] : ""}</div>
              </div>
            </div>
            {edit ? (
              <div className="row" style={{ gap: 2, gridColumn: "span 2", justifyContent: "flex-end" }}>
                <button className="icon-btn" style={{ width: 30, height: 30 }} disabled={i === 0} onClick={() => onMove(i, -1)} aria-label="Move up"><Icon name="chevronUp" size={16} /></button>
                <button className="icon-btn" style={{ width: 30, height: 30 }} disabled={i === symbols.length - 1} onClick={() => onMove(i, 1)} aria-label="Move down"><Icon name="chevronDown" size={16} /></button>
                <button className="icon-btn" style={{ width: 30, height: 30, color: "#ff8a87" }} onClick={() => onRemove(s)} aria-label="Remove"><Icon name="trash" size={15} /></button>
              </div>
            ) : (
              <>
                <div className="p num">{q && q.price !== undefined ? fmtPrice(q.price, q.decimals) : q && q.error ? <span className="faint">—</span> : <span className="skeleton" style={{ display: "inline-block", width: 60, height: 12 }} />}</div>
                <div className={`c num ${q && q.change >= 0 ? "up" : "down"}`}>{q ? fmtChange(q.change) : ""}</div>
              </>
            )}
          </div>
        );
      })}
      <div className="hint" style={{ padding: "10px 14px" }}>Change = since today's open (UTC).</div>
    </div>
  );
}

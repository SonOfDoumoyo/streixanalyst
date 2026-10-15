"use client";
import { useEffect, useRef, useState } from "react";
import Icon from "@/components/Icons";
import { get, qs } from "@/lib/api";
import { fmtChange, fmtCompact, symbolColor } from "@/lib/format";
import { useClickOutside } from "@/components/ui";

const KINDS = [
  ["", "All"], ["crypto", "Crypto"], ["forex", "Forex"], ["index", "Indices"], ["metal", "Metals"],
  ["energy", "Energy"], ["commodity", "Commodities"], ["stock", "Stocks"],
];

export function SymbolIcon({ symbol, base, size = 32 }) {
  const b = (base || symbol || "?").replace(/[^A-Z0-9]/gi, "").slice(0, 4).toUpperCase();
  return (
    <span className="sym-ic" style={{ width: size, height: size, background: `linear-gradient(135deg, ${symbolColor(b)}, #1a2b52)`, fontSize: size < 30 ? "0.62rem" : "0.72rem" }}>
      {b.slice(0, 3)}
    </span>
  );
}

export default function SymbolSearch({ open, onClose, onPick, watchlist = [], onToggleWatch }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [res, setRes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const ref = useRef(null);
  const input = useRef(null);
  useClickOutside(ref, onClose, open);

  useEffect(() => {
    if (!open) return undefined;
    setSel(0);
    const t = setTimeout(() => input.current && input.current.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const ctl = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      get(`/market/search?${qs({ q, kind, limit: 50 })}`, { signal: ctl.signal })
        .then((d) => {
          setRes(d.results || []);
          setSel(0);
        })
        .catch(() => {})
        .finally(() => setBusy(false));
    }, q ? 160 : 0);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, kind, open]);

  if (!open) return null;
  const pick = (r) => {
    onPick(r.chart_symbol || r.symbol, r);
    setQ("");
    onClose();
  };
  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(res.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      if (res[sel]) pick(res[sel]);
      else if (q.trim()) pick({ symbol: q.trim().toUpperCase() });
    } else if (e.key === "Escape") onClose();
  };
  return (
    <div ref={ref} className="search-pop glass" role="dialog" aria-label="Search markets">
      <div style={{ padding: 12, borderBottom: "1px solid var(--line)" }}>
        <div className="row" style={{ position: "relative" }}>
          <Icon name="search" size={18} style={{ position: "absolute", left: 12, color: "var(--text-3)" }} />
          <input ref={input} className="input" style={{ paddingLeft: 38 }} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Search any market: BTC, CAPUSDT, EURUSD, gold, NAS100, AAPL…" aria-label="Search markets" />
          <button className="icon-btn" onClick={onClose} aria-label="Close search"><Icon name="x" size={18} /></button>
        </div>
        <div className="row" style={{ gap: 6, marginTop: 10, overflowX: "auto", scrollbarWidth: "none" }}>
          {KINDS.map(([k, label]) => (
            <button key={k} className={`chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}
              style={kind === k ? { borderColor: "var(--brand)", color: "var(--brand-2)", background: "rgba(47,134,246,.12)" } : undefined}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="res">
        {busy && !res.length ? (
          <div style={{ padding: 16 }} className="stack">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 34 }} />)}</div>
        ) : null}
        {!busy && !res.length ? <div className="empty">No match. Press Enter to try “{q.toUpperCase()}” on every exchange.</div> : null}
        {res.map((r, i) => {
          const starred = watchlist.includes((r.chart_symbol || r.symbol).toUpperCase());
          return (
            <div key={(r.chart_symbol || r.symbol) + i} className={`item ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => pick(r)}>
              <SymbolIcon symbol={r.symbol} base={r.base} />
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <b style={{ whiteSpace: "nowrap" }}>{r.symbol}</b>
                  {r.perp ? <span className="badge violet">PERP</span> : null}
                  <span className="faint" style={{ fontSize: "0.8rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                </div>
                <div className="faint" style={{ fontSize: "0.74rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {(r.exchanges || []).slice(0, 4).join(" · ")}{r.vol_usd ? ` · vol $${fmtCompact(r.vol_usd)}` : ""}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                {r.change !== undefined && r.change !== null ? (
                  <span className={`num ${r.change >= 0 ? "up" : "down"}`} style={{ fontSize: "0.82rem", fontWeight: 700 }}>{fmtChange(r.change)}</span>
                ) : null}
                {onToggleWatch ? (
                  <button className="icon-btn" style={{ width: 30, height: 30, color: starred ? "#ffc766" : undefined }} aria-label={starred ? "Remove from watchlist" : "Add to watchlist"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleWatch(r.chart_symbol || r.symbol, !starred);
                    }}>
                    <Icon name="star" size={16} style={starred ? { fill: "#ffc766" } : undefined} />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

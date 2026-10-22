"use client";
// Interval and date range: every interval grouped by unit, favourites (tap the star) shown first, and quick jumps to a
// span of time or a date.
import { useState } from "react";
import Icon from "@/components/Icons";
import { INTERVAL_GROUPS, TF_LABEL, TFS } from "@/lib/format";
import Sheet from "./Sheet";

const RANGES = [["1D", 86400], ["5D", 5 * 86400], ["1M", 30 * 86400], ["3M", 91 * 86400], ["6M", 182 * 86400], ["YTD", "ytd"], ["1Y", 365 * 86400], ["All", "all"]];

export function IntervalChip({ tf, onClick }) {
  return (
    <button className="iv-chip" onClick={onClick} aria-label={`Interval: ${TF_LABEL[tf] || tf}`} data-tour="timeframe">
      <span>{tf}</span>
      <Icon name="chevronDown" size={14} />
    </button>
  );
}

export default function IntervalSheet({ open, onClose, value, onPick, favorites = [], onFavorites, onRange, onGoTo }) {
  const [date, setDate] = useState("");
  const fav = (t) => favorites.includes(t);
  const toggleFav = (t) => onFavorites(fav(t) ? favorites.filter((x) => x !== t) : [...favorites, t]);
  const pick = (t) => {
    onPick(t);
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Interval & range">
      {favorites.length ? (
        <div className="iv-favs" aria-label="Favourite intervals">
          {favorites.map((t) => (
            <button key={t} className={value === t ? "on" : ""} onClick={() => pick(t)}>{t}</button>
          ))}
        </div>
      ) : null}
      {INTERVAL_GROUPS.map(([name, tfs]) => (
        <section key={name} className="iv-group">
          <h4>{name}</h4>
          <div className="iv-grid">
            {tfs.map((t) => (
              <div key={t} className={`iv-cell${value === t ? " on" : ""}`}>
                <button className="iv-pick" onClick={() => pick(t)} title={TF_LABEL[t]}>
                  {t}
                  {!TFS.includes(t) ? <small>chart</small> : null}
                </button>
                <button className={`iv-star${fav(t) ? " on" : ""}`} onClick={() => toggleFav(t)} aria-label={fav(t) ? `Remove ${t} from favourites` : `Add ${t} to favourites`}>
                  <Icon name="star" size={12} />
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
      <p className="hint" style={{ margin: "4px 2px 12px" }}>Intervals marked “chart” are for viewing; the analyst reads the nearest standard interval for them.</p>
      <section className="iv-group">
        <h4>Show a span of time</h4>
        <div className="iv-ranges">
          {RANGES.map(([l, v]) => <button key={l} onClick={() => { onRange(v); onClose(); }}>{l}</button>)}
        </div>
      </section>
      <section className="iv-group">
        <h4>Go to a date</h4>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (date) { onGoTo(Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000)); onClose(); } }}>
          <input className="input sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          <button className="btn sm" disabled={!date}>Go</button>
        </form>
      </section>
    </Sheet>
  );
}

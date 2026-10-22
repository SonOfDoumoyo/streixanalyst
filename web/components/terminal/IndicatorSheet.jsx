"use client";
// Indicators, candlestick patterns and strategies: search the library, add as many as you like, tune their settings,
// and see a strategy's trades on the chart. Indicator sets can be saved as templates.
import { useMemo, useState } from "react";
import Icon from "@/components/Icons";
import { STUDIES, STUDY_BY_ID, STUDY_CATS, newStudy } from "@/components/chart/studies";
import { useCatalog } from "@/components/StrategyPicker";
import Sheet from "./Sheet";

const TABS = [["library", "Indicators"], ["patterns", "Candle patterns"], ["strategies", "Strategies"], ["active", "On my chart"], ["templates", "Templates"]];

function Params({ inst, onChange }) {
  const def = STUDY_BY_ID[inst.id];
  if (!def || !Object.keys(def.params).length) return <p className="hint">No settings.</p>;
  return (
    <div className="ind-params">
      {Object.entries(def.params).map(([k, v]) => (
        <label key={k}>
          <span>{k}</span>
          <input className="input sm" type="number" step={v < 1 ? 0.01 : 1} value={inst.params[k] ?? v}
            onChange={(e) => onChange({ ...inst, params: { ...inst.params, [k]: e.target.value === "" ? v : Number(e.target.value) } })} />
        </label>
      ))}
    </div>
  );
}

export default function IndicatorSheet({ open, onClose, studies, setStudies, legacy, setLegacy, templates, onSaveTemplate, onApplyTemplate,
  onDeleteTemplate, strategyOverlay, onStrategy, startTab = "library" }) {
  const [tab, setTab] = useState(startTab);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [edit, setEdit] = useState(null);
  const [tplName, setTplName] = useState("");
  const catalog = useCatalog();
  const needle = q.trim().toLowerCase();
  const lib = useMemo(() => STUDIES.filter((s) => s.cat !== "Candlestick patterns" && (cat === "all" || s.cat === cat)
    && (!needle || `${s.name} ${s.short}`.toLowerCase().includes(needle))), [cat, needle]);
  const pats = useMemo(() => STUDIES.filter((s) => s.cat === "Candlestick patterns" && (!needle || s.name.toLowerCase().includes(needle))), [needle]);
  const strats = useMemo(() => (catalog ? catalog.strategies.filter((s) => !needle || s.name.toLowerCase().includes(needle)) : []), [catalog, needle]);
  const count = (id) => studies.filter((s) => s.id === id).length;
  const add = (id) => setStudies([...studies, newStudy(id)]);
  const remove = (key) => setStudies(studies.filter((s) => s.key !== key));
  const update = (inst) => setStudies(studies.map((s) => (s.key === inst.key ? inst : s)));
  const LEGACY = [["ema20", "EMA 20"], ["ema50", "EMA 50"], ["ema200", "EMA 200"], ["bb", "Bollinger Bands (20, 2)"], ["vwap", "VWAP"]];
  return (
    <Sheet open={open} onClose={onClose} title="Indicators & strategies" wide>
      <div className="ind-tabs" role="tablist">
        {TABS.map(([id, l]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {l}{id === "active" && studies.length ? <i>{studies.length}</i> : null}
          </button>
        ))}
      </div>
      {tab !== "active" && tab !== "templates" ? (
        <div className="tb-search">
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: RSI, Ichimoku, engulfing, supertrend…" aria-label="Search" />
        </div>
      ) : null}
      {tab === "library" ? (
        <>
          <div className="ds-cats">
            <button className={cat === "all" ? "on" : ""} onClick={() => setCat("all")}>All</button>
            {STUDY_CATS.filter((c) => c !== "Candlestick patterns").map((c) => <button key={c} className={cat === c ? "on" : ""} onClick={() => setCat(c)}>{c}</button>)}
          </div>
          <div className="ind-list">
            {lib.map((s) => (
              <div key={s.id} className="ind-row">
                <span className="grow"><b>{s.name}</b><small>{s.cat} · {s.kind === "pane" ? "own pane" : "on the price"}</small></span>
                {count(s.id) ? <span className="badge brand">{count(s.id)} on</span> : null}
                <button className="btn sm" onClick={() => add(s.id)}><Icon name="plus" size={14} /> Add</button>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {tab === "patterns" ? (
        <div className="ind-list">
          <p className="hint">Each pattern marks every candle where it formed. On its own a candle pattern is weak; it matters at a key level.</p>
          {pats.map((s) => {
            const on = count(s.id) > 0;
            return (
              <div key={s.id} className="ind-row">
                <span className="grow"><b>{s.name}</b></span>
                <button className={`switch-ui${on ? " on" : ""}`} aria-pressed={on} aria-label={s.name}
                  onClick={() => (on ? setStudies(studies.filter((x) => x.id !== s.id)) : add(s.id))} />
              </div>
            );
          })}
        </div>
      ) : null}
      {tab === "strategies" ? (
        <div className="ind-list">
          <p className="hint">Show a strategy's trades on this chart: where it bought and sold, and how each trade ended after costs.</p>
          {strategyOverlay ? (
            <div className="ind-row on">
              <span className="grow"><b>{strategyOverlay.name}</b><small>{strategyOverlay.record && strategyOverlay.record.trades
                ? `${strategyOverlay.record.trades} trades · ${Math.round((strategyOverlay.record.win_rate || 0) * 100)}% won · ${strategyOverlay.record.verdict}` : "no trades on these candles"}</small></span>
              <button className="btn sm" onClick={() => onStrategy(null)}>Remove</button>
            </div>
          ) : null}
          {strats.map((s) => (
            <div key={s.id} className="ind-row">
              <span className="grow"><b>{s.name}</b><small>{s.how}</small></span>
              <button className="btn sm" onClick={() => onStrategy(s.id)} disabled={strategyOverlay && strategyOverlay.id === s.id}>
                <Icon name="play" size={13} /> Show
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {tab === "active" ? (
        <div className="ind-list">
          {LEGACY.map(([k, l]) => (
            <div key={k} className="ind-row">
              <span className="grow"><b>{l}</b><small>quick switch</small></span>
              <button className={`switch-ui${legacy[k] ? " on" : ""}`} aria-pressed={!!legacy[k]} aria-label={l} onClick={() => setLegacy(k, !legacy[k])} />
            </div>
          ))}
          {studies.length ? null : <p className="hint">Nothing else yet. Add indicators from the library.</p>}
          {studies.map((inst) => {
            const def = STUDY_BY_ID[inst.id];
            if (!def) return null;
            return (
              <div key={inst.key} className="ind-row col">
                <div className="row">
                  <span className="grow"><b>{def.name}</b><small>{Object.entries(inst.params || {}).map(([k, v]) => `${k} ${v}`).join(" · ") || def.cat}</small></span>
                  <button className="icon-btn" onClick={() => update({ ...inst, hidden: !inst.hidden })} aria-label={inst.hidden ? "Show" : "Hide"}>
                    <Icon name={inst.hidden ? "eyeOff" : "eye"} size={16} />
                  </button>
                  <button className="icon-btn" onClick={() => setEdit(edit === inst.key ? null : inst.key)} aria-label="Settings"><Icon name="settings" size={16} /></button>
                  <button className="icon-btn" onClick={() => remove(inst.key)} aria-label="Remove"><Icon name="trash" size={16} /></button>
                </div>
                {edit === inst.key ? <Params inst={inst} onChange={update} /> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {tab === "templates" ? (
        <div className="ind-list">
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (tplName.trim()) { onSaveTemplate(tplName.trim()); setTplName(""); } }}>
            <input className="input sm" value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="Name this set of indicators" maxLength={40} />
            <button className="btn sm primary" disabled={!tplName.trim()}>Save</button>
          </form>
          {(templates || []).length ? null : <p className="hint">No templates yet. Save the indicators on this chart as a template to reuse them.</p>}
          {(templates || []).map((t) => (
            <div key={t.name} className="ind-row">
              <span className="grow"><b>{t.name}</b><small>{(t.studies || []).length + Object.values(t.indicators || {}).filter(Boolean).length} indicators</small></span>
              <button className="btn sm" onClick={() => onApplyTemplate(t)}>Apply</button>
              <button className="icon-btn" onClick={() => onDeleteTemplate(t.name)} aria-label="Delete"><Icon name="trash" size={16} /></button>
            </div>
          ))}
        </div>
      ) : null}
    </Sheet>
  );
}

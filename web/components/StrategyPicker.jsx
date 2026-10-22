"use client";
// Choose the strategies the analyst uses. Shown once to every account (new or existing) until a choice is saved, and
// from the strategy chip on the chart afterwards. One strategy or several; the analysis and its drawings follow them.
import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icons";
import { useAuth } from "@/components/Providers";
import { get, put } from "@/lib/api";

const GROUP_ICON = { smc: "target", price_action: "candles", trend: "trendline", reversion: "refresh", breakout: "zap", scalp: "clock", fixed_time: "play" };
const STARTERS = [
  { label: "Smart money & liquidity", ids: ["ict_sweep_mss", "ote_pullback", "ob_retest", "turtle_soup"] },
  { label: "Scalper (1–15m)", ids: ["scalp_ema_vwap", "scalp_london", "scalp_range", "silver_bullet"] },
  { label: "Fixed time", ids: ["ft_trend", "ft_reversal", "ft_level"] },
  { label: "Swing (4h–1D)", ids: ["ote_pullback", "sr_bounce", "breakout_retest", "supertrend"] },
];

let catalogCache = null;
export async function loadCatalog() {
  if (catalogCache) return catalogCache;
  catalogCache = await get("/strategies");
  return catalogCache;
}

export function useCatalog() {
  const [cat, setCat] = useState(catalogCache);
  useEffect(() => {
    if (!cat) loadCatalog().then(setCat).catch(() => {});
  }, [cat]);
  return cat;
}

function pct(x) {
  return x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`;
}

export default function StrategyPicker({ open, onClose, symbol, tf, forced = false, onSaved }) {
  const { user, refresh, toast } = useAuth();
  const cat = useCatalog();
  const [sel, setSel] = useState([]);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("all");
  const [fit, setFit] = useState(null);
  const [fitBusy, setFitBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (!open) return;
    const mine = (user && user.strategies) || [];
    setSel(mine.length ? mine : []);
    setFit(null);
  }, [open, user]);

  const fitBy = useMemo(() => Object.fromEntries(((fit && fit.rows) || []).map((r) => [r.id, r])), [fit]);
  const findings = cat && cat.findings && cat.findings.best ? cat.findings.best[`${symbol}|${tf}`] : null;
  const list = useMemo(() => {
    if (!cat) return [];
    const needle = q.trim().toLowerCase();
    let rows = cat.strategies.filter((s) => (group === "all" || s.group === group)
      && (!needle || `${s.name} ${s.how} ${s.best_for}`.toLowerCase().includes(needle)));
    if (fit) rows = [...rows].sort((a, b) => ((fitBy[b.id] || {}).score || -9) - ((fitBy[a.id] || {}).score || -9));
    return rows;
  }, [cat, q, group, fit, fitBy]);

  if (!open) return null;
  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const testHere = async () => {
    setFitBusy(true);
    try {
      setFit(await get(`/strategies/fit?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`));
    } catch (e) {
      toast(e.message || "The test couldn't run.", "error");
    } finally {
      setFitBusy(false);
    }
  };
  const save = async () => {
    if (!sel.length) return;
    setBusy(true);
    try {
      const r = await put("/strategies/mine", { ids: sel });
      await refresh();
      toast(`The analyst will use ${r.ids.length === 1 ? "this strategy" : `these ${r.ids.length} strategies`}.`, "success", 2600);
      if (onSaved) onSaved(r.ids);
      onClose();
    } catch (e) {
      toast(e.message || "Couldn't save your strategies.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay sp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !forced) onClose(); }}>
      <div className="sp" role="dialog" aria-modal="true" aria-label="Choose your strategies">
        <header className="sp-head">
          <div className="grow">
            <h2>How should the analyst trade?</h2>
            <p className="muted">It reads the chart with only the strategies you pick, and draws only what they use. Pick one or several. You can change this any time from the strategy button on the chart.</p>
          </div>
          {!forced ? <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button> : null}
        </header>
        <div className="sp-tools">
          <div className="sp-search">
            <Icon name="search" size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search strategies: sweep, RSI, scalp…" aria-label="Search strategies" />
          </div>
          <div className="sp-starters" aria-label="Quick picks">
            {STARTERS.map((s) => (
              <button key={s.label} className="chip" onClick={() => setSel(s.ids)}>{s.label}</button>
            ))}
          </div>
          <div className="sp-groups" role="tablist">
            <button className={group === "all" ? "on" : ""} onClick={() => setGroup("all")}>All</button>
            {(cat ? cat.groups : []).map((g) => (
              <button key={g.id} className={group === g.id ? "on" : ""} onClick={() => setGroup(g.id)} title={g.about}>
                <Icon name={GROUP_ICON[g.id] || "dot"} size={14} /> {g.name}
              </button>
            ))}
          </div>
        </div>
        <div className="sp-fit">
          {fit ? (
            <span className="muted">Sorted by how each did on <b>{fit.symbol} · {fit.tf}</b> over {fit.candles} candles, after costs. Past results don't promise future ones.</span>
          ) : (
            <>
              <span className="muted">{findings && findings.length ? <>Did best lately on {symbol} {tf}: <b>{findings.map((x) => x.name).join(", ")}</b>.</> : <>See which strategies have worked on <b>{symbol} · {tf}</b>.</>}</span>
              <button className="btn sm" onClick={testHere} disabled={fitBusy || !symbol}>{fitBusy ? <span className="spinner dark" /> : <Icon name="sliders" size={14} />} Test all on {symbol}</button>
            </>
          )}
        </div>
        <div className="sp-list">
          {!cat ? <div className="empty"><span className="spinner dark" /></div> : null}
          {list.map((s) => {
            const on = sel.includes(s.id);
            const f = fitBy[s.id];
            return (
              <div key={s.id} className={`sp-row${on ? " on" : ""}`}>
                <button className="sp-main" onClick={() => toggle(s.id)} aria-pressed={on}>
                  <span className="sp-ic"><Icon name={GROUP_ICON[s.group] || "dot"} size={16} /></span>
                  <span className="grow">
                    <b>{s.name}</b>
                    <small className="sp-how">{s.how}</small>
                    <span className="sp-tags">
                      <i>{s.timeframes.join(" · ")}</i>
                      {s.fixed_time ? <i className="ft">expiry {s.expiry} candles</i> : <i>target {s.rr}R</i>}
                      {f && f.trades ? (
                        <i className={(f.score || 0) > 0 ? "good" : "bad"}>{f.trades} trades · {pct(f.win_rate)} won · {f.fixed_time ? `${pct(f.breakeven)} needed` : `${(f.avg_r || 0) >= 0 ? "+" : ""}${(f.avg_r || 0).toFixed(2)}R avg`}</i>
                      ) : f ? <i>no trades here</i> : null}
                    </span>
                  </span>
                  <span className={`switch-ui${on ? " on" : ""}`} aria-hidden="true" />
                </button>
                <button className="sp-more" onClick={() => setOpenId(openId === s.id ? null : s.id)} aria-expanded={openId === s.id}>
                  {openId === s.id ? "Less" : "Where it works"}
                </button>
                {openId === s.id ? (
                  <div className="sp-detail">
                    <p><b>Waits for:</b> {s.wait_for}.</p>
                    <p><b>Tends to suit:</b> {s.best_for}</p>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <footer className="sp-foot">
          <span className="muted">{sel.length ? `${sel.length} selected` : "Pick at least one"}</span>
          <span className="grow" />
          {sel.length ? <button className="btn ghost sm" onClick={() => setSel([])}>Clear</button> : null}
          <button className="btn primary" disabled={!sel.length || busy} onClick={save}>{busy ? <span className="spinner" /> : <Icon name="check" size={16} />} Use {sel.length > 1 ? "these" : "this"}</button>
        </footer>
      </div>
    </div>
  );
}

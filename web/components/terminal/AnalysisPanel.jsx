"use client";
import { useState } from "react";
import Icon from "@/components/Icons";
import { useAuth } from "@/components/Providers";
import { requestAlert } from "@/components/AlertsBell";
import { fmtDateTime, fmtMoney, fmtPct, fmtPrice, fmtQty, minutesHuman, TF_LABEL, timeAgo } from "@/lib/format";
import { gradeClass, LAYERS } from "@/lib/analysis";
import DirectionBar from "@/components/DirectionBar";
import PlanLadder from "@/components/terminal/PlanLadder";
import { hudOf } from "@/components/terminal/ChartHud";

function Prob({ p, be, label }) {
  if (p === null || p === undefined) return null;
  const good = be !== undefined && be !== null ? p >= be : null;
  return (
    <div style={{ marginTop: 8 }}>
      <div className="row" style={{ justifyContent: "space-between", fontSize: "0.8rem", marginBottom: 4 }}>
        <span className="muted">{label}</span>
        <span className="num" style={{ fontWeight: 800, color: good === null ? "var(--text)" : good ? "var(--good)" : "var(--bad)" }}>
          {fmtPct(p)}{be !== undefined && be !== null ? <span className="faint" style={{ fontWeight: 600 }}> vs {fmtPct(be)} needed</span> : null}
        </span>
      </div>
      <div className="prob-bar">
        <i style={{ width: `${Math.max(2, Math.min(100, p * 100))}%` }} />
        {be !== undefined && be !== null ? <b style={{ left: `${Math.min(99, be * 100)}%` }} title="Break-even win rate" /> : null}
      </div>
    </div>
  );
}

export function AnalysisOptions({ settings, updateSettings, compact = false }) {
  const a = settings.analysis;
  const set = (k, v) => updateSettings({ analysis: { [k]: v } });
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="grid-2">
        <div className="field">
          <label>Account size ($)</label>
          <input className="input sm num" type="number" min="1" inputMode="decimal" value={a.account} onChange={(e) => set("account", e.target.value)} />
        </div>
        <div className="field">
          <label>Risk per trade (%)</label>
          <input className="input sm num" type="number" min="0.1" max="10" step="0.1" inputMode="decimal" value={a.risk_pct} onChange={(e) => set("risk_pct", e.target.value)} />
        </div>
      </div>
      {!compact ? (
        <div className="grid-2">
          <div className="field">
            <label>Your leverage (optional)</label>
            <input className="input sm num" type="number" min="1" max="200" placeholder="e.g. 10" value={a.leverage} onChange={(e) => set("leverage", e.target.value)} />
          </div>
          <div className="field">
            <label>Explanations</label>
            <select className="select sm" value={a.mode} onChange={(e) => set("mode", e.target.value)}>
              <option value="auto">Match my level</option>
              <option value="beginner">Beginner (simple)</option>
              <option value="pro">Pro (detailed)</option>
            </select>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Sizing({ s, dec, isCrypto }) {
  if (!s) return null;
  return (
    <div className="stack" style={{ gap: 6, fontSize: "0.86rem" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted">Risk</span><b className="num">{fmtMoney(s.risk_amount)} ({s.risk_pct}%)</b>
      </div>
      {isCrypto ? (
        <>
          <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">Size</span><b className="num">{fmtQty(s.units)} {s.unit} · {fmtMoney(s.notional)}</b></div>
          <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">Leverage</span><b className="num">{s.leverage}x isolated · margin {fmtMoney(s.margin)}</b></div>
          <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">Liquidation</span>
            <b className="num" style={{ color: s.liq_beyond_stop ? "var(--text)" : "var(--down)" }}>{fmtPrice(s.liquidation, dec)}</b>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">Max safe leverage</span><b className="num">{s.max_safe_leverage}x</b></div>
          {s.user_leverage ? (
            <div className={`badge ${s.user_leverage.safe ? "up" : "down"}`} style={{ height: "auto", padding: "6px 10px", whiteSpace: "normal" }}>
              At your {s.user_leverage.leverage}x: liquidation {fmtPrice(s.user_leverage.liquidation, dec)} —{" "}
              {s.user_leverage.safe ? "beyond your stop, OK" : "BEFORE your stop. Lower the leverage."}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">Size</span>
            <b className="num">{s.lots_rounded !== undefined ? `${Number(s.lots_rounded).toFixed(2)} lots` : ""} ({fmtQty(s.units)} {s.unit})</b>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">Notional</span><b className="num">{fmtMoney(s.notional)}</b></div>
          {s.margin_at ? (
            <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">Margin</span>
              <b className="num" style={{ fontSize: "0.8rem" }}>{Object.entries(s.margin_at).map(([k, v]) => `${k}: ${fmtMoney(v)}`).join(" · ")}</b>
            </div>
          ) : null}
        </>
      )}
      {s.too_small ? (
        <div className="badge warn" style={{ height: "auto", padding: "6px 10px", whiteSpace: "normal" }}>
          This size is below the minimum trade size. You need about {fmtMoney(s.min_capital)} to risk {s.risk_pct}% on this setup.
        </div>
      ) : null}
    </div>
  );
}

function PlanCard({ p, dec, title, isCrypto, dim, onAlert, onEdit }) {
  if (!p) return null;
  const j = Math.min(1, (p.tps || []).length - 1);
  return (
    <div className="card" style={{ padding: 14, opacity: dim ? 0.92 : 1 }}>
      {p.strategy_name ? <div className="hint" style={{ marginBottom: 6 }}>Strategy: <b>{p.strategy_name}</b></div> : null}
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className={`badge ${p.side === "long" ? "up" : "down"}`}>{p.side === "long" ? "BUY" : "SELL"} {String(p.type || "").toUpperCase()}</span>
          <b style={{ fontSize: "0.92rem" }}>{title}</b>
        </div>
        <span className={`grade ${gradeClass(p.grade)}`} style={{ width: 34, height: 34, fontSize: "0.95rem" }}>{p.grade}</span>
      </div>
      <PlanLadder p={p} dec={dec} />
      <div className="row wrap" style={{ gap: 6, marginTop: 8, fontSize: "0.8rem" }}>
        {p.chase_limit ? <span className="badge num">Don't chase past {fmtPrice(p.chase_limit, dec)}</span> : null}
        {p.expiry ? <span className="badge">Valid {p.expiry} candles</span> : null}
        {onEdit ? (
          <button className="badge" onClick={() => onEdit(p)} style={{ cursor: "pointer", marginLeft: "auto" }} title="Put this plan on the chart. Drag the entry, stop or target, then grade your edits.">
            <Icon name="pen" size={12} /> Edit on chart
          </button>
        ) : null}
        {onAlert ? (
          <button className="badge brand" onClick={() => onAlert(p)} style={{ cursor: "pointer" }} title="Get notified when price reaches the entry, stop and target">
            <Icon name="bell" size={12} /> Alert me
          </button>
        ) : null}
      </div>
      <Prob p={p.p_fill} label="Chance the entry fills (24 candles)" />
      <Prob p={(p.p_tp || [])[0]} be={(p.breakeven || [])[0]} label="TP1 before stop" />
      {j > 0 ? <Prob p={(p.p_tp || [])[j]} be={(p.breakeven || [])[j]} label={`TP${j + 1} before stop`} /> : null}
      {p.ev ? (
        <div className="row" style={{ justifyContent: "space-between", marginTop: 10, fontSize: "0.84rem" }}>
          <span className="muted">Expected value after costs (TP{j + 1})</span>
          <b className={`num ${p.ev[j] >= 0 ? "up" : "down"}`}>{p.ev[j] >= 0 ? "+" : ""}{Number(p.ev[j]).toFixed(2)}R</b>
        </div>
      ) : null}
      {p.invalidation ? <div className="hint" style={{ marginTop: 8 }}>Invalid if {p.invalidation}.</div> : null}
      {p.sizing ? (
        <>
          <div className="section-title">Size & leverage</div>
          <Sizing s={p.sizing} dec={dec} isCrypto={isCrypto} />
        </>
      ) : null}
    </div>
  );
}

function News({ news }) {
  if (!news) return null;
  const tone = news.risk === "high" ? "down" : news.risk === "medium" ? "warn" : "up";
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className={`badge ${tone}`} style={{ height: "auto", padding: "8px 10px", whiteSpace: "normal", lineHeight: 1.4, fontWeight: 600 }}>
        <Icon name={news.risk === "low" ? "check" : "alert"} size={15} style={{ flex: "none" }} /> {news.note}
      </div>
      {(news.events || []).slice(0, 5).map((e, i) => (
        <div key={i} className="row" style={{ fontSize: "0.84rem", alignItems: "flex-start" }}>
          <span className={`badge ${e.impact === "High" ? "down" : "warn"}`} style={{ minWidth: 44, justifyContent: "center" }}>{e.country}</span>
          <div className="grow">
            <div style={{ fontWeight: 600 }}>{e.title}</div>
            <div className="faint" style={{ fontSize: "0.76rem" }}>
              {minutesHuman(e.minutes_until)} · {e.impact} impact{e.forecast ? ` · forecast ${e.forecast}` : ""}{e.previous ? ` · prev ${e.previous}` : ""}
            </div>
          </div>
        </div>
      ))}
      {(news.headlines || []).slice(0, 5).map((h, i) => (
        <a key={i} href={h.link} target="_blank" rel="noopener noreferrer" className="row" style={{ alignItems: "flex-start", color: "var(--text)", fontSize: "0.85rem", textDecoration: "none" }}>
          <span style={{ width: 8, height: 8, borderRadius: 8, marginTop: 6, flex: "none", background: h.tone === "positive" ? "var(--up)" : h.tone === "negative" ? "var(--down)" : "var(--text-3)" }} />
          <div className="grow">
            <div>{h.title}</div>
            <div className="faint" style={{ fontSize: "0.74rem" }}>{h.source}{h.published ? ` · ${timeAgo(h.published)}` : ""}{h.general ? " · market news" : ""}</div>
          </div>
        </a>
      ))}
      {news.tone && news.tone.label !== "neutral" ? (
        <div className="hint">Headline tone: <b>{news.tone.label}</b> ({news.tone.method}).</div>
      ) : null}
    </div>
  );
}

function Report({ res, can, onUpgrade }) {
  const [which, setWhich] = useState(res.mode === "beginner" ? "beginner" : "pro");
  const text = which === "beginner" ? res.report_beginner : res.report_pro;
  return (
    <div>
      <div className="seg brand" style={{ marginBottom: 10 }}>
        <button className={which === "beginner" ? "on" : ""} onClick={() => setWhich("beginner")}>Simple</button>
        <button className={which === "pro" ? "on" : ""} onClick={() => setWhich("pro")}>Pro</button>
      </div>
      {text ? <div className="report">{text}</div> : (
        <div className="paywall">
          <b>The {which === "pro" ? "pro" : "simple"} report is part of Pro</b>
          <div className="muted" style={{ fontSize: "0.88rem", margin: "4px 0 10px" }}>On the free plan you get the report for your own level. Pro shows both, plus the model statistics.</div>
          {can("pro_report") ? null : <button className="btn sm primary" onClick={onUpgrade}>See plans</button>}
        </div>
      )}
    </div>
  );
}


async function copyText(text, toast, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, "success", 1600);
  } catch {
    toast(text, "info", 6000);
  }
}

/** Entry, stop and targets, each one tap to copy, plus "copy all" and "edit" (which moves the plan to My analysis). */
export function LevelsCard({ p, dec, symbol, tf, onEdit, onAlert, toast, title }) {
  if (!p) return null;
  const rows = [["EP", "Entry", p.entry, "ep"], ["SL", "Stop loss", p.sl, "sl"], ...(p.tps || []).map((t, i) => [`TP${i + 1}`, `Take profit ${i + 1}`, t, "tp"])];
  const all = `${symbol} ${tf} ${p.side === "long" ? "BUY" : "SELL"} ${String(p.type || "").toUpperCase()}\n`
    + rows.map(([k, , v]) => `${k} ${fmtPrice(v, dec)}`).join("\n");
  return (
    <div className="levels-card" data-tour="levels">
      <div className="lc-head">
        <span className={`badge ${p.side === "long" ? "up" : "down"}`}>{p.side === "long" ? "BUY" : "SELL"} · {p.type}</span>
        <b className="grow">{title}</b>
        <span className={`grade ${gradeClass(p.grade)}`} style={{ width: 32, height: 32, fontSize: "0.9rem" }}>{p.grade}</span>
      </div>
      <div className="lc-rows">
        {rows.map(([k, label, v, cls], i) => (
          <button key={k} className={`lc-row ${cls}`} onClick={() => copyText(fmtPrice(v, dec).replace(/,/g, ""), toast, `${k} ${fmtPrice(v, dec)}`)} title={`Copy ${label}`}>
            <span className="lc-k">{k}</span>
            <span className="lc-v num">{fmtPrice(v, dec)}</span>
            <span className="lc-d num faint">{cls === "tp" && p.rr ? `${Number(p.rr[i - 2] || 0).toFixed(1)}R` : cls === "sl" ? `${(Math.abs(p.entry - p.sl) / (p.entry || 1) * 100).toFixed(2)}%` : ""}</span>
            <Icon name="copy" size={15} />
          </button>
        ))}
      </div>
      {p.head ? (
        <div className="lc-note"><Icon name="book" size={14} /> Across years of markets, signals like this ended in profit about {Math.round(p.head.p_win * 100)}% of the time (needs about {Math.round(p.head.needed * 100)}%).</div>
      ) : null}
      {p.liquidity_guard ? (
        <div className="lc-note"><Icon name="shield" size={14} /> Stop placed past the liquidity at {fmtPrice(p.liquidity_guard.pool, dec)}, where stop hunts usually finish ({Number(p.liquidity_guard.depth_atr).toFixed(2)} ATR {p.liquidity_guard.learned ? "past pools like it, learned from years of markets" : "on this chart"}).</div>
      ) : null}
      {p.sweep_first ? <div className="lc-note warn"><Icon name="alert" size={14} /> {p.sweep_first.note}</div> : null}
      <div className="lc-actions">
        <button className="btn sm" onClick={() => copyText(all, toast, "The plan")}><Icon name="copy" size={14} /> Copy all</button>
        {onEdit ? <button className="btn sm" onClick={() => onEdit(p)} title="Edit this analysis in My analysis, with all its drawings"><Icon name="pen" size={14} /> Edit</button> : null}
        {onAlert ? <button className="btn sm" onClick={() => onAlert(p)}><Icon name="bell" size={14} /> Alert me</button> : null}
      </div>
    </div>
  );
}

function Confidence({ c }) {
  if (!c || c.level === "none") return null;
  return <span className={`conf conf-${c.level}`} title={c.text}>{c.level === "good" ? "Good" : c.level === "moderate" ? "Moderate" : "Low"} confidence</span>;
}

function FixedTime({ ft }) {
  if (!ft) return null;
  const dir = ft.direction;
  return (
    <div className={`ft-card ${dir === "UP" ? "up" : dir === "DOWN" ? "down" : ""}`} data-tour="fixedtime">
      <div className="row">
        <span className="ft-dir">{dir ? (dir === "UP" ? "▲ UP" : "▼ DOWN") : "No call"}</span>
        {dir ? <span className="grow faint">{ft.expiry} candles · {ft.expiry_minutes} min</span> : <span className="grow" />}
        {dir ? <span className={`badge ${ft.edge > 0.01 ? "up" : "warn"}`}>{Math.round((ft.p_win || 0) * 100)}% vs {Math.round(ft.breakeven * 100)}% needed</span> : null}
      </div>
      <div className="hint" style={{ marginTop: 6 }}>{ft.text}</div>
      {ft.skip_if && ft.skip_if.length ? <div className="lc-note warn" style={{ marginTop: 8 }}><Icon name="alert" size={14} /> Skip it: {ft.skip_if.join("; ")}.</div> : null}
      <div className="ft-calls">
        {(ft.calls || []).map((c) => (
          <div key={c.id} className="row" style={{ fontSize: "0.8rem" }}>
            <span className="grow">{c.name}</span>
            {c.signal ? <b className={c.dir === 1 ? "up" : "down"}>{c.dir === 1 ? "UP" : "DOWN"}</b> : <span className="faint">waiting</span>}
            <span className="faint num">{c.record && c.record.trades ? `${c.record.trades} calls · ${Math.round((c.record.win_rate || 0) * 100)}%` : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);
const pctOf = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "–");

/** One row of the "More detail" list: a title, a short summary on the right, the section inside when opened. */
function More({ title, hint, children, tour, open = false }) {
  return (
    <details className="ax-more-item" open={open || undefined} data-tour={tour}>
      <summary><span className="grow">{title}</span>{hint ? <span className="ax-more-hint">{hint}</span> : null}<Icon name="chevronDown" size={15} /></summary>
      <div className="ax-more-body">{children}</div>
    </details>
  );
}

/** The best entry, first and large: side, entry, stop, targets (each one tap to copy), the tested odds, the grade,
 *  the target style, and what to do with it. */
function EntryHero({ res, hud, dec, symbol, tf, toast, onEdit, onAlert, onAsk, onTargetMode, onSend, onPine, busy, showLevels }) {
  const { settings } = useAuth();
  const p = res.plan;
  const v = res.verdict || {};
  const targetMode = res.target_mode || settings.analysis.targetMode || "liquidity";
  if (!p) {
    return (
      <section className="ax-hero none" data-tour="verdict">
        <div className="axh-top"><span className="axh-kind">No setup</span><span className="axh-meta">{res.symbol} · {res.tf}</span></div>
        <div className="axh-side">Nothing to take here</div>
        <p className="axh-sub">{v.headline}</p>
      </section>
    );
  }
  const long = p.side === "long";
  const state = hud ? hud.state : v.trade ? "go" : "best";
  const rows = [["EP", "Entry", p.entry, "ep", -1], ["SL", "Stop loss", p.sl, "sl", -1], ...(p.tps || []).slice(0, 3).map((t, i) => [`TP${i + 1}`, `Take profit ${i + 1}`, t, "tp", i])];
  const all = `${symbol} ${tf} ${long ? "BUY" : "SELL"} ${String(p.type || "").toUpperCase()}\n` + rows.map(([k, , val]) => `${k} ${fmtPrice(val, dec)}`).join("\n");
  const p1 = (p.p_tp || [])[0];
  const be1 = (p.breakeven || [])[0];
  return (
    <section className={`ax-hero ${long ? "long" : "short"} st-${state}`} data-tour="verdict">
      <div className="axh-top">
        <span className="axh-kind">{state === "go" ? "Trade setup" : "Best entry"}</span>
        <span className="axh-meta">{res.symbol} · {res.tf} · {fmtPrice(res.price, dec)}</span>
        {showLevels ? <span className={`grade ${gradeClass(v.grade)}`} title="Grade: how many of the analyst's checks line up, capped by its confidence">{v.grade}</span> : null}
      </div>
      <div className="axh-main">
        <b className="axh-side">{long ? "Buy" : "Sell"} {p.type === "market" ? "now" : p.type}</b>
        {showLevels ? <span className="axh-price num">{fmtPrice(p.entry, dec)}</span> : null}
      </div>
      <div className="axh-sub">{p.strategy_name ? <b>{p.strategy_name}</b> : null}{p.strategy_name ? " · " : ""}{p.setup}</div>
      <div className="axh-tags">
        <Confidence c={v.confidence} />
        {state === "best" ? <span className="axh-tag">Not confirmed: smaller size</span> : null}
        {v.news_warning ? <span className="axh-tag bad">News soon</span> : null}
      </div>
      {res.fallback_note ? <div className="axh-note"><Icon name="info" size={14} /> <span>{res.fallback_note}</span></div> : null}
      {showLevels ? (
        <>
          <div className="axh-levels" data-tour="levels">
            {rows.map(([k, label, val, cls, i]) => (
              <button key={k} className={`axh-lv ${cls}`} onClick={() => copyText(fmtPrice(val, dec).replace(/,/g, ""), toast, `${k} ${fmtPrice(val, dec)}`)} title={`Copy ${label}`}>
                <span className="k">{k}</span>
                <span className="v num">{fmtPrice(val, dec)}</span>
                <span className="m num">{cls === "tp" ? `${Number((p.rr || [])[i] || 0).toFixed(1)}R · ${pctOf((p.p_tp || [])[i])}` : cls === "sl" ? `${(Math.abs(p.entry - p.sl) / (p.entry || 1) * 100).toFixed(2)}% away` : p.type}</span>
              </button>
            ))}
          </div>
          {Number.isFinite(p1) ? (
            <div className="axh-odds">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span>TP1 before the stop</span>
                <b className={`num ${Number.isFinite(be1) && p1 >= be1 ? "up" : "down"}`}>{pctOf(p1)}<span className="faint"> · needs {pctOf(be1)}</span></b>
              </div>
              <div className="prob-bar"><i style={{ width: `${Math.max(2, Math.min(100, p1 * 100))}%` }} />{Number.isFinite(be1) ? <b style={{ left: `${Math.min(99, be1 * 100)}%` }} /> : null}</div>
            </div>
          ) : null}
          <div className="axh-target" role="group" aria-label="Target style">
            <span>Targets</span>
            <div className="seg">
              <button className={targetMode !== "winrate" ? "on" : ""} disabled={busy} onClick={() => targetMode !== "liquidity" && onTargetMode("liquidity")} title="TP1 at the first liquidity level: bigger wins, fewer of them">At liquidity</button>
              <button className={targetMode === "winrate" ? "on" : ""} disabled={busy} onClick={() => targetMode !== "winrate" && onTargetMode("winrate")} title="TP1 where about 68% of similar setups got before the stop; the liquidity level stays as TP2">Higher win rate</button>
            </div>
          </div>
        </>
      ) : null}
      <div className="axh-actions">
        {onAlert && showLevels ? <button className="btn sm primary" onClick={() => onAlert(p)}><Icon name="bell" size={14} /> Alert me</button> : null}
        {onSend && showLevels ? <button className="btn sm" onClick={() => onSend(p)} title="Send the entry, stop loss and take profit to your broker"><Icon name="send" size={14} /> Send to broker</button> : null}
        {onPine && showLevels ? <button className="btn sm" onClick={() => onPine(p)} title="Draw this plan on a TradingView chart"><Icon name="tv" size={14} /> TradingView</button> : null}
        {onEdit ? <button className="btn sm" onClick={() => onEdit(p)} title="Edit this analysis in My analysis, with all its drawings"><Icon name="pen" size={14} /> Edit</button> : null}
        {showLevels ? <button className="btn sm" onClick={() => copyText(all, toast, "The plan")}><Icon name="copy" size={14} /> Copy</button> : null}
        <button className="btn sm ghost" onClick={() => onAsk(`Explain this ${res.symbol} ${res.tf} analysis to me. Why ${v.action}?`)}><Icon name="sparkles" size={14} /> Ask why</button>
      </div>
    </section>
  );
}

/** Why the entry isn't confirmed (or what to be careful of): the same numbered flags as the chart, what would make
 *  it safer, what is already in place, and every check behind the grade. */
function Reasons({ res, hud, dec, symbol, tf }) {
  const { settings, updateSettings } = useAuth();
  if (!hud) return null;
  const on = settings.analysis.hud !== false;
  const flags = (hud.flags || []).filter((f) => f.n);
  const good = (hud.flags || []).filter((f) => f.tone === "good");
  const steps = hud.steps || [];
  const toneOf = (n) => (flags.find((f) => f.n === n) || {}).tone || "wait";
  const nOf = (key) => (flags.find((f) => f.key === key) || {}).n;
  const checks = hud.checks || [];
  const lvl = flags.find((f) => f.need && Number.isFinite(f.price));
  const title = hud.state === "go" ? "Before you enter" : hud.state === "dont" ? "On the chart" : "Why it isn't confirmed";
  return (
    <section className="ax-card">
      <header className="ax-h">
        <b>{title}</b>
        {hud.total ? <span className="ax-count">{hud.met}/{hud.total} checks</span> : null}
        <label className="ax-switch" title="Show these reasons on the chart">
          <span>On chart</span>
          <button className={`switch-ui${on ? " on" : ""}`} aria-pressed={on} aria-label="Show the reasons on the chart" onClick={() => updateSettings({ analysis: { hud: !on } })} />
        </label>
      </header>
      {flags.length ? (
        <ol className="ax-reasons">
          {flags.map((f) => (
            <li key={f.n}>
              <i className={`hud-n ${f.tone}`}>{f.n}</i>
              <div><b>{f.title}</b><p>{f.text}</p></div>
            </li>
          ))}
        </ol>
      ) : <p className="ax-empty">Nothing against it on this chart.</p>}
      {steps.length ? (
        <div className="ax-safer">
          <span className="ax-safer-h">{hud.state === "go" ? "Better still, wait for" : "Safer: wait for"}</span>
          {steps.map((s0) => <span key={s0.n} className="ax-step"><i className={`hud-n ${toneOf(s0.n)}`}>{s0.n}</i>{s0.text}</span>)}
        </div>
      ) : null}
      {good.length ? <div className="ax-good">{good.map((g) => <span key={g.key}><b>✓</b> {g.title}</span>)}</div> : null}
      {checks.length ? (
        <details className="ax-checks">
          <summary>Every check behind the grade</summary>
          <ul>
            {[...checks.filter((c) => !c.ok), ...checks.filter((c) => c.ok)].map((c, i) => {
              const n = !c.ok ? nOf(c.key) : null;
              return (
                <li key={i} className={c.ok ? "ok" : "no"}>
                  {c.ok ? <span className="ic">✓</span> : n ? <i className={`hud-n ${toneOf(n)}`}>{n}</i> : <span className="ic">×</span>}
                  <span>{cap(c.text)}</span>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
      {lvl && symbol ? (
        <button className="btn sm block" style={{ marginTop: 10 }}
          onClick={() => requestAlert({ symbol, tf, price: Number(Number(lvl.price).toFixed(dec)), op: lvl.price > res.price ? "above" : "below", note: lvl.title })}>
          <Icon name="bell" size={14} /> Alert me when {fmtPrice(lvl.price, dec)} is {lvl.key === "structure" ? "broken" : "reached"}
        </button>
      ) : null}
    </section>
  );
}

function TfRow({ r, best, dec, onTf }) {
  const isBest = !!(best && best.tf === r.tf);
  const [open, setOpen] = useState(isBest);
  const sc = r.scan || {};
  const b = sc.best;
  const mine = sc.mine || [];
  return (
    <li className={`ax-tf${isBest ? " best" : ""}${r.current ? " cur" : ""}${open ? " open" : ""}`}>
      <button className="ax-tf-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <b className="tf num">{r.tf}</b>
        <span className={`tr ${r.trend > 0 ? "up" : r.trend < 0 ? "down" : ""}`} title={`Trend ${r.trend_word}`}>{r.trend > 0 ? "▲" : r.trend < 0 ? "▼" : "–"}</span>
        <span className="what">{b ? <><em className={b.side === "long" ? "up" : "down"}>{b.side === "long" ? "Buy" : "Sell"}</em> {b.name}</> : <span className="faint">No setup</span>}</span>
        {isBest ? <span className="ax-pill best">Best case</span> : r.current ? <span className="ax-pill">This chart</span> : null}
        {b ? <span className={`gchip g-${b.grade}`}>{b.grade}</span> : null}
        <Icon name="chevronDown" size={14} />
      </button>
      {open ? (
        <div className="ax-tf-body">
          {b ? (
            <div className="ax-tf-levels num">
              <span><i>EP</i>{fmtPrice(b.entry, dec)}</span><span><i>SL</i>{fmtPrice(b.sl, dec)}</span><span><i>TP</i>{fmtPrice(b.tp, dec)}</span><span><i>R</i>{Number(b.rr).toFixed(1)}</span>
            </div>
          ) : <div className="ax-tf-why">{sc.why || "No live setup on this timeframe."}</div>}
          {b ? <div className="ax-tf-why">{b.type === "market" ? "At market" : "Limit, wait for the return"}{b.age ? ` · signal ${b.age} candle${b.age > 1 ? "s" : ""} ago` : " · signal on the last candle"}{b.why && b.why.length ? ` · ${b.why.join(" · ")}` : ""}</div> : null}
          {sc.others && sc.others.length ? <div className="ax-tf-why">Also live: {sc.others.map((o) => `${o.name} (${o.side === "long" ? "buy" : "sell"}, ${o.grade})`).join(", ")}</div> : null}
          {mine.length ? (
            <ul className="ax-mine">
              {mine.map((m) => <li key={m.id} className={m.status}><b>{m.name}</b> {m.text}</li>)}
            </ul>
          ) : null}
          {!r.current && onTf ? <button className="btn sm" onClick={() => onTf(r.tf)}>Open the {r.tf} chart</button> : null}
        </div>
      ) : null}
    </li>
  );
}

/** Every timeframe: the best live setup on each (from every strategy), what your strategies are doing there, and
 *  the best case across all of them. */
function Timeframes({ mtf, dec, onTf }) {
  if (!mtf || !mtf.rows || !mtf.rows.length) return null;
  const best = mtf.best;
  return (
    <section className="ax-card" data-tour="mtf">
      <header className="ax-h">
        <b>Every timeframe</b>
        <span className={`badge ${mtf.alignment > 0.15 ? "up" : mtf.alignment < -0.15 ? "down" : "warn"}`}>{mtf.word}</span>
      </header>
      {best ? (
        <div className="ax-bestcase">
          <span className="faint">Best case</span>
          <b><span className="num">{best.tf}</span> · <em className={best.side === "long" ? "up" : "down"}>{best.side === "long" ? "Buy" : "Sell"}</em> {best.type === "market" ? "now" : "limit"} <span className="num">{fmtPrice(best.entry, dec)}</span></b>
          <span className="faint">{best.name} · grade {best.grade}</span>
        </div>
      ) : null}
      <ul className="ax-tfs">{mtf.rows.map((r) => <TfRow key={r.tf} r={r} best={best} dec={dec} onTf={onTf} />)}</ul>
      <p className="ax-foot-note">{mtf.text} Grades here are quick checks (trend on that timeframe and the two above, room to target, a fresh signal); the main entry has the full analysis.</p>
    </section>
  );
}

function LiquidityBody({ liq, dec }) {
  return (
    <div className="stack" style={{ gap: 8, fontSize: "0.85rem" }}>
      <div className="muted">{liq.text}</div>
      {liq.learned && liq.pools && liq.pools.length ? (
        <table className="liq-table">
          <thead><tr><th>Pool</th><th className="r">Taken in 24c</th><th className="r">Then reversed</th></tr></thead>
          <tbody>
            {liq.pools.slice(0, 8).map((p, i) => (
              <tr key={i}>
                <td><span className={`num ${p.side === "above" ? "down" : "up"}`}>{fmtPrice(p.price, dec)}</span> <span className="faint">{p.kind} · {p.d_atr} ATR</span></td>
                <td className="r num"><span className="liq-bar" style={{ "--p": `${Math.round(p.p_sweep * 100)}%` }} />{Math.round(p.p_sweep * 100)}%</td>
                <td className="r num">{p.p_reverse !== null && p.p_reverse !== undefined ? `${Math.round(p.p_reverse * 100)}%` : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="grid-2">
          <div><div className="faint" style={{ fontSize: "0.76rem" }}>Buy-side (above)</div>{(liq.above || []).map((x) => <div key={x} className="num down">{fmtPrice(x, dec)}</div>)}</div>
          <div><div className="faint" style={{ fontSize: "0.76rem" }}>Sell-side (below)</div>{(liq.below || []).map((x) => <div key={x} className="num up">{fmtPrice(x, dec)}</div>)}</div>
        </div>
      )}
      {liq.learned ? <div className="hint">Odds learned from years of markets: how often pools like these were taken within 24 candles, and how often price turned back after the sweep. Estimates, not promises.</div> : null}
    </div>
  );
}

function StrategiesBody({ sb, onChange }) {
  if (!sb || sb.mode !== "chosen") {
    return (
      <div className="stack" style={{ gap: 8 }}>
        <div className="hint">The analyst uses its own mix of setups. Pick strategies and it reads the chart with them, and still gives the best entry when they have none.</div>
        <button className="btn sm" onClick={onChange}><Icon name="target" size={14} /> Pick your strategies</button>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      {sb.items.map((x) => {
        const r = x.record || {};
        return (
          <div key={x.id} className="strat-item">
            <div className="row">
              <b className="grow">{x.name}</b>
              {x.signal ? <span className={`badge ${x.signal === "long" || x.signal === "up" ? "up" : "down"}`}>{x.signal === "long" ? "buy now" : x.signal === "short" ? "sell now" : x.signal.toUpperCase()}{x.age ? ` · ${x.age}c ago` : ""}</span>
                : x.missed ? <span className="badge warn">missed · ran {x.missed.age}c ago</span> : <span className="badge">waiting</span>}
            </div>
            <div className="hint">{x.signal ? "" : `Waiting for ${x.wait_for}.`}{!x.suits_tf ? " Usually used on other timeframes." : ""}{!x.suits_market ? " Not its usual market." : ""}</div>
            {r.trades ? (
              <div className="hint num">On this chart: {r.trades} trades · {Math.round((r.win_rate || 0) * 100)}% won · {r.breakeven ? `${Math.round(r.breakeven * 100)}% needed` : `${r.avg_r >= 0 ? "+" : ""}${Number(r.avg_r || 0).toFixed(2)}R avg`} · {r.verdict}</div>
            ) : <div className="hint">{r.verdict || "No trades on the loaded candles."}</div>}
            {x.history ? (
              <div className="hint num">Years of history on markets like this: {x.history.trades.toLocaleString()} trades · {Math.round(x.history.win_rate * 100)}% won · {x.history.avg_r >= 0 ? "+" : ""}{Number(x.history.avg_r).toFixed(2)}R avg</div>
            ) : null}
            {x.head ? <div className="hint num">This signal: about {Math.round(x.head.p_win * 100)}% chance of profit (needs {Math.round(x.head.needed * 100)}%).</div> : null}
          </div>
        );
      })}
      <button className="btn sm" onClick={onChange}><Icon name="sliders" size={14} /> Change strategies</button>
    </div>
  );
}

export default function AnalysisPanel({ res, busy, step, steps, onAnalyse, onAsk, onClean, onUpgrade, hiddenLayers, toggleLayer, layers, showAlt, setShowAlt, stale, symbolLabel, tf, symbol, onEditPlan, onStrategies, onTf, onFull, onSend, onPine }) {
  const { settings, updateSettings, can, user, toast } = useAuth();
  const showLevels = settings.analysis.showLevels !== false;
  if (busy && !res) {
    return (
      <div className="stack">
        <div className="card" style={{ padding: 16 }}>
          <div className="row" style={{ gap: 10, marginBottom: 12 }}><span className="spinner dark" /> <b>Analysing {symbolLabel} · {tf}</b></div>
          <ul className="check-list">
            {steps.map((s, i) => (
              <li key={s} className={i < step ? "ok" : ""} style={{ opacity: i <= step ? 1 : 0.4 }}>
                <span className="ic" style={{ background: i < step ? undefined : "var(--bg-4)" }}>{i < step ? "✓" : i === step ? "•" : ""}</span> {s}…
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  if (!res) {
    const mine = (user && user.strategies) || [];
    return (
      <div className="stack">
        <div className="ready">
          <span className="ready-ic"><Icon name="zap" size={24} /></span>
          <h3>Read {symbolLabel} on {TF_LABEL[tf] || tf}</h3>
          <p className="muted">The analyst marks structure and liquidity, checks every timeframe and the news, then gives the best entry{showLevels ? " with stop and targets" : ""} from {mine.length ? `your ${mine.length} strateg${mine.length > 1 ? "ies" : "y"} (or its own setups when they have none)` : "its own mix of setups"}.</p>
          <button className="btn primary block lg" onClick={onAnalyse}><Icon name="zap" size={18} /> Analyse {symbolLabel}</button>
          <button className="btn ghost block sm" onClick={onStrategies} style={{ marginTop: 8 }}><Icon name="target" size={14} /> {mine.length ? "Change strategies" : "Pick strategies first"}</button>
          <div className="hint" style={{ marginTop: 6 }}>Draw your own levels first if you want the analyst to check them.</div>
        </div>
        <label className="row ap-toggle">
          <span className="grow"><b>Show entry, stop and targets</b><small>Off: analysis only, no trade levels</small></span>
          <button className={`switch-ui${showLevels ? " on" : ""}`} aria-pressed={showLevels} onClick={() => updateSettings({ analysis: { showLevels: !showLevels } })} />
        </label>
        <div className="section-title">Your settings</div>
        <AnalysisOptions settings={settings} updateSettings={updateSettings} />
      </div>
    );
  }
  const v = res.verdict || {};
  const dec = res.decimals;
  const isCrypto = res.asset_class === "crypto";
  const hud = hudOf(res);
  const planAlert = (p) => {
    const j = Math.min(1, (p.tps || []).length - 1);
    requestAlert({ symbol, tf, decimals: dec, plan: { side: p.side, entry: p.entry, sl: p.sl, tp: (p.tps || [])[j] } });
  };
  const model = res.model || {};
  const conflict = v.conflict || (res.strategies && res.strategies.conflict);
  const setTargetMode = (m) => {
    updateSettings({ analysis: { targetMode: m } });
    onAnalyse({ targetMode: m });
  };
  const nw = res.news;
  const sz = res.plan && res.plan.sizing;
  return (
    <div className="ap ax">
      {stale ? (
        <button className="ax-stale" onClick={onAnalyse}><Icon name="refresh" size={14} /> A new candle closed: analyse again</button>
      ) : null}
      <EntryHero res={res} hud={hud} dec={dec} symbol={res.symbol || symbol} tf={res.tf} toast={toast} busy={busy} showLevels={showLevels}
        onEdit={onEditPlan || null} onAlert={symbol ? planAlert : null} onAsk={onAsk} onTargetMode={setTargetMode} onSend={onSend || null} onPine={onPine || null} />
      {res.fixed_time && settings.analysis.fixedTime ? <FixedTime ft={res.fixed_time} /> : null}
      {conflict && conflict.buyers && conflict.sellers && conflict.buyers.length && conflict.sellers.length ? (
        <div className="ax-flag warn"><Icon name="alert" size={14} /> {conflict.note}</div>
      ) : null}
      <Reasons res={res} hud={hud} dec={dec} symbol={symbol} tf={tf} />
      <Timeframes mtf={res.mtf} dec={dec} onTf={onTf} />
      {res.fixed_time && !settings.analysis.fixedTime ? <FixedTime ft={res.fixed_time} /> : null}

      <section className="ax-more">
        <div className="ax-more-h">More detail</div>
        {showLevels && res.how_to_enter && res.how_to_enter.length ? (
          <More title="How to take this trade" hint={`${res.how_to_enter.length} steps`} tour="howto">
            <ol className="howto">{res.how_to_enter.map((s0, i) => <li key={i}>{s0}</li>)}</ol>
          </More>
        ) : null}
        {showLevels && res.plan ? (
          <More title="Odds, size & leverage" hint={sz ? `${fmtMoney(sz.risk_amount)} risk` : null}>
            <PlanCard p={res.plan} dec={dec} isCrypto={isCrypto} title={v.trade ? "The plan" : "Best entry"} onAlert={null} onEdit={null} />
          </More>
        ) : null}
        {res.liquidity ? <More title="Liquidity" hint={res.liquidity.draw ? `drawn ${res.liquidity.draw}` : null}><LiquidityBody liq={res.liquidity} dec={dec} /></More> : null}
        {res.probabilities ? (
          <More title="Which way next" hint="next 24 candles" tour="direction">
            <DirectionBar probs={res.probabilities} decimals={dec} trained={model.trained !== false} />
          </More>
        ) : null}
        <More title="Your strategies" hint={res.strategies && res.strategies.mode === "chosen" ? `${res.strategies.items.length} chosen` : "analyst's mix"}>
          <StrategiesBody sb={res.strategies} onChange={onStrategies} />
        </More>
        <More title="News & calendar" hint={nw ? <span className={`badge ${nw.risk === "high" ? "down" : nw.risk === "medium" ? "warn" : "up"}`}>{nw.risk} risk</span> : null}>
          <News news={nw} />
        </More>
        {res.levels && res.levels.length ? (
          <More title="Key levels" hint={`${Math.min(14, res.levels.filter((c) => Math.abs(c.dist_atr) <= 8).length)} near price`}>
            <table className="levels-table">
              <tbody>
                {[...res.levels].sort((a, b) => b.price - a.price).filter((c) => Math.abs(c.dist_atr) <= 8).slice(0, 14).map((c, i) => (
                  <tr key={i}>
                    <td className="num" style={{ fontWeight: 700, color: c.side === "above" ? "var(--bad)" : "var(--good)", whiteSpace: "nowrap" }}>{fmtPrice(c.price, dec)}</td>
                    <td>{c.labels.slice(0, 3).join(" + ")}</td>
                    <td className="r num faint">{c.p_touch !== undefined && c.p_touch !== null ? fmtPct(c.p_touch) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="hint" style={{ padding: "6px 6px 2px" }}>% = chance price reaches the level within 24 candles.</div>
          </More>
        ) : null}
        {res.user_drawings && res.user_drawings.length ? (
          <More title="Your levels" hint={`${res.user_drawings.length}`} open>
            <div className="stack" style={{ gap: 8, fontSize: "0.85rem" }}>
              {res.user_drawings.map((u, i) => (
                <div key={i}>
                  <b>{u.label || u.type}</b>{" "}
                  {u.error ? <span className="down">{u.error}</span> : (
                    <span className="muted">
                      {u.level !== undefined ? `${fmtPrice(u.level, dec)} (${u.role}, ${Math.abs(u.distance_atr || 0).toFixed(1)} ATR away)` : ""}
                      {u.p_touch_24 !== undefined ? ` · ${fmtPct(u.p_touch_24)} chance to be reached` : ""}
                      {u.tests ? ` · tested ${u.tests}× (held ${u.held}, broke ${u.broke})` : ""}
                      {u.touches !== undefined ? ` · ${u.touches} touches, ${u.status}` : ""}
                      {u.confluence && u.confluence.length ? ` · lines up with ${u.confluence.slice(0, 3).join(", ")}` : " · no other level agrees"}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </More>
        ) : null}
        {showLevels && res.alternative ? (
          <More title="If it goes the other way" hint={`${res.alternative.side === "long" ? "buy" : "sell"} · grade ${res.alternative.grade}`}>
            <PlanCard p={res.alternative} dec={dec} isCrypto={isCrypto} title="Alternative plan" dim onAlert={symbol ? (p) => planAlert(p) : null} onEdit={onEditPlan || null} />
          </More>
        ) : null}
        {res.tendencies && res.tendencies.length ? (
          <More title="Your tendencies" hint="from your replays">
            {res.tendencies.map((t, i) => <div key={i} className="hint" style={{ lineHeight: 1.5, marginTop: i ? 8 : 0 }}>{t}</div>)}
          </More>
        ) : null}
        {res.learning && res.learning.message ? (
          <More title="What the analyst's record says" hint={`${res.learning.settled} calls`}>
            <div className="hint" style={{ lineHeight: 1.5 }}>{res.learning.message}</div>
          </More>
        ) : null}
        <More title="On the chart" hint={`${layers.length} layers`}>
          <div className="stack" style={{ gap: 10 }}>
            <div className="hint">{res.layers_scope ? "The chart shows what your strategies use. Tap any drawing on the chart to see why it's there; tap an EP, SL or TP label to copy it." : "Tap any drawing on the chart to see why it's there; tap an EP, SL or TP label to copy it."}</div>
            {showLevels ? <label className="check"><input type="checkbox" checked={showAlt} onChange={(e) => setShowAlt(e.target.checked)} /> Show the alternative plan</label> : null}
            <div className="grid-2" style={{ gap: 6 }}>
              {layers.filter((l) => !res.layers_scope || res.layers_scope.includes(l.id) || l.id === "indicators").map((l) => (
                <label key={l.id} className="check" style={{ fontSize: "0.84rem" }}>
                  <input type="checkbox" checked={!hiddenLayers.has(l.id)} onChange={() => toggleLayer(l.id)} /> {LAYERS[l.id] || l.id}
                </label>
              ))}
            </div>
          </div>
        </More>
        <More title="How reliable is this?" hint={model.trained ? (model.edge_proven ? "edge proven" : "no proven edge") : "model not trained"}>
          <div style={{ fontSize: "0.86rem" }} className="stack">
            {model.trained ? (
              <>
                <div>Probabilities come from models trained on {model.rows && model.rows.race ? Number(model.rows.race).toLocaleString() : "many"} historical situations and tested on data they never saw.</div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {model.direction_auc ? <span className="badge">Direction AUC {Number(model.direction_auc).toFixed(2)}</span> : null}
                  {model.race_skill !== undefined ? <span className="badge">Target/stop skill {fmtPct(model.race_skill, 1)}</span> : null}
                  <span className={`badge ${model.edge_proven ? "up" : "warn"}`}>{model.edge_proven ? "Edge proven in testing" : "No proven edge yet"}</span>
                </div>
                {!model.edge_proven ? (
                  <div className="muted">The odds are calibrated, but testing hasn't proven that following every plan makes money after costs. Use the analysis to structure decisions and manage risk, not as a guarantee.</div>
                ) : <div className="muted">Past test results don't guarantee future results. Keep risk small.</div>}
              </>
            ) : (
              <div className="muted">The probability model isn't trained on this server yet, so the odds are rough estimates. The levels and structure are still computed from the chart.</div>
            )}
            <div className="hint">{res.disclaimer}</div>
            <div className="hint">Data: {res.source} · analysed in {res.seconds}s · {fmtDateTime(res.now)}{user && user.role === "admin" && res.brain_status ? ` · brain: ${res.brain_status}` : ""}</div>
          </div>
        </More>
      </section>

      {onFull ? <button className="ax-read" onClick={onFull}><Icon name="book" size={16} /> <span className="grow">Read the full analysis</span><Icon name="chevronRight" size={16} /></button> : (
        <More title="Full report"><Report res={res} can={can} onUpgrade={onUpgrade} /></More>
      )}
      <div className="ax-foot">
        <button className="btn sm ghost" onClick={onAnalyse} disabled={busy}><Icon name="refresh" size={14} /> {busy ? "Analysing…" : "Refresh"}</button>
        {onClean ? <button className="btn sm ghost" onClick={onClean} title="Remove this analysis from the chart"><Icon name="trash" size={14} /> Clean</button> : null}
        <span className="grow" />
        <span className="faint">{v.tf_note ? "Changes with every new candle" : ""}</span>
      </div>
    </div>
  );
}

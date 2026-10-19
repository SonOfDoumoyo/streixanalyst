"use client";
import { useState } from "react";
import Icon from "@/components/Icons";
import { useAuth } from "@/components/Providers";
import { requestAlert } from "@/components/AlertsBell";
import { fmtDateTime, fmtMoney, fmtPct, fmtPrice, fmtQty, minutesHuman, TF_LABEL, timeAgo } from "@/lib/format";
import { gradeClass, LAYERS, verdictTone } from "@/lib/analysis";
import DirectionBar from "@/components/DirectionBar";
import PlanLadder from "@/components/terminal/PlanLadder";

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

export default function AnalysisPanel({ res, busy, step, steps, onAnalyse, onAsk, onClean, onUpgrade, hiddenLayers, toggleLayer, layers, detail, setDetail, showAlt, setShowAlt, stale, symbolLabel, tf, symbol, onEditPlan }) {
  const { settings, updateSettings, can, user } = useAuth();
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
    return (
      <div className="stack">
        <div className="card" style={{ padding: 18, textAlign: "center" }}>
          <div style={{ width: 54, height: 54, borderRadius: 16, margin: "0 auto 12px", display: "grid", placeItems: "center", background: "rgba(47,134,246,.14)", color: "var(--brand-2)" }}>
            <Icon name="zap" size={26} />
          </div>
          <h3 style={{ margin: "0 0 6px", fontFamily: "var(--font-display)" }}>Ready when you are</h3>
          <p className="muted" style={{ margin: "0 0 14px", fontSize: "0.9rem" }}>
            Structure, liquidity, key levels, news and a trade plan with entry, stop and targets for {symbolLabel} on {TF_LABEL[tf] || tf}, drawn on your chart.
          </p>
          <button className="btn primary block lg" onClick={onAnalyse}><Icon name="zap" size={18} /> Analyse {symbolLabel}</button>
          <div className="hint" style={{ marginTop: 10 }}>Draw your own levels first if you want the analyst to check them.</div>
        </div>
        <div className="section-title">Your settings</div>
        <AnalysisOptions settings={settings} updateSettings={updateSettings} />
      </div>
    );
  }
  const v = res.verdict || {};
  const tone = verdictTone(v);
  const dec = res.decimals;
  const isCrypto = res.asset_class === "crypto";
  const planAlert = (p) => {
    const j = Math.min(1, (p.tps || []).length - 1);
    requestAlert({ symbol, tf, decimals: dec, plan: { side: p.side, entry: p.entry, sl: p.sl, tp: (p.tps || [])[j] } });
  };
  const model = res.model || {};
  return (
    <div className="stack ap" style={{ gap: 12 }}>
      {stale ? (
        <button className="badge brand" onClick={onAnalyse} style={{ height: 30, cursor: "pointer", justifyContent: "center" }}>
          <Icon name="refresh" size={14} /> New candle closed — re-analyse
        </button>
      ) : null}
      <div className={`verdict ${tone}`} data-tour="verdict">
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div className="grow">
            <div className="faint" style={{ fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.08em" }}>
              {res.symbol} · {res.tf} · {fmtPrice(res.price, dec)}
            </div>
            <div className="act" style={{ color: tone === "buy" ? "var(--act-buy)" : tone === "sell" ? "var(--act-sell)" : "var(--act-wait)" }}>{v.action}</div>
          </div>
          <span className={`grade ${gradeClass(v.grade)}`}>{v.grade}</span>
        </div>
        <div style={{ fontSize: "0.88rem", marginTop: 6 }} className="muted">{v.headline}</div>
        {v.news_warning ? (
          <div className="badge down" style={{ marginTop: 10, height: "auto", padding: "7px 10px", whiteSpace: "normal", lineHeight: 1.4 }}>
            <Icon name="alert" size={14} style={{ flex: "none" }} /> {v.news_warning}
          </div>
        ) : null}
        <div className="row" style={{ marginTop: 12, gap: 8 }}>
          <button className="btn sm primary" onClick={() => onAsk(`Explain this ${res.symbol} ${res.tf} analysis to me. Why ${v.action}?`)}>
            <Icon name="sparkles" size={15} /> Ask StreixAI why
          </button>
          <button className="btn sm" onClick={onAnalyse} disabled={busy}><Icon name="refresh" size={15} /> {busy ? "Analysing…" : "Refresh"}</button>
          {onClean ? (
            <button className="btn sm" onClick={onClean} title="Remove this analysis from the chart"><Icon name="trash" size={15} /> Clean analysis</button>
          ) : null}
        </div>
      </div>

      {res.probabilities ? (
        <div data-tour="direction">
          <DirectionBar probs={res.probabilities} decimals={dec} trained={model.trained !== false} />
        </div>
      ) : null}
      <div data-tour="plan">
        <PlanCard p={res.plan} dec={dec} isCrypto={isCrypto} title={v.trade ? "The plan" : "Conditional plan"} onAlert={symbol ? (p) => planAlert(p) : null} onEdit={onEditPlan || null} />
      </div>

      {res.tendencies && res.tendencies.length ? (
        <div className="card" style={{ padding: 14, marginTop: 10 }}>
          <b style={{ fontSize: "0.92rem" }}>Your tendencies</b>
          <div className="hint" style={{ margin: "4px 0 8px" }}>From your own replays, so the plan fits how you trade.</div>
          {res.tendencies.map((t, i) => <div key={i} className="hint" style={{ lineHeight: 1.5, marginTop: i ? 8 : 0 }}>{t}</div>)}
        </div>
      ) : null}
      {res.plan && res.plan.checklist ? (
        <details className="fold" open>
          <summary>Why this grade <span className="faint num">{Number(res.plan.score).toFixed(1)}/10</span></summary>
          <div>
            <ul className="check-list">
              {res.plan.checklist.map((c, i) => (
                <li key={i} className={c.ok ? "ok" : "no"}><span className="ic">{c.ok ? "✓" : "✗"}</span><span>{c.text}</span></li>
              ))}
            </ul>
            {res.plan.why && res.plan.why.length ? (
              <div className="hint" style={{ marginTop: 10 }}>Setup: {res.plan.setup}</div>
            ) : null}
          </div>
        </details>
      ) : null}

      <details className="fold" open={!!(res.news && res.news.risk !== "low")}>
        <summary>News & calendar {res.news ? <span className={`badge ${res.news.risk === "high" ? "down" : res.news.risk === "medium" ? "warn" : "up"}`}>{res.news.risk} risk</span> : null}</summary>
        <div><News news={res.news} /></div>
      </details>

      {res.timeframes && res.timeframes.length ? (
        <details className="fold">
          <summary>Bigger picture</summary>
          <div className="stack" style={{ gap: 8 }}>
            {res.timeframes.map((t) => (
              <div key={t.tf} className="row" style={{ fontSize: "0.86rem", alignItems: "flex-start" }}>
                <span className={`badge ${t.trend > 0 ? "up" : t.trend < 0 ? "down" : ""}`} style={{ minWidth: 42, justifyContent: "center" }}>{t.tf}</span>
                <div className="grow">
                  <b style={{ textTransform: "capitalize" }}>{t.trend_word}</b> <span className="faint">· {t.phase}{t.zone ? ` · ${t.zone}` : ""}</span>
                  {t.p_up !== undefined ? (
                    <div className="faint" style={{ fontSize: "0.76rem" }}>Next 24 candles: ↑ {fmtPct(t.p_up)} · ↓ {fmtPct(t.p_down)} · ↔ {fmtPct(t.p_flat)}</div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {res.levels && res.levels.length ? (
        <details className="fold">
          <summary>Key levels</summary>
          <div style={{ padding: "4px 8px" }}>
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
          </div>
        </details>
      ) : null}

      {res.user_drawings && res.user_drawings.length ? (
        <details className="fold" open>
          <summary>Your levels</summary>
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
        </details>
      ) : null}

      {res.alternative ? (
        <details className="fold">
          <summary>Alternative plan</summary>
          <div><PlanCard p={res.alternative} dec={dec} isCrypto={isCrypto} title="If it goes the other way" dim onAlert={symbol ? (p) => planAlert(p) : null} onEdit={onEditPlan || null} /></div>
        </details>
      ) : null}

      <details className="fold">
        <summary>Chart layers</summary>
        <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted" style={{ fontSize: "0.86rem" }}>Detail</span>
            <div className="seg brand">
              {[[1, "Essentials"], [2, "Normal"], [3, "Everything"]].map(([n, l]) => (
                <button key={n} className={detail === n ? "on" : ""} onClick={() => setDetail(n)}>{l}</button>
              ))}
            </div>
          </div>
          <label className="check"><input type="checkbox" checked={showAlt} onChange={(e) => setShowAlt(e.target.checked)} /> Show the alternative plan</label>
          <div className="grid-2" style={{ gap: 6 }}>
            {layers.map((l) => (
              <label key={l.id} className="check" style={{ fontSize: "0.84rem" }}>
                <input type="checkbox" checked={!hiddenLayers.has(l.id)} onChange={() => toggleLayer(l.id)} /> {LAYERS[l.id] || l.id}
              </label>
            ))}
          </div>
        </div>
      </details>

      <details className="fold">
        <summary>Full report</summary>
        <div><Report res={res} can={can} onUpgrade={onUpgrade} /></div>
      </details>

      <details className="fold">
        <summary>How reliable is this?</summary>
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
                <div className="muted">The odds are calibrated, but testing hasn't proven that following every plan makes money after costs. Use the analysis to structure decisions and manage risk — not as a guarantee.</div>
              ) : <div className="muted">Past test results don't guarantee future results. Keep risk small.</div>}
            </>
          ) : (
            <div className="muted">The probability model isn't trained on this server yet, so the odds are rough estimates. The levels and structure are still computed from the chart.</div>
          )}
          <div className="hint">{res.disclaimer}</div>
          <div className="hint">Data: {res.source} · analysed in {res.seconds}s · {fmtDateTime(res.now)}{user && user.role === "admin" && res.brain_status ? ` · brain: ${res.brain_status}` : ""}</div>
        </div>
      </details>
    </div>
  );
}

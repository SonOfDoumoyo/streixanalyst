"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Brand from "@/components/Brand";
import Icon from "@/components/Icons";
import { useAuth } from "@/components/Providers";
import { Field, Modal, RequireAuth, Spinner } from "@/components/ui";
import { api, get, patch, post, put, qs } from "@/lib/api";
import { fmtDateTime, fmtNaira } from "@/lib/format";

const TABS = [["overview", "Overview", "grid"], ["payments", "Payments", "card"], ["users", "Users", "users"], ["settings", "Prices & accounts", "sliders"],
  ["system", "System & model", "shield"], ["learning", "Learning data", "layers"], ["activity", "Activity", "clock"],
  ["support", "Support inbox", "info"]];
const PAY_TONE = { success: "up", review: "violet", awaiting_transfer: "warn", rejected: "down", failed: "down", pending: "", cancelled: "", expired: "" };

function Overview() {
  const [s, setS] = useState(null);
  useEffect(() => { get("/admin/stats").then(setS).catch(() => {}); }, []);
  if (!s) return <Spinner />;
  const cards = [["Users", s.users], ["New this week", s.new_7d], ["Active today", s.active_24h], ["Revenue (30 days)", fmtNaira(s.revenue_30d)],
    ["Revenue (all time)", fmtNaira(s.revenue_all)], ["Payments to verify", s.pending_reviews], ["Analyses today", s.analyses_today], ["StreixAI messages today", s.ai_messages_today],
    ["Organizations", s.orgs]];
  return (
    <div className="stack">
      <div className="stats">
        {cards.map(([k, v]) => <div key={k} className="card stat"><div className="k">{k}</div><div className="v num">{v}</div></div>)}
      </div>
      <div className="card">
        <b>Users by plan</b>
        <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
          {Object.entries(s.tiers).map(([t, n]) => <span key={t} className="badge" style={{ textTransform: "capitalize" }}>{t}: {n}</span>)}
        </div>
      </div>
    </div>
  );
}

function ProofView({ payment, onClose }) {
  const [url, setUrl] = useState(null);
  const [type, setType] = useState("");
  useEffect(() => {
    let u;
    fetch(`/api/admin/payments/${payment.id}/proof`, { credentials: "include" }).then(async (r) => {
      const b = await r.blob();
      setType(b.type);
      u = URL.createObjectURL(b);
      setUrl(u);
    });
    return () => u && URL.revokeObjectURL(u);
  }, [payment.id]);
  return (
    <Modal open onClose={onClose} title={`Receipt · ${payment.reference}`} wide>
      {!url ? <Spinner /> : type === "application/pdf" ? (
        <iframe title="receipt" src={url} style={{ width: "100%", height: "70vh", border: 0, borderRadius: 10 }} />
      ) : <img src={url} alt="Payment receipt" style={{ maxWidth: "100%", borderRadius: 10, margin: "0 auto" }} />}
    </Modal>
  );
}

function Payments({ toast }) {
  const [status, setStatus] = useState("review");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState(null);
  const [proof, setProof] = useState(null);
  const [decide, setDecide] = useState(null);
  const load = useCallback(() => {
    setRows(null);
    get(`/admin/payments?${qs({ status, q })}`).then((d) => setRows(d.payments)).catch((e) => toast(e.message, "error"));
  }, [status, q, toast]);
  useEffect(() => { load(); }, [load]);
  const act = async (kind) => {
    try {
      const body = { note: decide.note || null };
      if (kind === "approve") Object.assign(body, { plan: decide.plan, months: Number(decide.months), seats: Number(decide.seats), paid_naira: decide.paid ? Number(decide.paid) : null });
      await post(`/admin/payments/${decide.p.id}/${kind}`, body);
      toast(kind === "approve" ? "Approved — the plan is now active." : "Rejected — the user was told.", "success");
      setDecide(null);
      load();
    } catch (e) { toast(e.message, "error"); }
  };
  const recheck = async (p) => {
    try {
      const d = await post(`/admin/payments/${p.id}/recheck`);
      toast(d.result.ok ? "Verified and applied." : `Not verified: ${d.result.message || d.result.status}`, d.result.ok ? "success" : "info");
      load();
    } catch (e) { toast(e.message, "error"); }
  };
  return (
    <div className="stack">
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="seg">
          {[["review", "To verify"], ["awaiting_transfer", "Awaiting transfer"], ["success", "Paid"], ["rejected", "Rejected"], ["", "All"]].map(([s, l]) => (
            <button key={s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>{l}</button>
          ))}
        </div>
        <input className="input sm" style={{ maxWidth: 260 }} placeholder="Search reference or email" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!rows ? <Spinner /> : !rows.length ? <div className="hint">Nothing here.</div> : (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>When</th><th>User</th><th>Reference</th><th>Plan</th><th>Method</th><th>Amount</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDateTime(p.created_at)}</td>
                  <td><b>{p.user && p.user.name}</b><div className="faint">{p.user && p.user.email}</div></td>
                  <td className="num">{p.reference}{p.payer_name ? <div className="faint">from {p.payer_name}</div> : null}</td>
                  <td>{p.plan === "org" ? "Organization" : "Pro"} · {p.months} mo</td>
                  <td>{p.provider}{p.account_label ? <div className="faint">{p.account_label}</div> : null}</td>
                  <td className="num">{fmtNaira(p.amount)}{p.paid !== null && p.paid !== p.amount ? <div className="faint">paid {fmtNaira(p.paid)}</div> : null}</td>
                  <td><span className={`badge ${PAY_TONE[p.status] || ""}`}>{p.status}</span>{p.note ? <div className="hint" style={{ maxWidth: 220 }}>{p.note}</div> : null}</td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      {p.has_proof ? <button className="btn sm" onClick={() => setProof(p)}><Icon name="eye" size={14} /> Receipt</button> : null}
                      {!p.applied && ["paystack", "opay"].includes(p.provider) ? <button className="btn sm" onClick={() => recheck(p)}>Re-check</button> : null}
                      {!p.applied && !["cancelled", "expired"].includes(p.status) ? (
                        <button className="btn sm primary" onClick={() => setDecide({ p, plan: p.plan, months: p.months, seats: p.seats, paid: p.paid || p.amount, note: "" })}>Decide</button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint">Only approve a direct transfer after you have seen the money arrive in the OPay / UBA account. Card, USSD and OPay checkout payments verify themselves.</div>
      {proof ? <ProofView payment={proof} onClose={() => setProof(null)} /> : null}
      <Modal open={!!decide} onClose={() => setDecide(null)} title="Verify payment" subtitle={decide ? `${decide.p.reference} · ${decide.p.user && decide.p.user.email}` : ""}>
        {decide ? (
          <div className="stack">
            <div className="grid-2">
              <Field label="Plan"><select className="select" value={decide.plan} onChange={(e) => setDecide({ ...decide, plan: e.target.value })}><option value="pro">Pro</option><option value="org">Organization</option></select></Field>
              <Field label="Months"><select className="select" value={decide.months} onChange={(e) => setDecide({ ...decide, months: e.target.value })}>{[1, 3, 6, 12].map((m) => <option key={m} value={m}>{m}</option>)}</select></Field>
            </div>
            <div className="grid-2">
              {decide.plan === "org" ? <Field label="Member cap (leave as is for the flat plan)"><input className="input" type="number" min="1" value={decide.seats} onChange={(e) => setDecide({ ...decide, seats: e.target.value })} /></Field> : null}
              <Field label="Amount received (₦)"><input className="input" type="number" value={decide.paid} onChange={(e) => setDecide({ ...decide, paid: e.target.value })} /></Field>
            </div>
            <Field label="Note (shown to the user if rejected)"><input className="input" value={decide.note} onChange={(e) => setDecide({ ...decide, note: e.target.value })} placeholder="e.g. Seen in UBA app 14:05" /></Field>
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button className="btn danger" onClick={() => act("reject")}>Reject</button>
              <button className="btn success" onClick={() => act("approve")}><Icon name="check" size={16} /> Money received — approve</button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function Users({ toast, me }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState(null);
  const load = useCallback(() => get(`/admin/users?${qs({ q, page })}`).then(setD).catch((e) => toast(e.message, "error")), [q, page, toast]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  const upd = async (u, body, msg) => {
    try { await patch(`/admin/users/${u.id}`, body); toast(msg, "success"); load(); } catch (e) { toast(e.message, "error"); }
  };
  const resetPw = async (u) => {
    if (!window.confirm(`Reset the password for ${u.email}?`)) return;
    try {
      const r = await post(`/admin/users/${u.id}/password`);
      window.prompt("Temporary password (copy it now, it won't be shown again):", r.temporary_password);
    } catch (e) { toast(e.message, "error"); }
  };
  return (
    <div className="stack">
      <input className="input" placeholder="Search name or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ maxWidth: 360 }} />
      {!d ? <Spinner /> : (
        <>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>User</th><th>Plan</th><th>Joined</th><th>Last seen</th><th>Actions</th></tr></thead>
              <tbody>
                {d.users.map((u) => (
                  <tr key={u.id}>
                    <td><b>{u.name}</b> {u.role === "admin" ? <span className="badge brand">admin</span> : null} {!u.is_active ? <span className="badge down">disabled</span> : null}
                      <div className="faint">{u.email}{u.phone ? ` · ${u.phone}` : ""} · {u.experience || "—"}</div></td>
                    <td><span className="badge" style={{ textTransform: "capitalize" }}>{u.tier}</span>
                      <div className="faint">{u.tier === "pro" ? `until ${fmtDateTime(u.plan_expires_at)}` : u.tier === "trial" ? `trial ends ${fmtDateTime(u.trial_ends_at)}` : u.org ? u.org : ""}</div></td>
                    <td>{fmtDateTime(u.created_at)}</td>
                    <td>{u.last_seen_at ? fmtDateTime(u.last_seen_at) : "—"}</td>
                    <td>
                      <div className="row wrap" style={{ gap: 6 }}>
                        <button className="btn sm" onClick={() => upd(u, { pro_days: 30 }, "Added 30 Pro days")}>+30d Pro</button>
                        <button className="btn sm" onClick={() => upd(u, { trial_days: 7 }, "Added 7 trial days")}>+7d trial</button>
                        <button className="btn sm ghost" onClick={() => resetPw(u)}>Reset password</button>
                        {u.id !== me.id ? (
                          <>
                            <button className="btn sm ghost" onClick={() => upd(u, { is_active: !u.is_active }, u.is_active ? "User disabled" : "User enabled")}>{u.is_active ? "Disable" : "Enable"}</button>
                            <button className="btn sm ghost" onClick={() => window.confirm(`Change ${u.email}'s role?`) && upd(u, { role: u.role === "admin" ? "user" : "admin" }, "Role changed")}>{u.role === "admin" ? "Remove admin" : "Make admin"}</button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="faint">{d.total} users</span>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <button className="btn sm" disabled={page * 50 >= d.total} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Settings({ toast }) {
  const [s, setS] = useState(null);
  useEffect(() => { get("/admin/settings").then(setS).catch((e) => toast(e.message, "error")); }, [toast]);
  if (!s) return <Spinner />;
  const P = s.pricing;
  const setP = (k, v) => setS({ ...s, pricing: { ...P, [k]: v } });
  const setDisc = (m, v) => setS({ ...s, pricing: { ...P, discounts: { ...P.discounts, [m]: v } } });
  const setLim = (tier, k, v) => setS({ ...s, limits: { ...s.limits, [tier]: { ...s.limits[tier], [k]: v } } });
  const setAcct = (i, k, v) => setS({ ...s, manual_accounts: s.manual_accounts.map((a, j) => (j === i ? { ...a, [k]: v } : a)) });
  const save = async () => {
    try {
      const d = await put("/admin/settings", { pricing: P, limits: s.limits, manual_accounts: s.manual_accounts, announcement: s.announcement || "" });
      setS(d);
      toast("Saved", "success");
    } catch (e) { toast(e.message, "error"); }
  };
  return (
    <div className="stack">
      <div className="card stack">
        <b>Prices (US $) and the naira rate</b>
        <div className="grid-2">
          <Field label="Pro per month ($)"><input className="input num" type="number" value={P.pro_monthly} onChange={(e) => setP("pro_monthly", e.target.value)} /></Field>
          <Field label="Organization per month, flat ($)"><input className="input num" type="number" value={P.org_monthly} onChange={(e) => setP("org_monthly", e.target.value)} /></Field>
          <Field label="₦ per $1 (naira charge = dollars × this)"><input className="input num" type="number" value={P.usd_rate} onChange={(e) => setP("usd_rate", e.target.value)} /></Field>
          <Field label="3-month discount (0–0.9)"><input className="input num" type="number" step="0.01" value={P.discounts["3"]} onChange={(e) => setDisc("3", e.target.value)} /></Field>
          <Field label="12-month discount (0–0.9)"><input className="input num" type="number" step="0.01" value={P.discounts["12"]} onChange={(e) => setDisc("12", e.target.value)} /></Field>
        </div>
      </div>
      <div className="card stack">
        <b>Accounts for direct transfers</b>
        <div className="hint">Shown to users who pay by transfer. They upload a receipt and you approve it in Payments.</div>
        {s.manual_accounts.map((a, i) => (
          <div key={i} className="row wrap" style={{ gap: 8 }}>
            <input className="input sm" style={{ maxWidth: 120 }} placeholder="Bank" value={a.bank} onChange={(e) => setAcct(i, "bank", e.target.value)} />
            <input className="input sm num" style={{ maxWidth: 160 }} placeholder="Account number" value={a.number} onChange={(e) => setAcct(i, "number", e.target.value)} />
            <input className="input sm grow" placeholder="Account name" value={a.name} onChange={(e) => setAcct(i, "name", e.target.value)} />
            <button className="icon-btn" onClick={() => setS({ ...s, manual_accounts: s.manual_accounts.filter((_, j) => j !== i) })} aria-label="Remove"><Icon name="trash" size={16} /></button>
          </div>
        ))}
        <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setS({ ...s, manual_accounts: [...s.manual_accounts, { bank: "", number: "", name: "" }] })}><Icon name="plus" size={14} /> Add account</button>
      </div>
      <div className="card stack">
        <b>Daily limits per plan</b>
        <div className="table-wrap">
          <table className="t" style={{ minWidth: 560 }}>
            <thead><tr><th>Limit</th>{Object.keys(s.limits).map((t) => <th key={t} style={{ textTransform: "capitalize" }}>{t}</th>)}</tr></thead>
            <tbody>
              {Object.keys(s.default_limits.free).map((k) => (
                <tr key={k}><td>{k}</td>{Object.keys(s.limits).map((t) => (
                  <td key={t}><input className="input sm num" style={{ width: 80 }} type="number" min="0" value={s.limits[t][k]} onChange={(e) => setLim(t, k, e.target.value)} /></td>
                ))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card stack">
        <b>Announcement banner</b>
        <input className="input" maxLength={400} placeholder="e.g. New: OPay payments are live!" value={s.announcement || ""} onChange={(e) => setS({ ...s, announcement: e.target.value })} />
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary lg" onClick={save}>Save all</button></div>
    </div>
  );
}

function System({ toast }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => get("/admin/system").then(setS).catch((e) => toast(e.message, "error")), [toast]);
  useEffect(() => { load(); }, [load]);
  if (!s) return <Spinner />;
  const b = s.engine.brain;
  const det = typeof b.detail === "object" && b.detail ? b.detail : null;
  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      await api("/admin/brain/upload", { method: "POST", form: fd });
      toast("Model uploaded and loaded.", "success");
      load();
    } catch (e) { toast(e.message, "error"); }
    setBusy(false);
  };
  const ok = (v) => <span className={`badge ${v ? "up" : "warn"}`}>{v ? "on" : "off"}</span>;
  return (
    <div className="stack">
      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between" }}><b>Guru model (the brain)</b><span className={`badge ${b.status === "trained" ? "up" : "warn"}`}>{b.status}</span></div>
        {det ? (
          <div className="muted" style={{ fontSize: "0.9rem" }}>
            Trained {det.created} · version {det.version} · {det.rows && det.rows.race ? Number(det.rows.race).toLocaleString() : "?"} rows ·{" "}
            {det.skill && det.skill.edge_proven ? "edge proven in testing" : "no proven edge (honest mode)"}
            {det.warnings && det.warnings.length ? <div className="warn">Warning: {det.warnings.join(" ")}</div> : null}
          </div>
        ) : <div className="muted" style={{ fontSize: "0.9rem" }}>{String(b.detail || "")}</div>}
        <div className="hint">Path on the server: {b.path}. Upload guru_brain.joblib from the notebook's Drive folder (trading_ai/guru), or copy it to that path and press Reload. Only upload files you trained yourself.</div>
        <div className="row wrap" style={{ gap: 8 }}>
          <label className="btn primary" style={{ cursor: busy ? "wait" : "pointer" }}>
            {busy ? <span className="spinner" /> : <Icon name="upload" size={16} />} Upload model
            <input type="file" accept=".joblib" style={{ display: "none" }} onChange={(e) => upload(e.target.files && e.target.files[0])} />
          </label>
          <button className="btn" onClick={async () => { await post("/admin/brain/reload"); load(); toast("Reloaded", "success"); }}><Icon name="refresh" size={16} /> Reload</button>
        </div>
      </div>
      <div className="card stack">
        <b>Services</b>
        <div className="row wrap" style={{ gap: 10, fontSize: "0.9rem" }}>
          <span>StreixAI: <span className="badge brand">{s.ai_provider}</span></span>
          <span>Paystack {ok(s.paystack)}</span><span>Account numbers {ok(s.dedicated_accounts)}</span><span>OPay {ok(s.opay)}</span>
          <span>Email {ok(s.email)}</span><span>Google {ok(s.google)}</span><span>LinkedIn {ok(s.linkedin)}</span>
          <span>Database: {s.database}</span><span>Env: {s.env}</span>
        </div>
      </div>
      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between" }}><b>Market data</b>
          <button className="btn sm" onClick={async () => { await post("/admin/catalog/refresh"); load(); }}><Icon name="refresh" size={14} /> Refresh symbol list</button></div>
        <div className="muted" style={{ fontSize: "0.9rem" }}>{s.catalog.pairs.toLocaleString()} crypto pairs listed{s.catalog.updated ? ` · updated ${fmtDateTime(s.catalog.updated * 1000)}` : ""}</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {Object.entries(s.catalog.sources || {}).map(([k, v]) => <span key={k} className={`badge ${typeof v === "number" ? "up" : "down"}`} title={String(v)}>{k}: {typeof v === "number" ? v : "error"}</span>)}
        </div>
        {Object.keys(s.engine.blocked_sources || {}).length ? (
          <div className="hint">Sources refusing this server: {Object.entries(s.engine.blocked_sources).map(([k, v]) => `${k} (${v})`).join(", ")}. Hosting in Europe avoids Binance/Bybit US blocks.</div>
        ) : null}
      </div>
    </div>
  );
}

function Learning() {
  const [d, setD] = useState(null);
  const [minScore, setMinScore] = useState(70);
  const load = useCallback(() => get("/admin/learning").then(setD).catch(() => setD({ error: true })), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return <Spinner />;
  if (d.error) return <div className="card" style={{ padding: 16 }}>Couldn't load the learning summary.</div>;
  const by = d.calls.by_outcome || {};
  return (
    <div className="stack">
      <div className="card" style={{ padding: 16 }}>
        <b>Verified learning, never blind learning</b>
        <div className="muted" style={{ fontSize: "0.9rem", marginTop: 6 }}>{d.note}</div>
        <ol className="muted" style={{ fontSize: "0.88rem", margin: "10px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
          <li>Download the verified datasets below.</li>
          <li>Retrain in the Colab notebook and read its out-of-sample report.</li>
          <li>Only if the report is better, upload the new brain under <b>System &amp; model</b>.</li>
        </ol>
      </div>
      <div className="stats">
        <div className="card stat"><div className="k">Resolved calls</div><div className="v">{d.calls.resolved}</div>
          <div className="faint" style={{ fontSize: "0.76rem" }}>{by.tp || 0} targets · {by.sl || 0} stops · {by.time || 0} time exits</div></div>
        <div className="card stat"><div className="k">Being tracked</div><div className="v">{(by.open || 0) + (by.pending || 0)}</div>
          <div className="faint" style={{ fontSize: "0.76rem" }}>{by.open || 0} running · {by.pending || 0} waiting to fill</div></div>
        <div className="card stat"><div className="k">Practice analyses</div><div className="v">{d.practice.total}</div>
          <div className="faint" style={{ fontSize: "0.76rem" }}>{d.practice.accurate} scored {d.practice.min_score}+</div></div>
      </div>
      <div className="card stack" style={{ padding: 16, gap: 12 }}>
        <div className="row wrap" style={{ justifyContent: "space-between" }}>
          <div><b>Resolved analyst calls</b><div className="faint" style={{ fontSize: "0.82rem" }}>Each call's full analysis snapshot + its measured result (duplicates removed). JSON Lines.</div></div>
          <a className="btn primary" href="/api/admin/learning/export?dataset=calls" download onClick={() => setTimeout(load, 1500)}><Icon name="download" size={16} /> Download calls</a>
        </div>
        <div className="row wrap" style={{ justifyContent: "space-between", borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <div><b>Accurate user analyses</b><div className="faint" style={{ fontSize: "0.82rem" }}>Draw &amp; score attempts the analyst graded highly: drawings, bias, trade and score.</div></div>
          <div className="row" style={{ gap: 8 }}>
            <label className="row faint" style={{ gap: 6, fontSize: "0.84rem" }}>min score
              <input className="input sm num" style={{ width: 70 }} inputMode="numeric" value={minScore} onChange={(e) => setMinScore(Math.max(0, Math.min(100, parseInt(e.target.value || "0", 10) || 0)))} />
            </label>
            <a className="btn" href={`/api/admin/learning/export?dataset=practice&min_score=${minScore}`} download onClick={() => setTimeout(load, 1500)}><Icon name="download" size={16} /> Download</a>
          </div>
        </div>
        {d.last_export ? <div className="hint">Last export {fmtDateTime(d.last_export.at)} · {d.last_export.detail ? `${d.last_export.detail.rows} rows` : ""}</div> : null}
      </div>
    </div>
  );
}

function Activity() {
  const [a, setA] = useState(null);
  const [an, setAn] = useState(null);
  useEffect(() => {
    get("/admin/actions").then((d) => setA(d.items)).catch(() => setA([]));
    get("/admin/analyses?limit=60").then((d) => setAn(d.items)).catch(() => setAn([]));
  }, []);
  return (
    <div className="stack">
      <div className="section-title">Recent analyses</div>
      {!an ? <Spinner /> : (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>When</th><th>User</th><th>Market</th><th>Verdict</th><th>Grade</th><th>Entry / SL / TP</th></tr></thead>
            <tbody>{an.map((r) => (
              <tr key={r.id}><td>{fmtDateTime(r.created_at)}</td><td>#{r.user_id}</td><td>{r.symbol} · {r.tf}</td><td>{r.action}</td><td>{r.grade}</td>
                <td className="num">{r.entry ? `${r.entry.toPrecision(6)} / ${r.sl ? r.sl.toPrecision(6) : "—"} / ${r.tp ? r.tp.toPrecision(6) : "—"}` : "—"}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="section-title">Admin & payment log</div>
      {!a ? <Spinner /> : (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>When</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
            <tbody>{a.map((r) => (
              <tr key={r.id}><td>{fmtDateTime(r.created_at)}</td><td>{r.action}</td><td className="num">{r.target}</td><td className="faint" style={{ maxWidth: 420, overflowWrap: "anywhere" }}>{r.detail ? JSON.stringify(r.detail) : ""}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Support messages from the Support page. Open ones first. Replying is by email, from the address in each message.
function SupportInbox({ toast }) {
  const [status, setStatus] = useState("open");
  const [d, setD] = useState(null);
  const load = useCallback(() => get(`/admin/support?status=${status}`).then(setD).catch(() => setD({ error: true })), [status]);
  useEffect(() => { load(); }, [load]);
  const flip = async (t) => {
    try {
      await post(`/admin/support/${t.id}/status`, { status: t.status === "open" ? "closed" : "open" });
      load();
    } catch (e) { toast(e.message, "error"); }
  };
  if (!d) return <Spinner />;
  if (d.error) return <div className="card" style={{ padding: 16 }}>Could not load support messages.</div>;
  return (
    <div className="stack">
      <div className="card stack" style={{ padding: 16 }}>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <b>Support messages</b>
          <div className="seg brand">
            <button className={status === "open" ? "on" : ""} onClick={() => setStatus("open")}>Open ({d.open})</button>
            <button className={status === "closed" ? "on" : ""} onClick={() => setStatus("closed")}>Closed</button>
          </div>
        </div>
        {d.tickets.length === 0 ? <div className="muted">Nothing here.</div> : null}
        {d.tickets.map((t) => (
          <div key={t.id} className="card" style={{ padding: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <b>#{t.id} {t.subject}</b>
              <span className="badge">{t.category}</span>
            </div>
            <div className="faint" style={{ fontSize: "0.8rem" }}>
              {fmtDateTime(t.created_at)} · {t.name || "Guest"} · {t.email}{t.user_id ? ` · account ${t.user_id}` : ""}
            </div>
            <p style={{ whiteSpace: "pre-wrap", margin: "8px 0", fontSize: "0.9rem" }}>{t.message}</p>
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <a className="btn sm" href={`mailto:${t.email}?subject=${encodeURIComponent(`Re: ${t.subject}`)}`}>Reply by email</a>
              <button className="btn sm" onClick={() => flip(t)}>{t.status === "open" ? "Mark closed" : "Reopen"}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminInner() {
  const { user, toast } = useAuth();
  const [tab, setTab] = useState("overview");
  return (
    <div className="page page-bg">
      <nav className="nav">
        <Brand />
        <span className="badge brand">Admin</span>
        <div className="grow" />
        <Link className="btn" href="/terminal"><Icon name="candles" size={16} /> Terminal</Link>
      </nav>
      <main className="container" style={{ paddingBottom: 60, maxWidth: 1360 }}>
        <div className="shell">
          <div className="side-nav">
            {TABS.map(([id, l, ic]) => <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}><Icon name={ic} size={17} /> {l}</button>)}
          </div>
          <div style={{ minWidth: 0 }}>
            {tab === "overview" ? <Overview /> : null}
            {tab === "payments" ? <Payments toast={toast} /> : null}
            {tab === "users" ? <Users toast={toast} me={user} /> : null}
            {tab === "settings" ? <Settings toast={toast} /> : null}
            {tab === "system" ? <System toast={toast} /> : null}
            {tab === "learning" ? <Learning /> : null}
            {tab === "activity" ? <Activity /> : null}
            {tab === "support" ? <SupportInbox toast={toast} /> : null}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function AdminPage() {
  return <RequireAuth admin><AdminInner /></RequireAuth>;
}

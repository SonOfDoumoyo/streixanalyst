"use client";
import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icons";

// The full written analysis as a page you can read: the report's steps become numbered sections, bullets become
// rows, the checklist gets ticks and crosses, and "What this means" notes become side notes.

/** The analyst's report text → { title, head: [lines], sections: [{ n, title, items: [{ kind, text }] }] }. */
export function parseReport(text) {
  const out = { title: "", head: [], sections: [] };
  let cur = null;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (line.startsWith("━")) {
      out.title = line.replace(/━/g, "").trim();
      continue;
    }
    const step = line.match(/^STEP\s+(\d+)\s+[—–-]\s+(.*)$/);
    if (step) {
      cur = { n: step[1], title: step[2], items: [] };
      out.sections.push(cur);
      continue;
    }
    if (/^[A-Z][A-Z' &/()-]{3,}$/.test(line.trim())) {
      cur = { n: null, title: line.trim(), items: [] };
      out.sections.push(cur);
      continue;
    }
    if (/^(Notes:|Research tool)/.test(line)) {
      cur = cur && cur.title === "Notes" ? cur : { n: null, title: "Notes", items: [], quiet: true };
      if (!out.sections.includes(cur)) out.sections.push(cur);
      cur.items.push({ kind: "text", text: line.replace(/^Notes:\s*/, "") });
      continue;
    }
    if (!cur) {
      out.head.push(line.trim());
      continue;
    }
    const t = line.trim();
    if (/^[✓✗]/.test(t)) cur.items.push({ kind: t[0] === "✓" ? "ok" : "no", text: t.slice(1).trim() });
    else if (/^\s{2,}•/.test(line)) cur.items.push({ kind: "sub", text: t.replace(/^•\s*/, "") });
    else if (/^•/.test(t)) cur.items.push({ kind: "bullet", text: t.replace(/^•\s*/, "") });
    else if (/^What this means:/.test(t)) cur.items.push({ kind: "note", text: t.replace(/^What this means:\s*/, "") });
    else if (/:$/.test(t) && t.length < 60) cur.items.push({ kind: "label", text: t.replace(/:$/, "") });
    else cur.items.push({ kind: "text", text: t });
  }
  return out;
}

const sentence = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "Label: rest" → a bold label and the rest, for bullets like "Stop loss: 1.0670 (1.6 ATR)". */
function Lead({ text }) {
  const m = text.match(/^([^:]{2,34}):\s+(.*)$/);
  if (!m || /^\d/.test(m[1])) return <span>{text}</span>;
  return <span><b>{m[1]}</b> {m[2]}</span>;
}

export default function FullAnalysis({ open, onClose, res, can, onUpgrade }) {
  const [which, setWhich] = useState(res && res.mode === "beginner" ? "beginner" : "pro");
  useEffect(() => {
    if (!open) return undefined;
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  const text = res ? (which === "beginner" ? res.report_beginner : res.report_pro) : null;
  const doc = useMemo(() => parseReport(text), [text]);
  if (!open || !res) return null;
  const verdict = doc.head.find((l) => l.startsWith("VERDICT:"));
  const facts = doc.head.filter((l) => !l.startsWith("VERDICT:"));
  return (
    <div className="fa-wrap" role="dialog" aria-modal="true" aria-label="Full analysis" onClick={onClose}>
      <article className="fa" onClick={(e) => e.stopPropagation()}>
        <header className="fa-top">
          <div className="grow">
            <div className="fa-kicker">Full analysis</div>
            <h2>{res.symbol} · {res.tf}</h2>
            <div className="fa-meta">{doc.title}</div>
          </div>
          <div className="seg brand fa-seg">
            <button className={which === "beginner" ? "on" : ""} onClick={() => setWhich("beginner")}>Simple</button>
            <button className={which === "pro" ? "on" : ""} onClick={() => setWhich("pro")}>Pro</button>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        {!text ? (
          <div className="fa-body">
            <div className="paywall">
              <b>The {which === "pro" ? "pro" : "simple"} report is part of Pro</b>
              <div className="muted" style={{ fontSize: "0.88rem", margin: "4px 0 10px" }}>On the free plan you get the report for your own level. Pro shows both, plus the model statistics.</div>
              {can && can("pro_report") ? null : <button className="btn sm primary" onClick={onUpgrade}>See plans</button>}
            </div>
          </div>
        ) : (
          <div className="fa-body">
            {verdict ? (
              <section className="fa-verdict">
                <p>{verdict.replace(/^VERDICT:\s*/, "")}</p>
                {facts.map((l, i) => <div key={i} className="fa-fact num">{l}</div>)}
              </section>
            ) : null}
            <nav className="fa-toc" aria-label="Sections">
              {doc.sections.filter((s) => !s.quiet).map((s, i) => (
                <a key={i} href={`#fa-${i}`} onClick={(e) => { e.preventDefault(); const el = document.getElementById(`fa-${i}`); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
                  {s.n ? <i>{s.n}</i> : null}{sentence(s.title.toLowerCase())}
                </a>
              ))}
            </nav>
            {doc.sections.map((s, i) => (
              <section key={i} id={`fa-${i}`} className={`fa-sec${s.quiet ? " quiet" : ""}`}>
                <h3>{s.n ? <i>{s.n}</i> : null}{sentence(s.title.toLowerCase())}</h3>
                <div className="fa-items">
                  {s.items.map((it, k) => {
                    if (it.kind === "ok" || it.kind === "no") {
                      return <div key={k} className={`fa-check ${it.kind}`}><span>{it.kind === "ok" ? "✓" : "×"}</span>{sentence(it.text)}</div>;
                    }
                    if (it.kind === "note") return <aside key={k} className="fa-note"><b>What this means</b> {it.text}</aside>;
                    if (it.kind === "label") return <div key={k} className="fa-label">{it.text}</div>;
                    if (it.kind === "sub") return <div key={k} className="fa-row sub num"><Lead text={it.text} /></div>;
                    if (it.kind === "bullet") return <div key={k} className="fa-row num"><Lead text={it.text} /></div>;
                    return <p key={k} className="fa-p">{it.text}</p>;
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}

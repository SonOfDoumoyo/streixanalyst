"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fmtPrice } from "@/lib/format";

// The analyst's reasons on the chart: glass panels that appear over the chart after Analyse. Every reason the chart
// can show is a numbered flag pinned to its price and candle (liquidity not swept, structure not shifted, news on the
// clock...), with the verdict, the checks and the scenario that would turn the idea into a trade. It follows the
// chart's own coordinates on every frame, so it stays on its levels however the chart is zoomed or scrolled.

const CONF = { low: "Low confidence", moderate: "Moderate confidence", good: "Good confidence" };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** The HUD block of an analysis. Analyses saved before the HUD existed get one from the verdict and the checklist. */
export function hudOf(res) {
  if (!res) return null;
  if (res.hud && !res.hud.error && Array.isArray(res.hud.flags)) return res.hud;
  const v = res.verdict || {};
  const p = res.plan;
  const checks = (p && Array.isArray(p.checklist) ? p.checklist : []).map((c) => ({ ok: !!c.ok, text: c.text, key: c.key || null }));
  const state = !p ? "dont" : v.trade ? "go" : "best";
  const word = p && p.side === "short" ? "sell" : "buy";
  const flags = [];
  const ev = ((res.news && res.news.events) || []).find((e) => String(e.impact || "").toLowerCase() === "high"
    && Number.isFinite(e.minutes_until) && e.minutes_until >= -30 && e.minutes_until <= 240);
  if (ev) {
    const t = Math.round(Date.parse(ev.time) / 1000);
    const name = `${ev.country || ""} ${ev.title || "News"}`.trim();
    if (Number.isFinite(t)) {
      flags.push({ n: 1, key: "news", tone: "bad", kind: "time", t, title: `${name} in ${ev.minutes_until} min`, short: `${name} in ${ev.minutes_until} min`,
        text: "High-impact release. Spreads widen and stops slip around it: don't enter before it." });
      checks.unshift({ ok: false, text: `High-impact news: ${name}`, key: "news" });
    }
  }
  const last = res.candles && res.candles.length ? res.candles[res.candles.length - 1][0] : null;
  return {
    state, legacy: true, confidence: v.confidence ? v.confidence.level : null, tf: res.tf, trend: [], flags, checks, steps: [], path: null,
    title: state === "go" ? `Possible ${word}` : state === "best" ? "Best entry" : "Don't trade",
    sub: p ? (p.type === "market" ? `${word[0].toUpperCase()}${word.slice(1)} now, at market` : `${word[0].toUpperCase()}${word.slice(1)} ${p.type} at ${fmtPrice(p.entry, res.decimals)}`)
      : "No setup worth taking",
    met: checks.filter((c) => c.ok).length, total: checks.length, summary: v.headline || "",
    entry: p ? { side: p.side, type: p.type, entry: p.entry, sl: p.sl, tps: (p.tps || []).slice(0, 2), active: state === "go", label: state === "go" ? `${word[0].toUpperCase()}${word.slice(1)} ${p.type}` : `Best entry · grade ${v.grade || p.grade}` } : null,
    last_t: last, step: (res.meta && res.meta.tf_seconds) || 3600,
  };
}

/** Re-render when the chart's view changes (pan, zoom, resize, new candles), not on every crosshair move. */
function useView(eng, on) {
  const [v, setV] = useState(null);
  useEffect(() => {
    if (!eng || !on) return undefined;
    let last = "";
    return eng.onFrame((e) => {
      if (!e.d.length) return;
      const key = [e.W, e.H, e.plotW, e.mainH, e.right, e.spacing, e.pmin, e.pmax, e.opts.logScale, e.d.length].join("|");
      if (key === last) return;
      last = key;
      setV({ key, W: e.W, H: e.H, plotW: e.plotW, mainH: e.mainH, axisW: e.axisW });
    });
  }, [eng, on]);
  return on ? v : null;
}

// the chart's time axis is in UTC, so the flags are too
const hhmm = (t) => {
  const d = new Date(t * 1000);
  return Number.isFinite(d.getTime()) ? `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` : "";
};
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lines = (text, w, px = 6.3) => Math.max(1, Math.ceil(String(text || "").length / Math.max(8, (w - 22) / px)));
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** The first spot near an anchor where a card fits without covering another panel (the least overlap if none does). */
function place(cands, w, h, box, obstacles) {
  let best = null;
  let bestCost = Infinity;
  for (const [x0, y0] of cands) {
    const r = { x: clamp(x0, box.x0, box.x1 - w), y: clamp(y0, box.y0, box.y1 - h), w, h };
    let cost = (Math.abs(r.x - x0) + Math.abs(r.y - y0)) * 0.5;
    for (const o of obstacles) cost += overlap(r, o) * 3;
    if (cost < bestCost) {
      best = r;
      bestCost = cost;
      if (cost === 0) break;
    }
  }
  return best;
}

/** The point on a card's edge nearest the anchor, for the leader line. */
const edgePoint = (r, ax, ay) => [clamp(ax, r.x, r.x + r.w), clamp(ay, r.y, r.y + r.h)];

function Ring({ met, total, size = 74 }) {
  const deg = total ? Math.round((met / total) * 360) : 0;
  return (
    <div className="hud-ring" style={{ width: size, height: size, "--deg": `${deg}deg` }} aria-label={`${met} of ${total} checks pass`}>
      <div><b>{total ? `${met}/${total}` : "–"}</b>{size >= 60 ? <span>checks</span> : null}</div>
    </div>
  );
}

/** "(1)" in a sentence becomes the numbered badge of that flag. */
function Numbered({ text, tones }) {
  const parts = String(text || "").split(/\((\d)\)/);
  return parts.map((s, i) => (i % 2 ? <i key={i} className={`hud-n ${tones[s] || "wait"}`}>{s}</i> : <span key={i}>{s}</span>));
}

export default function ChartHud({ eng, res, mobile, dec = 2, showLevels = true, stale = false, bottomInset = 28, onHide, onOpen, onAnalyse, onAlert }) {
  const hud = useMemo(() => hudOf(res), [res]);
  const view = useView(eng, !!hud);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [whyOpen, setWhyOpen] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [focus, setFocus] = useState(null);
  const [intro, setIntro] = useState(false);
  const [sizes, setSizes] = useState({});
  const rootRef = useRef(null);

  useEffect(() => {
    if (!hud) return undefined;
    setIntro(true);
    setSheetOpen(false);
    setWhyOpen(null);
    setFocus(null);
    setSizes({});
    const t = setTimeout(() => setIntro(false), 2400);
    return () => clearTimeout(t);
  }, [hud]);

  // measured card heights feed the next layout pass, so cards never sit on top of each other
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const next = {};
    let changed = false;
    el.querySelectorAll("[data-hid]").forEach((n) => {
      const id = n.getAttribute("data-hid");
      const h = Math.round(n.offsetHeight);
      next[id] = h;
      if (Math.abs((sizes[id] || 0) - h) > 3) changed = true;
    });
    if (changed) setSizes((s) => ({ ...s, ...next }));
  });

  const layout = useMemo(() => {
    if (!hud || !view || !eng || !eng.d.length) return null;
    const W = view.plotW;
    const H = view.mainH;
    const step = hud.step || eng.tfSec || 3600;
    const lastT = hud.last_t || eng.indexToTime(eng.d.length - 1);
    const X = (t) => eng.tx(t);
    const Y = (p) => eng.y(p);
    const box = { x0: 8, x1: W - 8, y0: 8, y1: H - 8 };
    const obstacles = [];
    const sz = (id, est) => sizes[id] || est;
    const out = { W, H, cards: [], chips: [], anchors: [], timeLines: [], axisTags: [], zones: [], leaders: [], marks: [], path: null, entryTag: null };
    const tones = {};
    for (const f of hud.flags || []) if (f.n) tones[f.n] = f.tone;
    out.tones = tones;

    // fixed panels first: the scan card / pill, the reasons panel, the phone sheet, the chart's own buttons
    if (mobile) {
      const pw = Math.min(W - 16, 70 + (hud.title.length + String(hud.met).length * 2) * 7.2 + 64);
      out.scan = { x: 8, y: 56, w: pw, h: 30 };
      obstacles.push({ x: 0, y: 0, w: Math.min(W, 250), h: 52 }, out.scan, { x: view.W - 104, y: 6, w: 48, h: 48 });
      const sh = sz(`sheet${sheetOpen ? "o" : ""}`, sheetOpen ? 214 : 64);
      out.sheet = { x: 8, y: view.H - bottomInset - sh, w: view.W - 16, h: sh };
      obstacles.push(out.sheet);
    } else {
      const sw = 304;
      const sumLines = lines(hud.summary, sw, 6.6);
      out.scan = { x: 12, y: 62, w: sw, h: sz("scan", 112 + Math.min(4, sumLines) * 18 + (hud.note ? 40 : 0)) };
      obstacles.push({ x: 0, y: 0, w: Math.min(W, 340), h: 58 }, out.scan, { x: view.W - 270, y: 6, w: 200, h: 40 });
      const dockX0 = view.W / 2 - 250;
      const whyW = 352;
      const open = !!whyOpen;
      const whyBottom = dockX0 > 12 + whyW + 8 ? H - 12 : Math.min(H - 12, view.H - 96);
      const wh = sz("why", open ? 48 + Math.min(10, (hud.checks || []).length) * 24 : 40);
      const wy = Math.max(out.scan.y + out.scan.h + 12, whyBottom - wh);
      out.why = wy + 40 > whyBottom + 1 ? null : { x: 12, y: wy, w: whyW, h: Math.min(wh, whyBottom - wy), max: whyBottom - wy, open };
      if (out.why) obstacles.push(out.why);
      obstacles.push({ x: dockX0, y: view.H - 84, w: 500, h: 50 });
    }

    // chips: flags that belong to no level (a bigger timeframe against the idea, structure with no swing to break)
    let cx = mobile ? 8 : out.scan.x + out.scan.w + 12;
    let cy = mobile ? 92 : 62;
    for (const f of (hud.flags || []).filter((x) => x.kind === "chip" && x.n)) {
      const text = mobile ? f.short || f.title : f.title;
      const w = Math.min(W - 16, 46 + text.length * 6.6 + (f.rows && !mobile ? f.rows.length * 40 : 0));
      if (cx + w > W - 8) {
        cx = mobile ? 8 : out.scan.x + out.scan.w + 12;
        cy += 36;
      }
      const r = { x: cx, y: cy, w, h: 30 };
      out.chips.push({ f, r, text });
      obstacles.push(r);
      cx += w + 8;
    }

    // anchors: where each flag sits on the chart
    const anchored = (hud.flags || []).filter((f) => f.kind !== "chip");
    for (const f of anchored) {
      let ax;
      let ay;
      let off = 0;
      if (f.kind === "time") {
        if (!Number.isFinite(f.t)) continue;
        ax = X(f.t);
        if (ax < -2 || ax > W + 2) {
          off = ax < 0 ? -1 : 1;
          ax = clamp(ax, 10, W - 10);
        }
        const near = out.timeLines.filter((q) => Math.abs(q.x - ax) < (mobile ? 74 : 90)).length;
        ay = (mobile ? 132 : 112) + near * 28;
        out.timeLines.push({ f, x: ax, off, dy: near * 28 });
      } else {
        if (!Number.isFinite(f.price)) continue;
        ay = Y(f.price);
        ax = Number.isFinite(f.t) ? X(f.t) : X(lastT + 2 * step);
        if (ay < 6 || ay > H - 6) off = ay < 6 ? -1 : 1;
        ay = clamp(ay, 12, H - 12);
        ax = clamp(ax, 14, W - 14);
        if (f.zone && !off) out.zones.push({ f, x: ax, y1: Y(f.zone[1]), y2: Y(f.zone[0]) });
        if (f.n && !off && f.tone !== "info") out.axisTags.push({ f, y: Y(f.price) });
      }
      out.anchors.push({ f, x: ax, y: ay, off });
      obstacles.push({ x: ax - 18, y: ay - 18, w: 36, h: 36 });
    }

    // the scenario path and the entry tag
    if (showLevels && Array.isArray(hud.path) && hud.path.length > 1) {
      const pts = hud.path.map((q) => ({ x: X(q.t), y: Y(q.p), mark: q.mark }));
      out.path = pts;
      for (const q of pts) if (q.mark !== null && q.mark !== undefined && !String(q.mark).startsWith("tp")) out.marks.push(q);
    }
    // a live plan already carries its EP / SL / TP labels; the tag is for a plan that waits on the flags
    if (showLevels && hud.entry && !hud.entry.active && Number.isFinite(hud.entry.entry)) {
      const ey = Y(hud.entry.entry);
      if (ey > 8 && ey < H - 8) {
        const label = mobile ? hud.entry.label.replace(" · only after ", " after ") : hud.entry.label;
        const tw = Math.min(mobile ? 190 : 240, 26 + label.length * 6.6);
        const ex = clamp(X(lastT + 11 * step) + 6, 8, W - tw - 6);
        out.entryTag = { x: ex, y: ey - 12, w: tw, h: 24, label, active: hud.entry.active, side: hud.entry.side };
        obstacles.push(out.entryTag);
      }
    }

    // the cards, placed one by one around their anchors
    const cw = mobile ? 178 : 268;
    for (const a of out.anchors) {
      const f = a.f;
      if (f.tone === "good") {
        if (mobile) continue;
        const w = Math.min(mobile ? 150 : 210, 34 + (f.short || f.title).length * 6.4);
        const r = place([[a.x + 16, a.y - 30], [a.x - w - 16, a.y - 30], [a.x + 16, a.y + 8], [a.x - w - 16, a.y + 8]], w, 24, box, obstacles);
        out.cards.push({ a, r, good: true });
        obstacles.push(r);
        continue;
      }
      const id = `f${f.n}`;
      // a one-line pill until it's opened (tap / click), so the chart stays readable
      const open = focus === f.n;
      const w = open ? cw : Math.min(mobile ? 178 : 290, 46 + f.title.length * (mobile ? 6.6 : 7));
      const est = open ? (mobile ? 50 + lines(f.text, cw, 6) * 15 : 34 + lines(f.text, cw, 6.2) * 17) : (mobile ? 16 + lines(f.title, w, 6.6) * 16 : 30);
      const h = sz(`${id}${open ? "o" : ""}`, est);
      const g = mobile ? 22 : 34;
      const c = a.f.kind === "time"
        ? [0, 1, 2, 3, 4, 5].flatMap((k) => [[a.x - w - 14, a.y + k * 64], [a.x + 14, a.y + k * 64]])
        : [[a.x - w - g, a.y - h - 12], [a.x + g, a.y - h - 12], [a.x - w - g, a.y + 12], [a.x + g, a.y + 12],
          [a.x - w / 2, a.y - h - 44], [a.x - w / 2, a.y + 44], [a.x - w - 2.6 * g, a.y - h - 64], [a.x + 2.6 * g, a.y - h - 64],
          [a.x - w - 2.6 * g, a.y + 64], [a.x + 2.6 * g, a.y + 64], [a.x - w - g, a.y - h / 2], [a.x + g, a.y - h / 2]];
      const r = place(c, w, h, box, obstacles);
      out.cards.push({ a, r, id: `${id}${open ? "o" : ""}`, open });
      obstacles.push(r);
      const [lx, ly] = edgePoint(r, a.x, a.y);
      const dx = a.x - lx;
      const dy = a.y - ly;
      const dist = Math.hypot(dx, dy);
      if (dist > 16) out.leaders.push({ x1: lx, y1: ly, x2: a.x - (dx / dist) * 13, y2: a.y - (dy / dist) * 13, tone: f.tone });
    }
    return out;
  }, [hud, view, eng, mobile, showLevels, sizes, sheetOpen, whyOpen, focus, bottomInset]);

  if (!hud || !layout) return null;
  const L = layout;
  const { W, H } = L;
  const flags = hud.flags || [];
  const numbered = flags.filter((f) => f.n);
  const checks = [...(hud.checks || [])];
  const nOf = (key) => (flags.find((f) => f.key === key && f.n) || {}).n;
  const failing = checks.filter((c) => !c.ok).sort((a, b) => (nOf(a.key) || 99) - (nOf(b.key) || 99));
  const passing = checks.filter((c) => c.ok);
  const firstLevel = numbered.find((f) => f.need && Number.isFinite(f.price)) || numbered.find((f) => Number.isFinite(f.price) && f.kind === "level");
  const alertOf = (f) => {
    if (!f || !onAlert) return;
    const above = res && Number.isFinite(res.price) ? f.price > res.price : true;
    onAlert({ price: f.price, op: above ? "above" : "below", note: f.title });
  };
  const stateWord = hud.state === "go" || hud.state === "best" ? (hud.entry && hud.entry.side === "short" ? "sell" : "buy") : hud.state;
  const pathD = L.path ? L.path.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ") : null;
  const tail = L.path && L.path.length > 1 ? (() => {
    const a = L.path[L.path.length - 2];
    const b = L.path[L.path.length - 1];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const s = 8;
    return `M${b.x} ${b.y} L${b.x - s * Math.cos(ang - 0.45)} ${b.y - s * Math.sin(ang - 0.45)} L${b.x - s * Math.cos(ang + 0.45)} ${b.y - s * Math.sin(ang + 0.45)} Z`;
  })() : null;
  let i = 0;
  const seq = () => ({ "--i": i++ });

  return (
    <div ref={rootRef} className={`hud${mobile ? " hud-m" : ""}${intro ? " intro" : ""} st-${hud.state}`} aria-label="The analyst's reasons on the chart">
      <svg className="hud-svg" width={W} height={H} aria-hidden="true">
        <defs>
          <pattern id={`hatch${uid}`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="7" className="hud-hatch" strokeWidth="2" />
          </pattern>
        </defs>
        <path className="hud-frame" d={`M8 26V8h18 M${W - 26} 8h18v18 M8 ${H - 26}v18h18 M${W - 26} ${H - 8}h18v-18`} />
        {L.zones.map((z, k) => (
          <rect key={`z${k}`} x={z.x} y={Math.min(z.y1, z.y2)} width={Math.max(0, W - z.x)} height={Math.max(2, Math.abs(z.y2 - z.y1))} fill={`url(#hatch${uid})`} className="hud-zone" />
        ))}
        {L.anchors.filter((a) => a.f.kind === "level" && !a.off && a.f.tone !== "good").map((a) => (
          <line key={`l${a.f.key}${a.f.n}`} x1={a.x} y1={a.y} x2={W} y2={a.y} className={`hud-level ${a.f.tone}`} />
        ))}
        {L.timeLines.map((tl) => (
          <line key={`t${tl.f.key}`} x1={tl.x} y1={0} x2={tl.x} y2={H} className={`hud-time ${tl.f.tone}`} />
        ))}
        {pathD ? (
          <g className="hud-path">
            <path d={pathD} />
            {tail ? <path d={tail} className="hud-arrow" /> : null}
            {L.path.slice(1).map((q, k) => (q.mark === "entry"
              ? <circle key={k} cx={q.x} cy={q.y} r="4.5" className="hud-entry-dot" />
              : <circle key={k} cx={q.x} cy={q.y} r={String(q.mark).startsWith("tp") ? 3 : 6} className="hud-pt" />))}
          </g>
        ) : null}
        {L.leaders.map((l, k) => <line key={`ld${k}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className={`hud-leader ${l.tone}`} />)}
        {L.anchors.filter((a) => a.f.tone !== "good" && !(a.f.kind === "time")).map((a) => (
          <g key={`r${a.f.key}${a.f.n}`} className={`hud-ret ${a.f.tone}`} transform={`translate(${a.x} ${a.y})`}>
            <circle r="10" className="r1" />
            <circle r={mobile ? 15 : 18} className="r2" />
            {!mobile ? <circle r="27" className="r3" /> : null}
            <path d={mobile ? "M0 -21v6 M0 15v6 M-21 0h6 M15 0h6" : "M0 -32v8 M0 24v8 M-32 0h8 M24 0h8"} className="r4" />
          </g>
        ))}
        {L.anchors.filter((a) => a.f.tone === "good").map((a) => (
          <g key={`g${a.f.key}`} className="hud-ret good" transform={`translate(${a.x} ${a.y})`}><circle r="7" className="r1" /></g>
        ))}
      </svg>

      {/* numbered badges on the reticles and on the path */}
      {L.anchors.filter((a) => a.f.n && a.f.kind !== "time").map((a) => (
        <i key={`b${a.f.n}`} className={`hud-n at ${a.f.tone}`} style={{ left: a.x + (mobile ? 9 : 12), top: a.y - (mobile ? 25 : 30), ...seq() }}>
          {a.off ? (a.off < 0 ? "↑" : "↓") : null}{a.f.n}
        </i>
      ))}
      {L.timeLines.map((tl) => (
        <div key={`tt${tl.f.key}`} className={`hud-timetag ${tl.f.tone}`} style={{ left: tl.x, top: (mobile ? 98 : 92) + tl.dy, ...seq() }}>
          <i className={`hud-n ${tl.f.tone}`}>{tl.f.n}</i>{tl.off > 0 ? "→ " : tl.off < 0 ? "← " : ""}{hhmm(tl.f.t)}
        </div>
      ))}
      {L.marks.filter((q) => q.mark !== "entry" || (hud.state !== "go" && !L.entryTag)).map((q, k) => (q.mark === "entry"
        ? <span key={`m${k}`} className="hud-entry-word" style={{ left: q.x + 8, top: q.y - 7 }}>Entry</span>
        : <i key={`m${k}`} className={`hud-n path ${L.tones[q.mark] || "wait"}`} style={{ left: q.x - 9, top: q.y - 28 }}>{q.mark}</i>))}

      {/* price-axis tags for the flagged levels */}
      {L.axisTags.filter((t) => t.y > 4 && t.y < H - 4).map((t) => (
        <span key={`ax${t.f.n}`} className={`hud-axtag ${t.f.tone}`} style={{ left: W + 1, top: t.y - 9, width: Math.max(40, (eng ? eng.axisW : 60) - 2) }}>
          {fmtPrice(t.f.price, dec)}
        </span>
      ))}

      {L.entryTag ? (
        <div className={`hud-entrytag${L.entryTag.active ? " on" : ""}`} style={{ left: L.entryTag.x, top: L.entryTag.y, maxWidth: L.entryTag.w, ...seq() }}>
          <Numbered text={L.entryTag.label} tones={L.tones} />
        </div>
      ) : null}

      {/* flag cards */}
      {L.cards.map(({ a, r, good, id, open }) => (good ? (
        <div key={`gc${a.f.key}`} className="hud-card good mini" style={{ left: r.x, top: r.y, ...seq() }} title={a.f.text}>
          <span className="ok">✓</span> {a.f.short || a.f.title}
        </div>
      ) : (
        <div key={`c${a.f.n}`} data-hid={id} className={`hud-card ${a.f.tone}${mobile ? " compact" : ""}${open ? " open" : ""}`}
          style={{ left: r.x, top: r.y, width: r.w, ...seq() }}
          onClick={() => setFocus(focus === a.f.n ? null : a.f.n)} role="button" title={open ? "Close" : "Open this reason"}>
          <div className="hc-head"><i className={`hud-n ${a.f.tone}`}>{a.f.n}</i><b>{a.f.title}</b></div>
          {open ? <div className="hc-text">{a.f.text}</div> : null}
        </div>
      )))}

      {L.chips.map(({ f, r, text }) => (
        <div key={`ch${f.n}`} className={`hud-chip ${f.tone}`} style={{ left: r.x, top: r.y, ...seq() }} title={f.text}>
          <i className={`hud-n ${f.tone}`}>{f.n}</i><b>{text}</b>
          {f.rows && !mobile ? (
            <span className="hc-rows">{f.rows.map((row) => <em key={row.tf} className={row.dir > 0 ? "up" : row.dir < 0 ? "down" : ""}>{row.tf} {row.dir > 0 ? "▲" : row.dir < 0 ? "▼" : "•"}</em>)}</span>
          ) : null}
        </div>
      ))}

      {/* the scan: the verdict and what it waits for */}
      {mobile ? (
        <button className="hud-pill" style={{ left: L.scan.x, top: L.scan.y, ...seq() }} onClick={() => setSheetOpen(!sheetOpen)}>
          <i className="dot" /><span className="lead">Scan</span><b>{hud.title}</b>{hud.total ? <span className="soft">{hud.met} of {hud.total} met</span> : null}
        </button>
      ) : (
        <div className="hud-scan" data-hid="scan" style={{ left: L.scan.x, top: L.scan.y, width: L.scan.w, ...seq() }}>
          <i className="hud-glint" />
          <div className="hs-top">
            <i className="dot" /> Analyst scan · {res.symbol} {hud.tf || res.tf}
            {onHide ? <button className="hs-x" onClick={onHide} aria-label="Hide the reasons on the chart" title="Hide the reasons (the analysis stays)">×</button> : null}
          </div>
          <div className="hs-main">
            <Ring met={hud.met} total={hud.total} size={58} />
            <div className="hs-words">
              <b className={`hs-title ${stateWord}`}>{hud.title}{hud.grade && hud.state !== "dont" ? <i className={`hs-grade g-${String(hud.grade).replace("+", "plus")}`}>{hud.grade}</i> : null}</b>
              <span className="hs-sub">{hud.sub}</span>
              {hud.confidence && CONF[hud.confidence] ? <span className={`hs-conf ${hud.confidence}`}>{CONF[hud.confidence]}</span> : null}
            </div>
          </div>
          {hud.note ? <p className="hs-note">{hud.note}</p> : null}
          <p className="hs-sum" title={hud.summary}><Numbered text={hud.summary} tones={L.tones} /></p>
          {stale && onAnalyse ? <button className="hs-stale" onClick={onAnalyse}>A new candle closed: analyse again</button> : null}
          {hud.legacy && onAnalyse ? <button className="hs-stale" onClick={onAnalyse}>Analyse again to see every reason on the chart</button> : null}
        </div>
      )}

      {/* desktop: every check */}
      {!mobile && L.why ? (
        <div className="hud-why" data-hid="why" style={{ left: L.why.x, top: L.why.y, width: L.why.w, maxHeight: L.why.max, ...seq() }}>
          <button className="hw-head" onClick={() => setWhyOpen(!L.why.open)} aria-expanded={L.why.open}>
            <b>{hud.state === "go" ? "Before you enter" : hud.state === "dont" ? "What the chart shows" : "Why it isn't confirmed"}</b>
            <span>{hud.total ? `${hud.met} of ${hud.total} checks pass` : `${numbered.length} notes`}</span>
            <i className={`chev${L.why.open ? " up" : ""}`}>⌃</i>
          </button>
          {L.why.open ? (
            <ul className="hw-list">
              {(hud.total ? [...failing, ...passing] : numbered.map((f) => ({ ok: false, text: f.title, key: f.key }))).slice(0, 12).map((c, k) => {
                const n = !c.ok ? nOf(c.key) : null;
                return (
                  <li key={k} className={c.ok ? "ok" : "no"}>
                    {c.ok ? <span className="ic ok">✓</span> : n ? <i className={`hud-n ${L.tones[n] || "wait"}`}>{n}</i> : <span className="ic no">×</span>}
                    <span>{cap(c.text)}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* phone: the verdict sheet */}
      {mobile ? (
        <div className={`hud-sheet${sheetOpen ? " open" : ""}`} data-hid="sheet" style={{ left: L.sheet.x, top: L.sheet.y, width: L.sheet.w, ...seq() }}>
          <button className="hsh-grab" onClick={() => setSheetOpen(!sheetOpen)} aria-label={sheetOpen ? "Make smaller" : "Show the reasons"} />
          <div className="hsh-row" onClick={() => setSheetOpen(!sheetOpen)} role="button">
            <Ring met={hud.met} total={hud.total} size={sheetOpen ? 48 : 36} />
            <div className="hs-words">
              <b className={`hs-title ${stateWord}`}>{hud.state === "best" ? `Best entry · ${hud.sub}` : hud.state === "go" ? hud.sub : hud.title}</b>
              <span className="hs-sub num">{hud.entry && showLevels ? `SL ${fmtPrice(hud.entry.sl, dec)} · TP1 ${fmtPrice(hud.entry.tps[0], dec)}${hud.grade ? ` · grade ${hud.grade}` : ""}` : hud.sub}</span>
            </div>
            {hud.confidence && CONF[hud.confidence] ? <span className={`hs-conf ${hud.confidence}`}>{CONF[hud.confidence].replace(" confidence", "")}</span> : null}
          </div>
          {sheetOpen ? (
            <>
              <div className="hsh-grid">
                {numbered.slice(0, 4).map((f) => (
                  <button key={f.n} className={`hsh-item ${f.tone}`} onClick={() => setFocus(focus === f.n ? null : f.n)}>
                    <i className={`hud-n ${f.tone}`}>{f.n}</i><span>{f.title}</span>
                  </button>
                ))}
                {!numbered.length ? <div className="hsh-none">{hud.summary}</div> : null}
              </div>
              <div className="hsh-btns">
                <button className="hsh-b" onClick={onOpen}>All details</button>
                {hud.entry && showLevels && onAlert ? (
                  <button className="hsh-b primary" onClick={() => alertOf({ price: hud.entry.entry, title: `Entry ${fmtPrice(hud.entry.entry, dec)}` })}>Alert me at the entry</button>
                ) : firstLevel && onAlert ? (
                  <button className="hsh-b primary" onClick={() => alertOf(firstLevel)}>Alert me at {fmtPrice(firstLevel.price, dec)}</button>
                ) : onHide ? <button className="hsh-b" onClick={onHide}>Hide reasons</button> : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {intro ? <i className="hud-sweep" style={{ height: H }} /> : null}
    </div>
  );
}


"use client";
// The first-visit tour: how to use the analyst and how to enter a trade from it, in four short chapters. Each step
// points at one part of the screen (an element with data-tour="..."); some steps show a small drawing of the idea.
// The "Analyse" step can run the analysis for the person, so the later steps have something to point at.
// Finishing or skipping saves settings.tourDone. Replay it from Settings.
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/Providers";

/** A liquidity sweep: an obvious low, the stops under it, a wick through it, the close back and the entry after. */
function SweepArt() {
  return (
    <svg viewBox="0 0 300 120" className="tour-art" aria-hidden="true">
      <line x1="8" y1="78" x2="292" y2="78" stroke="#58b8f0" strokeDasharray="4 4" strokeWidth="1.2" />
      <text x="10" y="92" fill="#58b8f0" fontSize="9">stops sit under this low</text>
      {[[30, 40, 70, 46, 62], [52, 52, 76, 58, 72], [74, 50, 80, 66, 79], [96, 60, 78, 70, 74], [118, 44, 79, 68, 50]].map(([x, h, l, o, c], k) => (
        <g key={k}>
          <line x1={x} y1={h} x2={x} y2={l} stroke={c < o ? "#19c98f" : "#f04f6a"} strokeWidth="1.4" />
          <rect x={x - 5} y={Math.min(o, c)} width="10" height={Math.max(2, Math.abs(o - c))} fill={c < o ? "#19c98f" : "#f04f6a"} rx="1" />
        </g>
      ))}
      <line x1="150" y1="56" x2="150" y2="104" stroke="#f04f6a" strokeWidth="1.4" />
      <rect x="145" y="60" width="10" height="12" fill="#f04f6a" rx="1" />
      <line x1="172" y1="50" x2="172" y2="100" stroke="#19c98f" strokeWidth="1.4" />
      <rect x="167" y="54" width="10" height="20" fill="#19c98f" rx="1" />
      <circle cx="161" cy="101" r="9" fill="none" stroke="#e8a33d" strokeWidth="1.4" />
      <text x="128" y="117" fill="#e8a33d" fontSize="9">the sweep</text>
      <line x1="140" y1="110" x2="292" y2="110" stroke="#f04f6a" strokeWidth="1.4" />
      <text x="200" y="106" fill="#f04f6a" fontSize="9">your stop goes past it</text>
      <line x1="186" y1="56" x2="292" y2="56" stroke="#e8a33d" strokeWidth="1.4" />
      <text x="190" y="70" fill="#e8a33d" fontSize="9">enter on the close back</text>
      {[[196, 40, 60, 56, 44], [216, 28, 48, 44, 32], [236, 16, 36, 32, 20]].map(([x, h, l, o, c], k) => (
        <g key={k}>
          <line x1={x} y1={h} x2={x} y2={l} stroke="#19c98f" strokeWidth="1.4" />
          <rect x={x - 5} y={c} width="10" height={o - c} fill="#19c98f" rx="1" />
        </g>
      ))}
    </svg>
  );
}

/** Hold for the crosshair; on the newest candle, "Analyse from here". */
function HoldArt() {
  return (
    <svg viewBox="0 0 300 110" className="tour-art" aria-hidden="true">
      {[[40, 30, 70, 60, 40], [66, 36, 74, 44, 66], [92, 50, 84, 70, 56], [118, 40, 70, 58, 46], [144, 30, 62, 46, 36], [170, 24, 52, 38, 30]].map(([x, h, l, o, c], k) => (
        <g key={k}>
          <line x1={x} y1={h} x2={x} y2={l} stroke={c < o ? "#19c98f" : "#f04f6a"} strokeWidth="1.4" />
          <rect x={x - 6} y={Math.min(o, c)} width="12" height={Math.max(2, Math.abs(o - c))} fill={c < o ? "#19c98f" : "#f04f6a"} rx="1" />
        </g>
      ))}
      <line x1="170" y1="4" x2="170" y2="106" stroke="#a9a69f" strokeDasharray="3 3" />
      <line x1="8" y1="34" x2="292" y2="34" stroke="#a9a69f" strokeDasharray="3 3" />
      <rect x="186" y="18" width="104" height="22" rx="11" fill="#e8a33d" />
      <text x="196" y="33" fill="#1b1306" fontSize="10" fontWeight="700">Analyse from here</text>
      <circle cx="170" cy="70" r="13" fill="rgba(232,163,61,0.18)" stroke="#e8a33d" />
      <circle cx="170" cy="70" r="4" fill="#e8a33d" />
      <text x="188" y="80" fill="#a9a69f" fontSize="9">hold the newest candle</text>
    </svg>
  );
}

const STEPS = [
  { ch: "Set up", title: "Welcome to StreixAnalyst", body: "Two minutes on how to use the analyst and how to enter a trade from it without walking into a stop hunt. Skip any time.", target: null },
  { ch: "Set up", title: "Your strategies", body: "The analyst reads the chart only with the strategies you picked, and draws only what they use. Change them here any time: smart money, scalping, trend, fixed time, or a mix.", target: "strategies" },
  { ch: "Set up", title: "Market and interval", body: "Pick the market, then the interval. Star your favourite intervals and they sit next to it for one-tap switching.", target: "market" },
  { ch: "Read", title: "Press Analyse", body: "The analyst checks every timeframe, maps structure and liquidity, measures how deep stop hunts go on this chart, runs your strategies and checks the news.", target: "analyse", action: "analyse" },
  { ch: "Read", title: "The verdict", body: "It says “possible”, never “sure”, with a confidence: low, moderate or good. A new candle can change it, and other timeframes can disagree. Low confidence means skip or trade small.", target: "verdict", reveal: ".verdict-pill" },
  { ch: "Read", title: "Every timeframe", body: "Before entering, look at this table. When the bigger timeframes lean the other way, the trade is weaker: size down or wait.", target: "mtf", reveal: ".verdict-pill" },
  { ch: "Enter", title: "Entry, stop and targets", body: "Tap any line to copy its price, or Copy all for your broker. Edit makes the whole analysis yours in My analysis. Don't want trade levels? Switch them off in Settings for analysis only.", target: "levels", reveal: ".verdict-pill" },
  { ch: "Enter", title: "Wait for the sweep", body: "Price often takes the stops under an obvious low (or over a high) before moving. The analyst puts your stop past that liquidity by how deep hunts reach here, and warns you when liquidity sits right under your entry: then wait for the sweep and a close back.", target: "howto", reveal: ".verdict-pill", art: "sweep" },
  { ch: "Enter", title: "Follow the steps", body: "Use the order type it gives (limit, stop or market), set the stop with the entry, take part profit at TP1 and move the stop to break-even. If it hasn't filled in time, the idea is cancelled.", target: "howto", reveal: ".verdict-pill" },
  { ch: "Enter", title: "Hold the chart", body: "The crosshair shows only while you hold (phone) or hover (computer). Hold on the newest candle and tap “Analyse from here” to see both sides from the price you'd enter at now. Tap any of the analyst's drawings to see why it's there.", target: null, art: "hold", reveal: ".bottom-nav button:nth-child(2)" },
  { ch: "Review", title: "Draw your own", body: "The dock has your favourite tools; the grid opens all of them, from Fibonacci and pitchforks to Elliott waves and notes. Star a tool to keep it in the dock.", target: "dock", alt: "tools", reveal: ".bottom-nav button:nth-child(2)" },
  { ch: "Review", title: "My analysis", body: "Your edited and own analyses live here. Move the entry, stop or target, add levels, then ask the AI to grade it, including whether your stop sits where stop hunts happen.", target: "desk" },
  { ch: "Review", title: "Everything else", body: "The toolbox has replay (go back in time, analyse, then watch what happened at 2× to 16×), indicators, alerts, ideas and teaching tools.", target: "hub" },
  { ch: "Review", title: "You're set", body: "Start small: one strategy, one market, small risk. Replay this tour any time from Settings.", target: null },
];

// The first element with this tour name that is actually on screen (the desktop and mobile layouts both have some).
function visibleTarget(name) {
  if (!name || typeof document === "undefined") return null;
  const vw = window.innerWidth;
  for (const el of document.querySelectorAll(`[data-tour="${name}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.right > 0 && r.left < vw) return el;
  }
  return null;
}

export default function Tour() {
  const { user, settings, updateSettings } = useAuth();
  // after the strategy choice: a new account chooses its strategies first
  const open = !!user && settings.tourDone === false && !user.needs_strategies;
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const step = STEPS[i];
  const last = i === STEPS.length - 1;

  const finish = useCallback(() => updateSettings({ tourDone: true }), [updateSettings]);

  const find = useCallback(() => visibleTarget(step.target) || visibleTarget(step.alt), [step.target, step.alt]);
  const measure = useCallback(() => {
    const el = find();
    setRect(el ? el.getBoundingClientRect() : null);
  }, [find]);

  useEffect(() => {
    if (open) setI(0);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    let revealed = false;
    let scrolled = false;
    // keep looking for a while: the analysis may still be on its way, and on a phone its panel has to be opened
    const look = () => {
      let el = find();
      if (!el && step.reveal && !revealed) {
        const r = document.querySelector(step.reveal);
        if (r) {
          r.click();
          revealed = true;
        }
        el = find();
      }
      if (el && !scrolled) {
        scrolled = true;
        const r = el.getBoundingClientRect();
        if (r.top < 60 || r.bottom > window.innerHeight - 60) el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      measure();
    };
    look();
    const poll = setInterval(look, 500);
    const stop = setTimeout(() => clearInterval(poll), 12000);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      clearInterval(poll);
      clearTimeout(stop);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, i, measure, find, step.reveal]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, finish]);

  if (!open) return null;

  const next = () => {
    if (step.action === "analyse") {
      const b = visibleTarget("analyse");
      if (b && !b.disabled) b.click();
    }
    if (last) finish();
    else setI(i + 1);
  };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mobile = vw < 640;
  const width = mobile ? vw - 24 : 360;
  const cardH = step.art ? 330 : 230;
  let pos = { left: (vw - width) / 2, top: Math.max(12, vh / 2 - cardH / 2) };
  if (mobile) {
    const low = rect && rect.top < vh / 2;
    pos = { left: 12, top: low ? Math.min(vh - cardH - 76, rect.bottom + 12) : 64 };
  } else if (rect) {
    const below = rect.bottom + 16 + cardH < vh;
    let left = rect.left;
    if (rect.width > vw * 0.4) left = rect.left + rect.width / 2 - width / 2;
    if (rect.left > vw - width - 24) left = rect.left - width - 16;
    pos = {
      left: Math.max(12, Math.min(left, vw - width - 12)),
      top: below ? rect.bottom + 14 : Math.max(12, Math.min(vh - cardH - 12, rect.top - cardH - 10)),
    };
    if (rect.left > vw - width - 24 && rect.height > 200) pos.top = Math.max(12, Math.min(vh - cardH - 12, rect.top));
  }
  const missing = !!step.target && !rect;
  const chapters = [...new Set(STEPS.map((s) => s.ch))];

  return (
    <>
      {rect ? (
        <div className="tour-spot" aria-hidden="true"
          style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: Math.min(rect.height + 12, vh - rect.top) }} />
      ) : (
        <div className="tour-dim" aria-hidden="true" />
      )}
      <div className="tour-card" role="dialog" aria-modal="false" aria-label="StreixAnalyst tour"
        style={{ left: pos.left, top: pos.top, width }}>
        <div className="tour-chapters" aria-label="Chapters">
          {chapters.map((c) => <span key={c} className={c === step.ch ? "on" : STEPS.findIndex((s) => s.ch === c) < i ? "done" : ""}>{c}</span>)}
        </div>
        <div className="tour-title">{step.title}</div>
        {step.art === "sweep" ? <SweepArt /> : step.art === "hold" ? <HoldArt /> : null}
        <p className="tour-body">
          {step.body}{missing && step.action !== "analyse" ? " (It appears once an analysis is on the chart.)" : ""}
        </p>
        <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
          <button className="btn ghost sm" onClick={finish}>Skip tour</button>
          <div className="row" style={{ gap: 8 }}>
            <span className="faint num" style={{ fontSize: "0.78rem" }}>{i + 1}/{STEPS.length}</span>
            {i > 0 ? <button className="btn sm" onClick={() => setI(i - 1)}>Back</button> : null}
            <button className="btn primary sm" onClick={next}>{last ? "Start trading" : step.action === "analyse" ? "Analyse for me" : "Next"}</button>
          </div>
        </div>
      </div>
    </>
  );
}

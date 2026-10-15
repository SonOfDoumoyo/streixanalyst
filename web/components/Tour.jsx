"use client";
// The first-visit tour of the terminal. Each step points at one part of the screen (an element with data-tour="...").
// Finishing or skipping saves settings.tourDone, so it is not shown again. Replay it from Settings or Support.
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/Providers";

const STEPS = [
  { title: "Welcome to StreixAnalyst", body: "A one-minute tour. Skip any time, and replay it from Settings.", target: null },
  { title: "Pick your market", body: "Search crypto, forex, gold or indices, or pick one from your watchlist.", target: "market" },
  { title: "Choose a timeframe", body: "From 15 minutes to a day. Higher timeframes give the bigger picture.", target: "timeframe" },
  { title: "Press Analyse", body: "The analyst reads structure, key levels and news, then draws a trade plan on your chart.", target: "analyse" },
  { title: "Read the verdict", body: "The grade (A+ to D) shows how many things line up. A good grade is never a guarantee.", target: "verdict" },
  { title: "The bull and bear bar", body: "It shows the model's view of the next 24 candles: range vs trend, or the lean. Pick one, or hide it.", target: "direction" },
  { title: "Your trade plan", body: "Entry, stop and targets, with the risk for your account size. Set your risk in Settings.", target: "plan" },
  { title: "You are set", body: "Analyse a few charts, then test your reading in Draw & score. You can replay this tour any time.", target: null },
];

// The first element with this tour name that is actually on screen (the desktop and mobile layouts both have some).
function visibleTarget(name) {
  if (!name || typeof document === "undefined") return null;
  for (const el of document.querySelectorAll(`[data-tour="${name}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

export default function Tour() {
  const { user, settings, updateSettings } = useAuth();
  const open = !!user && settings.tourDone === false;
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const step = STEPS[i];
  const last = i === STEPS.length - 1;

  const finish = useCallback(() => updateSettings({ tourDone: true }), [updateSettings]);

  const measure = useCallback(() => {
    const el = visibleTarget(step.target);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [step.target]);

  // Start again from the first step each time the tour opens.
  useEffect(() => {
    if (open) setI(0);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const el = visibleTarget(step.target);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    measure();
    const t = setTimeout(measure, 350);          // once any smooth scrolling has settled
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, i, measure, step.target]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, finish]);

  if (!open) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mobile = vw < 640;
  const width = mobile ? vw - 24 : 340;
  let pos = { left: (vw - width) / 2, top: vh / 2 - 120 };
  if (mobile) {
    pos = { left: 12, top: 72 };                 // under the top bar, clear of the analyse button
  } else if (rect) {
    const below = rect.bottom + 16 + 210 < vh;
    pos = {
      left: Math.max(12, Math.min(rect.left, vw - width - 12)),
      top: below ? rect.bottom + 14 : Math.max(12, rect.top - 224),
    };
  }
  const missing = !!step.target && !rect;

  return (
    <>
      {rect ? (
        <div className="tour-spot" aria-hidden="true"
          style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }} />
      ) : (
        <div className="tour-dim" aria-hidden="true" />
      )}
      <div className="tour-card" role="dialog" aria-modal="false" aria-label="StreixAnalyst tour"
        style={{ left: pos.left, top: pos.top, width }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <span className="tour-level">Level {i + 1} of {STEPS.length}</span>
          <div className="tour-pips" aria-hidden="true">
            {STEPS.map((_, k) => <span key={k} className={k <= i ? "on" : ""} />)}
          </div>
        </div>
        <div className="tour-title">{step.title}</div>
        <p className="tour-body">
          {step.body}{missing ? " Run an analysis to see this part." : ""}
        </p>
        <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
          <button className="btn ghost sm" onClick={finish}>Skip tour</button>
          <div className="row" style={{ gap: 8 }}>
            {i > 0 ? <button className="btn sm" onClick={() => setI(i - 1)}>Back</button> : null}
            <button className="btn primary sm" onClick={last ? finish : () => setI(i + 1)}>{last ? "Let's go" : "Next"}</button>
          </div>
        </div>
      </div>
    </>
  );
}

"use client";
import { useEffect, useRef } from "react";
import { ChartEngine } from "./engine";

/** React wrapper around the canvas engine. `onReady(engine)` hands the engine to the parent. */
export default function ChartView({ onReady, onEvent, scale = 1, className = "", interactive = true }) {
  const wrap = useRef(null);
  const canvas = useRef(null);
  const evRef = useRef(onEvent);
  evRef.current = onEvent;

  useEffect(() => {
    const eng = new ChartEngine(canvas.current, { scale, onEvent: (type, data) => evRef.current && evRef.current(type, data) });
    const el = wrap.current;
    const fit = () => {
      const r = el.getBoundingClientRect();
      eng.resize(r.width, r.height, window.devicePixelRatio || 1);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    const onDpr = () => fit();
    window.addEventListener("resize", onDpr);
    if (onReady) onReady(eng);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onDpr);
      eng.destroy();
      if (onReady) onReady(null);
    };
    // the engine lives for the component's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrap} className={className} style={{ position: "absolute", inset: 0, pointerEvents: interactive ? undefined : "none" }}>
      <canvas ref={canvas} className="chart-canvas" tabIndex={interactive ? 0 : -1} aria-label="Price chart"
        style={interactive ? undefined : { touchAction: "auto" }} />
    </div>
  );
}

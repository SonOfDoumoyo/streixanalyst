"use client";
// A sheet that rises from the bottom of a phone screen, and slides in as a drawer from the right on a larger screen.
// Close it with the ×, the backdrop, Escape, or by pulling the handle down.
import { useEffect, useRef, useState } from "react";
import Icon from "@/components/Icons";

export default function Sheet({ open, onClose, title, onBack, children, wide = false, footer = null }) {
  const [pull, setPull] = useState(0);
  const start = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  useEffect(() => setPull(0), [open]);
  if (!open) return null;
  const down = (e) => {
    start.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    if (start.current === null) return;
    setPull(Math.max(0, e.clientY - start.current));
  };
  const up = () => {
    if (start.current === null) return;
    start.current = null;
    if (pull > 90) onClose();
    else setPull(0);
  };
  return (
    <div className="sheet-overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}
        style={pull ? { transform: `translateY(${pull}px)`, transition: "none" } : undefined}>
        <div className="sheet-grip" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <span />
        </div>
        <div className="sheet-head">
          {onBack ? <button className="icon-btn" onClick={onBack} aria-label="Back"><Icon name="chevronLeft" /></button> : null}
          <h3>{title}</h3>
          <button className="icon-btn sheet-x" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

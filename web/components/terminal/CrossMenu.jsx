"use client";
// The crosshair menu, opened when a finger lifts on the price tag after holding the crosshair, by clicking that tag, or
// by right-clicking the chart. It
// offers a horizontal line or a price alert at the price under the crosshair, like TradingView.
import { useEffect } from "react";

export default function CrossMenu({ at, onClose, onLine, onAlert }) {
  useEffect(() => {
    if (!at) return undefined;
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [at, onClose]);
  if (!at) return null;
  const p = Number(at.price).toFixed(at.decimals ?? 2);
  const vw = typeof window !== "undefined" ? window.innerWidth : 800;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = Math.max(8, Math.min(at.x, vw - 252));
  const top = Math.max(8, Math.min(at.y, vh - 190));
  const item = { display: "block", width: "100%", textAlign: "left", padding: "10px 12px", background: "none", border: 0, color: "inherit", font: "inherit", cursor: "pointer", borderRadius: 8 };
  return (
    <div onPointerDown={onClose} style={{ position: "fixed", inset: 0, zIndex: 60 }}>
      <div role="menu" aria-label={`At ${p}`} onPointerDown={(e) => e.stopPropagation()}
        className="glass" style={{ position: "fixed", left, top, width: 244, padding: 6, borderRadius: 12, boxShadow: "0 10px 30px rgba(0,0,0,0.4)" }}>
        <div className="muted" style={{ padding: "6px 12px 8px", fontSize: "0.82rem" }}>At {p}</div>
        <button role="menuitem" style={item} onClick={() => onLine(at)}>Horizontal line here</button>
        <button role="menuitem" style={item} onClick={() => onAlert(at, "above")}>Alert when price rises above</button>
        <button role="menuitem" style={item} onClick={() => onAlert(at, "below")}>Alert when price falls below</button>
        <button role="menuitem" style={{ ...item, color: "var(--muted, #9aa3b5)" }} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

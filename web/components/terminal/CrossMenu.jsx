"use client";
// The crosshair's + menu, like TradingView's: tap the + on the crosshair's price tag (or right-click the chart) for an
// alert or a horizontal line at that price. On a phone it rises from the bottom; on a larger screen it opens beside
// the pointer.
import { useEffect } from "react";
import Icon from "@/components/Icons";
import Sheet from "./Sheet";

export default function CrossMenu({ at, onClose, onLine, onRay, onAlert, onAlertForm, onCopy, symbolLabel, last }) {
  useEffect(() => {
    if (!at) return undefined;
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [at, onClose]);
  if (!at) return null;
  const p = Number(at.price).toLocaleString("en-US", { minimumFractionDigits: at.decimals ?? 2, maximumFractionDigits: at.decimals ?? 2 });
  const op = last && at.price < last ? "below" : "above";
  const items = [
    ["bell", `Add alert on ${symbolLabel} at ${p}`, () => onAlert(at, op), op === "above" ? "When price rises to it" : "When price falls to it"],
    ["hline", `Draw horizontal line at ${p}`, () => onLine(at)],
    ["hray", `Draw horizontal ray at ${p}`, () => onRay(at)],
    ["settings", "Alert with options…", () => onAlertForm(at, op), "A note, repeats and email"],
    ["copy", `Copy price ${p}`, () => onCopy(at)],
  ];
  const list = (
    <div className="cross-list" role="menu" aria-label={`At ${p}`}>
      {items.map(([ic, label, fn, sub]) => (
        <button key={label} role="menuitem" onClick={fn}>
          <Icon name={ic} size={18} />
          <span className="grow">{label}{sub ? <small>{sub}</small> : null}</span>
        </button>
      ))}
    </div>
  );
  const phone = typeof window !== "undefined" && window.innerWidth <= 760;
  if (phone) return <Sheet open onClose={onClose} title={p}>{list}</Sheet>;
  const vw = typeof window !== "undefined" ? window.innerWidth : 800;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = Math.max(8, Math.min(at.x - 300, vw - 320));
  const top = Math.max(8, Math.min(at.y, vh - 260));
  return (
    <div onPointerDown={onClose} style={{ position: "fixed", inset: 0, zIndex: 60 }}>
      <div onPointerDown={(e) => e.stopPropagation()} className="glass cross-pop" style={{ left, top }}>
        {list}
      </div>
    </div>
  );
}

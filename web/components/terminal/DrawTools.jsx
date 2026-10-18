"use client";
import { useState } from "react";
import Icon from "@/components/Icons";
import { TOOLS } from "@/components/chart/engine";

const GROUPS = [
  ["cursor"],
  ["trendline", "ray", "extline", "arrow"],
  ["hline", "hray", "vline"],
  ["rect", "channel"],
  ["fib"],
  ["long", "short"],
  ["measure"],
  ["text"],
];
const ICON = { cursor: "cursor", trendline: "trendline", ray: "ray", extline: "extline", arrow: "arrow", hline: "hline", hray: "hray",
  vline: "vline", rect: "rect", channel: "channel", fib: "fib", long: "long", short: "short", measure: "ruler", text: "note" };
const KEYS = { trendline: "Alt+T", hline: "Alt+H", rect: "Alt+R", fib: "Alt+F", long: "Alt+L", short: "Alt+S", measure: "Alt+M" };
export const TOOL_KEYS = { t: "trendline", h: "hline", r: "rect", f: "fib", l: "long", s: "short", m: "measure", v: "vline" };

export const PRACTICE_GROUPS = [["cursor"], ["hline", "hray"], ["rect"], ["trendline", "ray"], ["long", "short"], ["text"]];

export function DrawToolbar({ tool, setTool, magnet, setMagnet, visible, setVisible, onUndo, onRedo, onClear, mobileHidden, groups = GROUPS }) {
  const [groupSel, setGroupSel] = useState({});
  return (
    <div className={`toolbar ${mobileHidden ? "hidden-m" : ""}`} role="toolbar" aria-label="Drawing tools">
      {groups.map((g, gi) => {
        const cur = g.includes(tool) ? tool : groupSel[gi] || g[0];
        return (
          <ToolButton key={gi} group={g} cur={cur} active={g.includes(tool)}
            onPick={(t) => {
              setGroupSel((s) => ({ ...s, [gi]: t }));
              setTool(t);
            }} />
        );
      })}
      <div className="tsep" />
      <button className={`icon-btn ${magnet ? "active" : ""}`} onClick={() => setMagnet(!magnet)} title="Magnet: snap to open/high/low/close">
        <Icon name="magnet" />
      </button>
      <button className={`icon-btn ${!visible ? "active" : ""}`} onClick={() => setVisible(!visible)} title={visible ? "Hide my drawings" : "Show my drawings"}>
        <Icon name={visible ? "eye" : "eyeOff"} />
      </button>
      <button className="icon-btn" onClick={onUndo} title="Undo (Ctrl+Z)"><Icon name="undo" /></button>
      <button className="icon-btn" onClick={onRedo} title="Redo (Ctrl+Y)"><Icon name="redo" /></button>
      <button className="icon-btn" onClick={onClear} title="Remove all my drawings on this chart"><Icon name="trash" /></button>
    </div>
  );
}

function ToolButton({ group, cur, active, onPick }) {
  const [open, setOpen] = useState(false);
  const label = (TOOLS[cur] && TOOLS[cur].label) || "Select / move";
  return (
    <div style={{ position: "relative" }} onMouseLeave={() => setOpen(false)}>
      <button className={`icon-btn ${active ? "active" : ""}`} onClick={() => onPick(cur)}
        onContextMenu={(e) => {
          if (group.length > 1) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        title={`${label}${KEYS[cur] ? ` (${KEYS[cur]})` : ""}`} aria-label={label} aria-pressed={active}>
        <Icon name={ICON[cur]} />
      </button>
      {group.length > 1 ? (
        <button aria-label="More tools" onClick={() => setOpen((o) => !o)} className="hide-mobile"
          style={{ position: "absolute", right: -2, bottom: 2, width: 10, height: 10, border: 0, padding: 0, background: "transparent", color: "var(--text-3)", fontSize: 8, lineHeight: "10px" }}>
          ▸
        </button>
      ) : null}
      {open ? (
        <div className="menu glass" style={{ left: 40, top: 0 }}>
          {group.map((t) => (
            <button key={t} onClick={() => { setOpen(false); onPick(t); }}>
              <Icon name={ICON[t]} size={18} /> {TOOLS[t].label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const SWATCHES = ["#2962ff", "#2fd3a6", "#ef5350", "#f5b342", "#9b7bff", "#ff6bd6", "#e8eef9", "#8fa1c4"];

export function StyleBar({ drawing, onStyle, onDelete, onClone, onLock, onReview, onEditText }) {
  if (!drawing) return null;
  const st = drawing.style || {};
  const isLine = ["trendline", "ray", "extline", "arrow", "hline", "hray", "vline", "channel"].includes(drawing.type);
  const canExtend = ["trendline", "rect", "fib"].includes(drawing.type);
  const color = st.color || "#2962ff";
  return (
    <div className="style-bar glass" role="toolbar" aria-label="Drawing style">
      {SWATCHES.map((c) => (
        <button key={c} className={`swatch ${color.toLowerCase() === c ? "on" : ""}`} style={{ background: c }} aria-label={`Colour ${c}`}
          onClick={() => onStyle({ color: c, ...(drawing.type === "rect" ? { fill: undefined } : {}) })} />
      ))}
      <input type="color" className="color-input" value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#2962ff"} aria-label="Custom colour"
        onChange={(e) => onStyle({ color: e.target.value, ...(drawing.type === "rect" ? { fill: undefined } : {}) })} />
      {isLine || drawing.type === "rect" ? (
        <>
          <span className="sep" style={{ width: 1, height: 22, background: "var(--line)", margin: "0 4px" }} />
          <div className="seg" style={{ padding: 2 }}>
            {[1, 2, 3, 4].map((w) => (
              <button key={w} className={(st.width || 2) === w ? "on" : ""} onClick={() => onStyle({ width: w })} aria-label={`Width ${w}`} style={{ padding: "4px 7px" }}>
                <span style={{ display: "block", width: 14, height: w, background: "currentColor", borderRadius: 2 }} />
              </button>
            ))}
          </div>
          <div className="seg" style={{ padding: 2 }}>
            {[["solid", "—"], ["dashed", "– –"], ["dotted", "···"]].map(([d, l]) => (
              <button key={d} className={(st.dash || "solid") === d ? "on" : ""} onClick={() => onStyle({ dash: d })} style={{ padding: "4px 8px" }}>{l}</button>
            ))}
          </div>
        </>
      ) : null}
      {canExtend ? (
        <button className={`btn sm ${st.extendRight ? "primary" : "ghost"}`} onClick={() => onStyle({ extendRight: !st.extendRight })} title="Extend to the right">Extend →</button>
      ) : null}
      {["text", "hline", "rect", "trendline"].includes(drawing.type) ? (
        <button className="icon-btn" onClick={onEditText} title="Label"><Icon name="text" /></button>
      ) : null}
      {(drawing.type === "long" || drawing.type === "short") && onReview ? (
        <button className="btn sm primary" onClick={onReview} title="Grade this trade with the analyst"><Icon name="review" size={15} /> Review</button>
      ) : null}
      <button className="icon-btn" onClick={onClone} title="Clone"><Icon name="copy" /></button>
      <button className={`icon-btn ${drawing.locked ? "active" : ""}`} onClick={onLock} title={drawing.locked ? "Unlock" : "Lock"}>
        <Icon name={drawing.locked ? "lock" : "unlock"} />
      </button>
      <button className="icon-btn" onClick={onDelete} title="Delete (Del)" style={{ color: "#ff8a87" }}><Icon name="trash" /></button>
    </div>
  );
}

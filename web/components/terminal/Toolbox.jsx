"use client";
// The toolbox: everything the chart can do, as one searchable list grouped by job (chart, analyst, trade, share and
// teach), each row saying what it does. It replaces a grid of icons, so nothing has to be guessed from a symbol.
import { useMemo, useState } from "react";
import Link from "next/link";
import Icon from "@/components/Icons";
import Sheet from "./Sheet";

export default function Toolbox({ open, onClose, go, act, symbol, tf, teacher, student, live }) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => [
    { title: "Chart", rows: [
      ["types", "candles", "Chart type", "Candles, Heikin Ashi, Renko, line break, Kagi, point & figure…"],
      ["indicators", "indicator", "Indicators & patterns", "80+ indicators, candlestick patterns and strategy overlays"],
      ["interval", "clock", "Interval & date range", "Every interval from 1 minute to 1 month, favourites, jump to a date"],
      ["compare", "plus", "Compare markets", "Draw other markets over this one, in percent"],
      ["layout", "layers", "Panes & layout", "Volume, RSI, grid, log scale, killzones, panel"],
      ["layouts", "grid", "Saved layouts", "Save this chart setup by name and reopen it"],
      ["objects", "list", "Objects on the chart", "Every drawing: show, hide, lock or delete"],
      ["settings", "settings", "Chart settings", "Colours, candles, background, crosshair", "/settings#chart"],
      ["image", "camera", "Save chart image", "A picture of the chart as it is now"],
    ] },
    { title: "Analyst", rows: [
      ["strategies", "target", "Strategies the analyst uses", "Pick one or several: SMC, scalping, fixed time…"],
      ["fit", "sliders", "Strategy record on this market", "How each strategy has done here, after costs"],
      ["desk", "book", "My analysis", "Your saved and edited analyses, graded by the AI", "/desk"],
      ["replay", "play", "Replay", "Go back to a past moment, analyse it, make your call"],
      ["technicals", "indicator", "Technicals summary", "Moving averages and oscillators: buy, sell or neutral"],
      ["details", "info", "Market details", "Session, decimals, source and price data"],
      ["news", "news", "News & calendar", "Headlines and high-impact events for this market"],
    ] },
    { title: "Trade", rows: [
      ["review", "review", "Review a trade", "Grade your own entry, stop and target"],
      ["alerts", "bell", "Alerts", "Price alerts and strategy alerts"],
      ["broker", "external", "Open at your broker", "Copy the plan into your broker's app"],
    ] },
    { title: "Share & teach", rows: [
      ["publish", "upload", "Publish an idea", "Share this chart and your reasoning in Ideas"],
      ["ideas", "users", "Ideas from others", "Charts and reasoning other traders published", "/markets?tab=ideas"],
      ...(teacher ? [["golive", "tv", live ? "Stop showing my chart" : "Show my chart to students", live ? "Your students can see your chart now" : "Students in your organization watch it live"]] : []),
      ...(student ? [["watch", "users", "Watch my teacher", "See your teacher's chart when they share it", "/class"]] : []),
      ["tv", "tv", "TV mode", "Full-screen presentation without private details", `/tv?s=${encodeURIComponent(symbol)}&tf=${tf}`],
    ] },
  ], [symbol, tf, teacher, student, live]);
  const needle = q.trim().toLowerCase();
  const shown = groups.map((g) => ({ ...g, rows: g.rows.filter((r) => !needle || `${r[2]} ${r[3]}`.toLowerCase().includes(needle)) }))
    .filter((g) => g.rows.length);
  const run = (id) => {
    if (act[id]) act[id]();
    else go(id);
  };
  return (
    <Sheet open={open} onClose={onClose} title="Toolbox">
      <div className="tb-search">
        <Icon name="search" size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a tool" aria-label="Find a tool" />
      </div>
      {shown.map((g) => (
        <section key={g.title} className="tb-group">
          <h4>{g.title}</h4>
          {g.rows.map(([id, ic, title, sub, href]) => {
            const inner = (
              <>
                <span className="tb-ic"><Icon name={ic} size={18} /></span>
                <span className="grow"><b>{title}</b><small>{sub}</small></span>
                <Icon name="chevronRight" size={16} />
              </>
            );
            return href ? (
              <Link key={id} className="tb-row" href={href} onClick={onClose}>{inner}</Link>
            ) : (
              <button key={id} className="tb-row" onClick={() => run(id)}>{inner}</button>
            );
          })}
        </section>
      ))}
    </Sheet>
  );
}

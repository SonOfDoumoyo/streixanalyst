"use client";
import { useEffect, useState } from "react";
import Icon from "@/components/Icons";
import { get, qs } from "@/lib/api";
import { minutesHuman, timeAgo } from "@/lib/format";
import { Empty, Spinner } from "@/components/ui";

export default function NewsPanel({ symbol, tf }) {
  const [data, setData] = useState(null);
  const [cal, setCal] = useState(null);
  const [scope, setScope] = useState("mine");
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setErr(null);
    get(`/news/for?${qs({ symbol, tf })}`).then((d) => alive && setData(d)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [symbol, tf]);

  useEffect(() => {
    let alive = true;
    const ccy = scope === "mine" && data ? data.currencies.join(",") : "";
    get(`/news/calendar?${qs({ currencies: ccy, days: 7, impact: "High,Medium" })}`).then((d) => alive && setCal(d)).catch(() => alive && setCal({ events: [] }));
    return () => { alive = false; };
  }, [scope, data]);

  if (err) return <Empty icon="alert" title="News unavailable">{err}</Empty>;
  if (!data) return <div style={{ padding: 20, display: "grid", placeItems: "center" }}><Spinner /></div>;
  const tone = data.risk === "high" ? "down" : data.risk === "medium" ? "warn" : "up";
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className={`badge ${tone}`} style={{ height: "auto", padding: "9px 11px", whiteSpace: "normal", lineHeight: 1.45, fontWeight: 600 }}>
        <Icon name={data.risk === "low" ? "shield" : "alert"} size={15} style={{ flex: "none" }} /> {data.note}
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="section-title" style={{ margin: 0, flex: 1 }}>Economic calendar</div>
        <div className="seg" style={{ marginLeft: 8 }}>
          <button className={scope === "mine" ? "on" : ""} onClick={() => setScope("mine")}>{data.currencies.join("/")}</button>
          <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>All</button>
        </div>
      </div>
      {!cal ? <Spinner /> : !cal.ok ? <div className="hint">The calendar feed is unavailable right now.</div> : !cal.events.length ? (
        <div className="hint">No high or medium impact events in the next 7 days.</div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {cal.events.slice(0, 30).map((e, i) => (
            <div key={i} className="row" style={{ alignItems: "flex-start", fontSize: "0.85rem", opacity: e.minutes_until < 0 ? 0.6 : 1 }}>
              <span className={`badge ${e.impact === "High" ? "down" : "warn"}`} style={{ minWidth: 44, justifyContent: "center" }}>{e.country}</span>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{e.title}</div>
                <div className="faint" style={{ fontSize: "0.76rem" }}>
                  {new Date(e.time).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })} · {minutesHuman(e.minutes_until)}
                  {e.actual ? ` · actual ${e.actual}` : ""}{e.forecast ? ` · fcst ${e.forecast}` : ""}{e.previous ? ` · prev ${e.previous}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="section-title">Headlines</div>
      {!data.headlines.length ? <div className="hint">No recent headlines found.</div> : (
        <div className="stack" style={{ gap: 10 }}>
          {data.headlines.map((h, i) => (
            <a key={i} href={h.link} target="_blank" rel="noopener noreferrer" className="row" style={{ alignItems: "flex-start", color: "var(--text)", textDecoration: "none", fontSize: "0.88rem" }}>
              <span style={{ width: 8, height: 8, borderRadius: 8, marginTop: 7, flex: "none", background: h.tone === "positive" ? "var(--up)" : h.tone === "negative" ? "var(--down)" : "var(--text-3)" }} />
              <div className="grow">
                <div>{h.title}</div>
                <div className="faint" style={{ fontSize: "0.74rem" }}>{h.source}{h.published ? ` · ${timeAgo(h.published)}` : ""}{h.general ? " · market news" : ""}</div>
              </div>
              <Icon name="external" size={14} style={{ color: "var(--text-3)", flex: "none", marginTop: 4 }} />
            </a>
          ))}
        </div>
      )}
      <div className="hint">Dots show headline tone from a keyword scan — context, not a forecast.</div>
    </div>
  );
}

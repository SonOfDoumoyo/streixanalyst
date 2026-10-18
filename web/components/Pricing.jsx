"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { get } from "@/lib/api";

export function usePlans() {
  const [plans, setPlans] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    get("/billing/plans").then(setPlans).catch((e) => setErr(e.message));
  }, []);
  return { plans, err };
}

// features still being built show a "soon" tag until they ship
export const SOON = ["Classroom", "Teach mode", "Organization branding"];
const Item = ({ t }) => {
  const soon = SOON.some((s) => t.startsWith(s));
  return <li>{t}{soon ? <span className="badge violet" style={{ marginLeft: 6, height: 18 }}>soon</span> : null}</li>;
};

const FREE_LIST = (L) => [
  "Every market and timeframe, live charts",
  "All drawing tools, custom candle colours",
  `${L.analysis} AI analyses a day`,
  `${L.ai} StreixAI messages a day`,
  `${L.review} trade reviews a day`,
  "News & calendar in every analysis",
];
const PRO_LIST = (L) => [
  `${L.analysis} AI analyses a day`,
  `${L.ai} StreixAI messages a day`,
  "Strategy lab: backtest your own rules",
  "Draw & score: the AI grades your analysis",
  "Alerts on price and setups",
  "Simple + pro reports with model statistics",
];
const ORG_LIST = (L) => [
  "Everything in Pro for every member, no seat limits",
  `${L.analysis} analyses and ${L.ai} AI messages a day for each member`,
  "Classroom: members join with a class code or email",
  "Teach mode and TV / presentation mode",
  "Organization branding",
  "One bill for your whole team, paid per person",
];

// Prices are in US dollars. Card and bank payments are taken in naira at the rate shown.
const usd = (v) => `$${Number.isInteger(v) ? v : v.toFixed(2)}`;
const naira = (v) => `₦${Number(v).toLocaleString("en-NG")}`;

export default function PricingCards({ plans, months = 1, onChoose, current }) {
  if (!plans) {
    return (
      <div className="pricing">
        {[0, 1, 2].map((i) => <div key={i} className="card skeleton" style={{ height: 420 }} />)}
      </div>
    );
  }
  const L = plans.tiers;
  const pro = plans.quotes.pro[String(months)];
  const org = plans.quotes.org[String(months)];
  const per = months === 1 ? "/month" : `/${months} months`;
  const charge = (q) => `Charged in naira: ${naira(q.naira)} at ₦${Number(q.rate).toLocaleString("en-NG")} per $1`;
  return (
    <div className="pricing">
      <div className="card price-card">
        <div>
          <div className="eyebrow" style={{ color: "var(--text-2)" }}>Free</div>
          <div className="amt">$0</div>
          <div className="faint">after your {plans.trial_days}-day trial</div>
        </div>
        <ul>{FREE_LIST(L.free.limits).map((t) => <Item key={t} t={t} />)}</ul>
        <div className="grow" />
        {onChoose ? (
          <button className="btn block" disabled>{current === "free" ? "Your plan" : "Included"}</button>
        ) : (
          <Link className="btn block" href="/signup">Start free</Link>
        )}
      </div>
      <div className="card price-card featured">
        <span className="badge brand" style={{ position: "absolute", top: 16, right: 16 }}>Most popular</span>
        <div>
          <div className="eyebrow">Pro</div>
          <div className="amt">{usd(pro.usd)}<span className="faint" style={{ fontSize: "1rem", fontWeight: 600 }}>{per}</span></div>
          <div className="faint">{charge(pro)}{pro.discount ? ` · save ${Math.round(pro.discount * 100)}%` : ""}</div>
        </div>
        <ul>{PRO_LIST(L.pro.limits).map((t) => <Item key={t} t={t} />)}</ul>
        <div className="grow" />
        {onChoose ? (
          <button className="btn primary block lg" onClick={() => onChoose("pro")}>{current === "pro" ? "Extend Pro" : "Get Pro"}</button>
        ) : (
          <Link className="btn primary block lg" href="/signup">Try Pro free for {plans.trial_days} days</Link>
        )}
      </div>
      <div className="card price-card">
        <div>
          <div className="eyebrow" style={{ color: "var(--violet)" }}>Organization</div>
          <div className="amt">{usd(plans.pricing.org_seat_monthly)}<span className="faint" style={{ fontSize: "1rem", fontWeight: 600 }}> per person{per}</span></div>
          <div className="faint">You pay for each person on your team, with a minimum of one</div>
        </div>
        <ul>{ORG_LIST(L.org.limits).map((t) => <Item key={t} t={t} />)}</ul>
        <div className="grow" />
        {onChoose ? (
          <button className="btn block lg" onClick={() => onChoose("org")}>{current === "org" ? "Extend the organization" : "Set up an organization"}</button>
        ) : (
          <Link className="btn block lg" href="/signup?next=%2Fbilling">Start with your team</Link>
        )}
      </div>
    </div>
  );
}

export function MonthsToggle({ months, setMonths, plans }) {
  const d = plans ? plans.pricing.discounts : {};
  return (
    <div className="seg brand" role="radiogroup" aria-label="Billing period">
      {[1, 3, 12].map((m) => (
        <button key={m} className={months === m ? "on" : ""} onClick={() => setMonths(m)} role="radio" aria-checked={months === m}>
          {m === 1 ? "Monthly" : m === 3 ? "3 months" : "Yearly"}
          {d && d[String(m)] ? <span className="badge up" style={{ marginLeft: 6, height: 18 }}>−{Math.round(d[String(m)] * 100)}%</span> : null}
        </button>
      ))}
    </div>
  );
}

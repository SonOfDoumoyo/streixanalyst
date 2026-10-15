"use client";
// What is left of today's allowance. It counts down as you use it and resets at 00:00 UTC. Admins are not limited.
import Link from "next/link";
import { useAuth } from "@/components/Providers";

const ROWS = [["analysis", "Analyses"], ["review", "Trade reviews"], ["ai", "StreixAI messages"]];

export default function UsageMeter() {
  const { user } = useAuth();
  const ent = user && user.entitlements;
  if (!ent) return null;
  const unlimited = ent.tier === "admin";
  const limits = ent.limits || {};
  const usage = ent.usage || {};
  const trialDays = ent.trial_days_left;

  return (
    <div className="meter" aria-label="Today's allowance">
      <div className="meter-head">
        <span>{"Today's allowance"}</span>
        {ent.tier === "trial" ? <span className="faint">{`Trial, ${trialDays} day${trialDays === 1 ? "" : "s"} left`}</span> : null}
      </div>
      {ROWS.map(([k, label]) => {
        const lim = limits[k];
        if (unlimited || lim === null || lim === undefined) {
          return (
            <div key={k} className="meter-row">
              <div className="meter-label"><span>{label}</span><span className="num">Unlimited</span></div>
            </div>
          );
        }
        const left = Math.max(0, lim - (usage[k] || 0));
        const pct = lim > 0 ? (left / lim) * 100 : 0;
        return (
          <div key={k} className="meter-row">
            <div className="meter-label">
              <span>{label}</span>
              <span className="num">{lim > 0 ? `${left} of ${lim} left` : "Pro feature"}</span>
            </div>
            <div className="meter-bar" role="img" aria-label={`${left} of ${lim} ${label.toLowerCase()} left today`}>
              <span className={left === 0 ? "empty" : ""} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
      <div className="meter-foot">
        {ent.tier === "free" ? <>Free plan. <Link href="/pricing">See Pro</Link> for more each day.</> : null}
        {ent.tier === "trial" ? "Full access during the trial. Then the free plan applies." : null}
      </div>
    </div>
  );
}

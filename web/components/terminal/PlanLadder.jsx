"use client";
import { fmtPrice } from "@/lib/format";

// Signed % move from the entry to a price, e.g. "+1.24%" or "−0.42%".
export function movePct(entry, price) {
  if (!entry || !Number.isFinite(Number(price))) return "";
  const v = (Number(price) / Number(entry) - 1) * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;
}

// A trade as a price ladder: entry, stop and every target, with the move from entry and the R multiple, and a bar
// that shows risk against reward. The analysis and the replay both draw trades with this.
export default function PlanLadder({ p, dec }) {
  if (!p || p.entry === undefined || p.entry === null) return null;
  const risk = Math.abs(p.entry - p.sl);
  const reward = p.tps && p.tps[0] ? Math.abs(p.tps[0] - p.entry) : 0;
  const targets = p.tps && p.tps.length ? p.tps : [null];
  return (
    <div className="plan-ladder">
      <div className="ladder">
        <div className="ladder-row ep">
          <i /><span className="k">Entry</span><span className="v num">{fmtPrice(p.entry, dec)}</span><span className="d" /><span className="rr" />
        </div>
        <div className="ladder-row sl">
          <i /><span className="k">Stop</span><span className="v num">{fmtPrice(p.sl, dec)}</span>
          <span className="d num">{movePct(p.entry, p.sl)}</span><span className="rr" />
        </div>
        {targets.map((t, i) => (
          <div key={i} className="ladder-row tp">
            <i /><span className="k">{p.tps && p.tps.length > 1 ? `Target ${i + 1}` : "Target"}</span>
            <span className="v num">{fmtPrice(t, dec)}</span>
            <span className="d num">{movePct(p.entry, t)}</span>
            <span className="rr num">{p.rr && p.rr[i] !== undefined ? `${Number(p.rr[i]).toFixed(1)}R` : ""}</span>
          </div>
        ))}
      </div>
      {risk > 0 && reward > 0 ? (
        <>
          <div className="rr-bar" title="Risk versus reward, from entry">
            <i className="risk" style={{ flex: risk }} />
            <i className="reward" style={{ flex: reward }} />
          </div>
          <div className="rr-labels num"><span>Risk 1R</span><span>Reward {Number(((p.rr && p.rr[0]) || 0)).toFixed(2)}R</span></div>
        </>
      ) : null}
    </div>
  );
}

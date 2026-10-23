"use client";
// The TradingView route: copy a Pine Script that draws the plan on a TradingView chart.
import { useMemo } from "react";
import Icon from "@/components/Icons";
import Sheet from "@/components/terminal/Sheet";
import { useAuth } from "@/components/Providers";
import { pineFor } from "@/lib/pine";

export default function PineSheet({ open, onClose, res }) {
  const { toast } = useAuth();
  const code = useMemo(() => (open ? pineFor(res) : null), [open, res]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast("Script copied. Paste it into TradingView's Pine Editor.", "success", 5000);
    } catch {
      toast("Couldn't copy. Select the script and copy it.", "error");
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Show it on TradingView" wide
      footer={<button className="btn primary" style={{ width: "100%", justifyContent: "center" }} onClick={copy} disabled={!code}><Icon name="copy" size={16} /> Copy the script</button>}>
      <div className="bk">
        <p className="wt-lead">TradingView doesn't let other sites draw on its charts, so this script does it from inside TradingView: it marks the entry, stop loss, take profits and the risk and reward areas of this analysis.</p>
        <ol className="bk-steps">
          <li>Press <b>Copy the script</b>.</li>
          <li>In TradingView, open the chart and the <b>Pine Editor</b> tab at the bottom.</li>
          <li>Paste, then press <b>Add to chart</b>.</li>
        </ol>
        <textarea className="bk-code" readOnly value={code || "This analysis has no plan to draw."} spellCheck={false} onFocus={(e) => e.target.select()} rows={10} />
        <p className="faint bk-note">The levels are fixed from this analysis. Make a new script after you analyse again.</p>
      </div>
    </Sheet>
  );
}

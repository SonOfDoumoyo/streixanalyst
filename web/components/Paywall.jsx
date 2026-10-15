"use client";
import Link from "next/link";
import Icon from "@/components/Icons";
import { Modal } from "@/components/ui";

/** Shown when a plan limit or a Pro feature stops an action. */
export default function Paywall({ open, onClose, info }) {
  const d = (info && info.detail) || {};
  const message = (info && info.message) || "This is part of StreixAnalyst Pro.";
  const isLimit = d.code === "limit";
  return (
    <Modal open={open} onClose={onClose} title={isLimit ? "You've reached today's limit" : "Unlock StreixAnalyst Pro"}>
      <div className="stack">
        <div className="paywall">
          <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
            <Icon name={isLimit ? "clock" : "star"} size={22} style={{ color: "#c4b3ff", flex: "none" }} />
            <div>{message}</div>
          </div>
        </div>
        <ul className="check-list">
          {["150 AI analyses and 200 StreixAI messages a day", "60 trade reviews a day", "Both report styles plus the model statistics", "Strategy lab with backtests, 40 draw & score checks and 50 alerts"].map((t) => (
            <li key={t} className="ok"><span className="ic">✓</span><span>{t}</span></li>
          ))}
        </ul>
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={onClose}>Not now</button>
          <Link className="btn primary" href="/billing">See plans <Icon name="chevronRight" size={16} /></Link>
        </div>
      </div>
    </Modal>
  );
}

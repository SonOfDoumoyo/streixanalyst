"use client";
import { useState } from "react";
import SubNav from "@/components/SubNav";
import PricingCards, { MonthsToggle, usePlans } from "@/components/Pricing";

export default function PricingPage() {
  const { plans, err } = usePlans();
  const [months, setMonths] = useState(1);
  return (
    <div className="page page-bg">
      <SubNav />
      <main className="container tv-flat" style={{ paddingBottom: 70 }}>
        <div style={{ textAlign: "center", margin: "30px auto 34px", maxWidth: 680 }}>
          <div className="eyebrow">Pricing</div>
          <h1 className="h-display gradient-text" style={{ fontSize: "clamp(2rem, 4.6vw, 3.4rem)", margin: "12px 0" }}>Simple plans. Everything free for {plans ? plans.trial_days : 30} days.</h1>
          <p className="muted">Prices are in US dollars. Pay the naira equivalent by card, bank transfer, USSD or OPay. Every plan includes every market and timeframe.</p>
          <div style={{ marginTop: 18, display: "flex", justifyContent: "center" }}><MonthsToggle months={months} setMonths={setMonths} plans={plans} /></div>
        </div>
        {err ? <div className="error-text" style={{ textAlign: "center" }}>{err}</div> : <PricingCards plans={plans} months={months} />}
      </main>
    </div>
  );
}

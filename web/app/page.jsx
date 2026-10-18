"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Brand from "@/components/Brand";
import Icon from "@/components/Icons";
import HeroChart from "@/components/HeroChart";
import PricingCards, { MonthsToggle, usePlans } from "@/components/Pricing";
import { useAuth } from "@/components/Providers";

const FEATURES = [
  ["zap", "It draws the analysis for you", "Press Analyse and watch it mark structure, liquidity, order blocks, fair value gaps, key levels and a full plan — entry, stop, targets — right on the chart."],
  ["globe", "Any market, any timeframe", "Bitcoin to brand-new listings like CAPUSDT, forex, gold, oil, indices and US stocks. One minute to one month."],
  ["sparkles", "StreixAI, your coach", "Ask why. StreixAI explains the setup at your level — beginner, intermediate or advanced — and teaches the fundamentals as you go."],
  ["news", "News-aware", "Every analysis checks the economic calendar and the latest headlines, and warns you before CPI, NFP or a rate decision hits."],
  ["target", "Draw & score", "Mark your own levels, trendlines and trade, call the bias, and the analyst scores you out of 100: the levels you missed are drawn on the chart and StreixAI coaches you. Daily challenge and leaderboard."],
  ["sliders", "Your strategy, tested honestly", "Describe your rules in plain words. The strategy lab backtests them with next-candle entries and real costs, and shows whether they're firing right now."],
  ["bell", "Alerts that wait for you", "Price, level and plan alerts, plus strategy alerts on every closed candle, in the app, your browser and by email."],
  ["shield", "A track record you can check", "Every trade call is followed on live prices until it wins, loses or expires. The results are public, losses included."],
  ["users", "Built for teaching", "Organizations pay per person, so you only pay for the people on your team. Class codes, email invites and a TV / presentation mode for the big screen."],
];

const FAQ = [
  ["Is this financial advice?", "No. StreixAnalyst is an analysis and education tool. It shows what the chart says, how often similar setups worked historically, and the risks — the decision and the money are always yours."],
  ["How accurate are the probabilities?", "They come from models trained on years of price history and tested on data they never saw. They are calibrated estimates, not promises — and the app tells you plainly when testing hasn't proven an edge."],
  ["Which markets can I analyse?", "Crypto from Binance, Bybit, OKX, KuCoin, MEXC, Gate and Coinbase (spot and perpetuals), plus forex, metals, energies, indices and US stocks."],
  ["How do I pay?", "Card, bank transfer and USSD through Paystack, OPay checkout, your own personal account number, or a direct transfer to our OPay or UBA account. Every payment is verified before your plan unlocks."],
  ["Can I see how the analyst's calls have actually done?", "Yes. The public track record follows every trade call on live prices with fixed rules (no edits, duplicates counted once) and shows wins, losses, the average result after costs and whether the grades hold up."],
  ["What happens after the 30-day trial?", "You keep a free plan with charts, drawing tools and a few analyses a day. Upgrade to Pro whenever you want more."],
];

export default function Landing() {
  const { user, config } = useAuth();
  const [scrolled, setScrolled] = useState(false);
  const [months, setMonths] = useState(1);
  const { plans } = usePlans();
  useEffect(() => {
    const f = () => setScrolled(window.scrollY > 10);
    window.addEventListener("scroll", f, { passive: true });
    return () => window.removeEventListener("scroll", f);
  }, []);
  const days = (config && config.trial_days) || 30;
  return (
    <div className="page page-bg enter">
      {config && config.announcement ? <div className="banner">{config.announcement}</div> : null}
      <nav className={`nav ${scrolled ? "scrolled" : ""}`}>
        <Brand />
        <div className="nav-links">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#pricing">Pricing</a>
          <Link href="/track-record">Track record</Link>
          <a href="#faq">FAQ</a>
        </div>
        <div className="grow" />
        {user ? (
          <Link className="btn primary" href="/terminal">Open terminal <Icon name="chevronRight" size={16} /></Link>
        ) : (
          <>
            <Link className="btn ghost hide-mobile" href="/login">Sign in</Link>
            <Link className="btn primary" href="/signup">Start free</Link>
          </>
        )}
      </nav>

      <header className="container hero">
        <div className="eyebrow">AI chart analysis · crypto · forex · gold · indices · stocks</div>
        <h1 className="h-display gradient-text">The AI analyst that reads the chart with you.</h1>
        <p className="lead">
          Pick any pair. Press <b>Analyse</b>. StreixAnalyst maps the structure, the liquidity and the key levels, checks the news, and draws a
          complete trade plan — with honest odds, position size and the right leverage. Then StreixAI explains every step.
        </p>
        <div className="row wrap" style={{ gap: 12, marginTop: 26 }}>
          <Link className="btn primary lg" href={user ? "/terminal" : "/signup"}><Icon name="zap" size={18} /> {user ? "Open my terminal" : `Start free — ${days} days, everything unlocked`}</Link>
          <a className="btn lg" href="#how">See how it works</a>
        </div>
        <div className="row wrap faint" style={{ gap: 18, marginTop: 18, fontSize: "0.86rem" }}>
          <span className="row" style={{ gap: 6 }}><Icon name="check" size={15} style={{ color: "var(--up)" }} /> No card needed</span>
          <span className="row" style={{ gap: 6 }}><Icon name="check" size={15} style={{ color: "var(--up)" }} /> Works on phone, desktop and TV</span>
          <span className="row" style={{ gap: 6 }}><Icon name="check" size={15} style={{ color: "var(--up)" }} /> Built by Streixcorp</span>
        </div>
        <HeroChart />
      </header>

      <section className="section container" id="how">
        <div className="eyebrow">How it works</div>
        <h2 className="h-display" style={{ fontSize: "clamp(1.8rem, 3.4vw, 2.6rem)", margin: "10px 0 28px" }}>From any chart to a clear plan in seconds</h2>
        <div className="features">
          {[["search", "1. Pick a market", "Search any symbol on any exchange and choose your timeframe — from 1 minute to 1 month."],
            ["zap", "2. Press Analyse", "The analyst reads the higher timeframes, structure, liquidity and news, then draws everything on your chart, step by step."],
            ["target", "3. Trade it — or learn from it", "Get entry, stop, targets, the odds versus break-even, your position size and safe leverage. Ask StreixAI anything."]].map(([ic, t, d]) => (
            <div key={t} className="card feature">
              <div className="ico"><Icon name={ic} size={22} /></div>
              <h3>{t}</h3>
              <p>{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section container" id="features" style={{ paddingTop: 0 }}>
        <div className="eyebrow">Features</div>
        <h2 className="h-display" style={{ fontSize: "clamp(1.8rem, 3.4vw, 2.6rem)", margin: "10px 0 28px" }}>Everything a serious trader needs. Nothing robotic.</h2>
        <div className="features">
          {FEATURES.map(([ic, t, d]) => (
            <div key={t} className="card feature">
              <div className="ico"><Icon name={ic} size={22} /></div>
              <h3>{t}</h3>
              <p>{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section container narrow" style={{ paddingTop: 0 }}>
        <div className="card" style={{ padding: "28px 26px" }}>
          <div className="eyebrow">Odds, not hype</div>
          <h2 className="h-display" style={{ fontSize: "clamp(1.5rem, 2.8vw, 2rem)", margin: "10px 0 12px" }}>We show you the maths — including when it says “don't trade”.</h2>
          <p className="muted" style={{ margin: 0 }}>
            Every plan shows the chance price hits the target before the stop, next to the win rate you'd need to break even after costs. When the odds
            aren't there, the verdict is <b>NO TRADE</b> with a conditional plan — because sitting out is a position too. No guarantees, no fake win rates.
          </p>
        </div>
      </section>

      <section className="section container" id="pricing" style={{ paddingTop: 0 }}>
        <div className="row wrap" style={{ justifyContent: "space-between", marginBottom: 24, gap: 14 }}>
          <div>
            <div className="eyebrow">Pricing</div>
            <h2 className="h-display" style={{ fontSize: "clamp(1.8rem, 3.4vw, 2.6rem)", margin: "10px 0 0" }}>Start with {days} days of everything</h2>
          </div>
          <MonthsToggle months={months} setMonths={setMonths} plans={plans} />
        </div>
        <PricingCards plans={plans} months={months} />
      </section>

      <section className="section container narrow" id="faq" style={{ paddingTop: 0 }}>
        <div className="eyebrow">FAQ</div>
        <h2 className="h-display" style={{ fontSize: "clamp(1.6rem, 3vw, 2.2rem)", margin: "10px 0 20px" }}>Questions, answered</h2>
        <div className="stack" style={{ gap: 10 }}>
          {FAQ.map(([q, a]) => (
            <details key={q} className="fold">
              <summary>{q} <Icon name="chevronDown" size={16} /></summary>
              <div className="muted">{a}</div>
            </details>
          ))}
        </div>
      </section>

      <section className="section container" style={{ textAlign: "center", paddingTop: 0 }}>
        <h2 className="h-display gradient-text" style={{ fontSize: "clamp(2rem, 4vw, 3rem)", margin: "0 0 16px" }}>Your next chart deserves a second opinion.</h2>
        <Link className="btn primary lg" href={user ? "/terminal" : "/signup"}><Icon name="zap" size={18} /> {user ? "Open my terminal" : "Start my free trial"}</Link>
      </section>

      <footer className="footer">
        <div className="container row wrap" style={{ justifyContent: "space-between", gap: 14 }}>
          <div className="row" style={{ gap: 10 }}><Brand size={30} /> <span>© {new Date().getFullYear()} Streixcorp</span></div>
          <div className="row wrap" style={{ gap: 18 }}>
            <Link href="/pricing">Pricing</Link>
            <Link href="/login">Sign in</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/contact">Contact</Link>
            <Link href="/support">Support</Link>
            <Link href="/donate">Donate</Link>
            <span>Trading involves risk. StreixAnalyst is not financial advice.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

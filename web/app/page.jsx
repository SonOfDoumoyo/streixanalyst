"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Brand from "@/components/Brand";
import Icon from "@/components/Icons";
import HeroChart from "@/components/HeroChart";
import PricingCards, { MonthsToggle, usePlans } from "@/components/Pricing";
import PlanLadder from "@/components/terminal/PlanLadder";
import { useAuth } from "@/components/Providers";

// How it works is a real sequence, so it is numbered.
const STEPS = [
  ["Pick a market", "Search any symbol on any exchange and choose a timeframe, from one minute to one month."],
  ["Press Analyse", "The analyst reads the higher timeframes, the structure, the liquidity and the news, then draws each step on your chart."],
  ["Trade it, or learn from it", "You get the entry, stop and targets, the odds against break-even, your position size and a safe leverage. Ask StreixAI about anything on the chart."],
];

// Features are a ledger: one line each, so they can be scanned like a watchlist.
const LEDGER = [
  ["Analysis on the chart", "Structure, liquidity, order blocks, fair value gaps, key levels and a full plan, drawn where they happen."],
  ["Any market", "Bitcoin and new listings, forex, gold, oil, indices and US stocks. One minute to one month."],
  ["StreixAI, your coach", "Ask why. The explanation fits your level, from beginner to advanced, and teaches the basics as you go."],
  ["News aware", "Each analysis checks the economic calendar and the headlines, and warns you before CPI, NFP or a rate decision."],
  ["Draw and score", "Mark your own levels and trade. The analyst scores your call out of 100 and draws what you missed."],
  ["Strategy lab", "Describe your rules in plain words. Backtests enter on the next candle and charge real costs, and show whether the rules fire now."],
  ["Alerts", "Price, level and plan alerts, plus strategy alerts on every closed candle, in the app, in the browser and by email."],
  ["A track record you can check", "Every call is followed on live prices until it wins, loses or expires. The results are public, losses included."],
  ["Built for teaching", "Class codes, email invites and a presentation mode for the big screen. Organizations pay per person on the team."],
];

const FAQ = [
  ["Is this financial advice?", "No. StreixAnalyst is an analysis and education tool. It shows what the chart says, how often similar setups worked historically, and the risks. The decision and the money are always yours."],
  ["How accurate are the probabilities?", "They come from models trained on years of price history and tested on data they never saw. They are calibrated estimates, not promises, and the app tells you plainly when testing hasn't proven an edge."],
  ["Which markets can I analyse?", "Crypto from Binance, Bybit, OKX, KuCoin, MEXC, Gate and Coinbase (spot and perpetuals), plus forex, metals, energies, indices and US stocks."],
  ["How do I pay?", "Card, bank transfer and USSD through Paystack, OPay checkout, your own personal account number, or a direct transfer to our OPay or UBA account. Every payment is verified before your plan unlocks."],
  ["Can I see how the analyst's calls have actually done?", "Yes. The public track record follows every trade call on live prices with fixed rules (no edits, duplicates counted once) and shows wins, losses, the average result after costs and whether the grades hold up."],
  ["What happens after the trial?", "You keep a free plan with charts, drawing tools and a few analyses a day. Upgrade to Pro whenever you want more."],
];

// Example numbers for the odds block. They are illustrative and labelled as an example on the page.
const EXAMPLE_PLAN = {
  side: "long", type: "pullback", entry: 76410.5, sl: 75620, tps: [77650, 78900], rr: [1.57, 3.15],
};

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
  const primaryHref = user ? "/terminal" : "/signup";
  return (
    <div className="page page-bg enter lp">
      {config && config.announcement ? <div className="banner">{config.announcement}</div> : null}
      <nav className={`nav ${scrolled ? "scrolled" : ""}`}>
        <Brand />
        <div className="nav-links">
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
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

      <header className="container lp-hero2">
        <div className="lp-hero2-copy">
          <h1 className="lp-h1">Read any chart with an analyst beside you.</h1>
          <p className="lp-lead">
            Pick a market and press Analyse. You get the structure, key levels, news and a trade plan with entry, stop, targets
            and position size. StreixAI explains each step.
          </p>
          <div className="row wrap lp-cta">
            <Link className="btn primary lg" href={primaryHref}>
              <Icon name="zap" size={18} /> {user ? "Open my terminal" : `Start free, ${days} days`}
            </Link>
            <a className="btn lg" href="#how">See how it works</a>
          </div>
          <ul className="lp-facts">
            <li><Icon name="check" size={15} /> No card needed</li>
            <li><Icon name="check" size={15} /> Works on phone, desktop and TV</li>
            <li><Icon name="check" size={15} /> Built by Streixcorp</li>
          </ul>
        </div>
        <div className="lp-terminal lp-window" aria-label="Live chart preview">
          <div className="lp-term-bar">
            <span className="lp-term-sym">BTCUSDT</span>
            <span className="lp-term-tf">1h</span>
          </div>
          <HeroChart />
        </div>
      </header>

      <section className="lp-section" id="how">
        <div className="container">
          <p className="eyebrow">How it works</p>
          <h2 className="lp-h2">From any chart to a clear plan in three steps</h2>
          <ol className="lp-steps">
            {STEPS.map(([t, d], i) => (
              <li key={t} className="lp-step">
                <span className="lp-step-n num">{i + 1}</span>
                <h3>{t}</h3>
                <p>{d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="lp-section" id="features">
        <div className="container lp-split">
          <div>
            <p className="eyebrow">Features</p>
            <h2 className="lp-h2">Everything on the chart, in one place</h2>
            <p className="lp-body">
              The analysis, the coaching, the news and your own practice share one chart. Nothing needs a second window.
            </p>
          </div>
          <dl className="lp-ledger">
            {LEDGER.map(([t, d]) => (
              <div key={t} className="lp-ledger-row">
                <dt>{t}</dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="lp-section">
        <div className="container lp-split">
          <div>
            <p className="eyebrow">Odds</p>
            <h2 className="lp-h2">The best entry every time, with the maths behind it</h2>
            <p className="lp-body">
              Every analysis gives the best entry it can find, with stop and targets, and the chance that price reaches the target
              before the stop next to the win rate you would need to break even after costs. When the odds are thin, it says
              <b> not confirmed</b> and shows exactly why, so you can size down or wait. No guarantees, and no invented win rates.
            </p>
          </div>
          <div className="lp-example">
            <div className="lp-example-head">
              <span className="faint">Example plan</span>
              <span className="badge up">BUY pullback</span>
            </div>
            <PlanLadder p={EXAMPLE_PLAN} dec={2} />
            <div className="lp-odds-bar">
              <div className="row" style={{ justifyContent: "space-between", fontSize: "0.86rem" }}>
                <span className="muted">Chance the target is hit first</span>
                <span className="num" style={{ fontWeight: 700, color: "var(--good)" }}>41% vs 39% needed</span>
              </div>
              <div className="prob-bar" style={{ marginTop: 8 }}>
                <i style={{ width: "41%" }} />
                <b style={{ left: "39%" }} title="Break-even win rate" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section" id="pricing">
        <div className="container">
          <div className="row wrap lp-pricing-head">
            <div>
              <p className="eyebrow">Pricing</p>
              <h2 className="lp-h2" style={{ margin: "8px 0 0" }}>Start with {days} days of everything</h2>
            </div>
            <MonthsToggle months={months} setMonths={setMonths} plans={plans} />
          </div>
          <div style={{ marginTop: 28 }}>
            <PricingCards plans={plans} months={months} />
          </div>
        </div>
      </section>

      <section className="lp-section" id="faq">
        <div className="container lp-faq">
          <p className="eyebrow">FAQ</p>
          <h2 className="lp-h2">Questions, answered</h2>
          <div className="lp-faq-list">
            {FAQ.map(([q, a]) => (
              <details key={q} className="lp-faq-item">
                <summary>{q} <Icon name="chevronDown" size={16} /></summary>
                <div className="muted">{a}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section lp-final">
        <div className="container">
          <h2 className="lp-h2">Your next chart deserves a second opinion.</h2>
          <Link className="btn primary lg" href={primaryHref}><Icon name="zap" size={18} /> {user ? "Open my terminal" : "Start my free trial"}</Link>
        </div>
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

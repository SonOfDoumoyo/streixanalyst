"use client";
import { useEffect, useState } from "react";
import LegalPage from "@/components/Legal";
import { get } from "@/lib/api";

// The Terms text lives here so it is easy to edit. Bump TERMS_VERSION in .env when you change it, so every
// new sign-up records the version they agreed to.
export default function TermsPage() {
  const [site, setSite] = useState(null);
  useEffect(() => { get("/site").then(setSite).catch(() => setSite({})); }, []);
  const trial = (site && site.trial_days) || 30;
  return (
    <LegalPage title="Terms of Service" updated={site ? site.terms_version : null}>
      <h2>1. Who we are</h2>
      <p>StreixAnalyst is an analysis product owned and run by Streixcorp (“we”, “us”). These Terms are the agreement between you and us when you create an account or use the app.</p>

      <h2>2. Not financial advice</h2>
      <p>StreixAnalyst shows analysis, probabilities, trade plans, practice scores and education. It does not tell you what to buy or sell, and nothing in it is financial, investment, legal or tax advice. Trading carries a high risk of losing money, including all of it. You are responsible for your own decisions. Paper-trade first and only risk what you can afford to lose.</p>
      <p>Probabilities are estimates from past data. They are not guarantees. Our track record page shows real results, including the calls that lost.</p>

      <h2>3. Your account</h2>
      <p>You must be at least 18 years old. Give accurate information, keep your password private and tell us if you think someone else has used your account. You are responsible for activity on your account.</p>

      <h2>4. Free trial, plans and prices</h2>
      <p>Every new account gets a {trial}-day free trial with every feature. After the trial, the Free plan stays free with daily limits. Paid plans are:</p>
      <ul>
        <li><b>Pro</b>: US $15 per month, for one person.</li>
        <li><b>Organization</b>: US $30 per month, one flat price for the whole organization, with every member included.</li>
      </ul>
      <p>Prices are in US dollars. Card and bank payments are charged in naira at the exchange rate shown at checkout. Paid plans are paid in advance for the period you choose (1, 3 or 12 months, with the discount shown). They do not renew automatically.</p>

      <h2>5. Payments and access</h2>
      <p>Payments are processed by our payment providers (currently Paystack and OPay) or confirmed by bank transfer. Paid features unlock only after the payment is verified. If a payment is not confirmed, the plan does not change.</p>

      <h2>6. Refunds</h2>
      <p>StreixAnalyst is a digital service and access starts as soon as your payment is confirmed. Refunds are not given once access has been used, except where the law requires them or where a payment was taken in error. If you think you were charged by mistake, contact us within 7 days.</p>

      <h2>7. Organizations and members</h2>
      <p>The person who creates an organization is its owner. Owners can add and remove members by email, and members can leave at any time. The owner is responsible for the members they add. When an organization&apos;s plan ends, members lose the organization features but keep their own account.</p>

      <h2>8. Acceptable use</h2>
      <p>Do not share accounts, resell access, scrape or copy the app, try to break or overload the service, use the AI to produce content that breaks the law, or harass other people. We may suspend accounts that break these rules.</p>

      <h2>9. Your data and learning</h2>
      <p>Our Privacy Policy explains what we collect. You choose separately whether we may learn from your chart analyses and practice attempts to improve the model. That choice is optional, and you can ask us to stop at any time. We never train on your personal details.</p>

      <h2>10. Content and ownership</h2>
      <p>The app, its analysis engine, models, design and brand belong to Streixcorp. Drawings and notes you make are yours. You give us permission to store and process them so the service can work for you.</p>

      <h2>11. Availability and changes</h2>
      <p>We work to keep the service fast and available, but markets, data providers and third-party services can fail. We may change features, prices and these Terms. For important changes we will tell you in the app or by email before they apply.</p>

      <h2>12. Ending the agreement</h2>
      <p>You can stop using StreixAnalyst at any time. We can suspend or close an account that breaks these Terms.</p>

      <h2>13. Governing law</h2>
      <p>These Terms are governed by the laws of the Federal Republic of Nigeria.</p>

      <h2>14. Contact</h2>
      <p>Write to us on the <a href="/contact">Contact page</a>.</p>
    </LegalPage>
  );
}

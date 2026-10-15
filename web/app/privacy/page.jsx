"use client";
import { useEffect, useState } from "react";
import LegalPage from "@/components/Legal";
import { get } from "@/lib/api";

export default function PrivacyPage() {
  const [site, setSite] = useState(null);
  useEffect(() => { get("/site").then(setSite).catch(() => setSite({})); }, []);
  return (
    <LegalPage title="Privacy Policy" updated={site ? site.terms_version : null}>
      <p>This policy explains what StreixAnalyst collects, why, and what you can do about it. It is written to fit the Nigeria Data Protection Act 2023. Streixcorp is the data controller.</p>

      <h2>What we collect</h2>
      <ul>
        <li><b>Account details:</b> your name, email, password (stored only as a one-way hash), experience level, and optional phone number.</li>
        <li><b>Sign-in with Google or LinkedIn:</b> the name, email and profile picture those services share with us.</li>
        <li><b>Use of the app:</b> the symbols and timeframes you look at, analyses you run, drawings you make, practice attempts, alerts and strategy runs.</li>
        <li><b>Payments:</b> the amount, plan, method and a payment reference. We do not store card numbers; the payment provider does.</li>
        <li><b>Acceptance records:</b> when you accepted the Terms, which version, and whether you agreed to learning.</li>
      </ul>

      <h2>Why we use it</h2>
      <ul>
        <li>To run your account, your plan, your limits and your trial.</li>
        <li>To run analyses, show your charts and keep your settings.</li>
        <li>To process payments and unlock the plan you paid for.</li>
        <li>To keep the service secure and to answer support requests.</li>
        <li>To improve the model, but only for accounts that opted in. Learning uses your chart analyses and practice attempts, not your name or email.</li>
      </ul>

      <h2>Who we share it with</h2>
      <p>We share data only with the services we need to run StreixAnalyst: payment providers (Paystack, OPay), the AI service that writes analyses (Anthropic, when enabled), email delivery, and Google or LinkedIn when you sign in with them. We do not sell your personal data.</p>

      <h2>How long we keep it</h2>
      <p>We keep account data while your account exists. Payment records are kept as long as the law requires. Analyses and practice attempts are kept while your account exists, unless you ask us to delete them.</p>

      <h2>Your choices</h2>
      <ul>
        <li>Ask us for a copy of your data.</li>
        <li>Ask us to correct or delete your data.</li>
        <li>Withdraw your consent to learning at any time. Withdrawing does not affect the rest of the service.</li>
      </ul>
      <p>Write to us on the <a href="/contact">Contact page</a>. We will reply within a reasonable time.</p>

      <h2>Cookies</h2>
      <p>We use one session cookie to keep you signed in. We do not use advertising cookies.</p>

      <h2>Security</h2>
      <p>Passwords are hashed, connections use HTTPS, and admin actions are logged. No system is perfectly secure, so keep your password private.</p>

      <h2>Children</h2>
      <p>StreixAnalyst is for people aged 18 and over. Do not create an account if you are younger.</p>
    </LegalPage>
  );
}

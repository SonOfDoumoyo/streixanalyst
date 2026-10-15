"use client";
import { useEffect, useState } from "react";
import LegalPage from "@/components/Legal";
import { get } from "@/lib/api";

/** Contact details come from the server (.env), so they can change without a new release. */
export default function ContactPage() {
  const [site, setSite] = useState(null);
  useEffect(() => { get("/site").then(setSite).catch(() => setSite({ contact: {} })); }, []);
  const c = (site && site.contact) || {};
  const rows = [
    c.phone && ["Phone", <a key="p" href={`tel:${c.phone.replace(/\s+/g, "")}`}>{c.phone}</a>],
    c.email && ["Email", <a key="e" href={`mailto:${c.email}`}>{c.email}</a>],
    c.company_email && ["Company email", <a key="ce" href={`mailto:${c.company_email}`}>{c.company_email}</a>],
    c.github && ["GitHub", <a key="g" href={`https://github.com/${c.github.replace(/^@/, "")}`} target="_blank" rel="noreferrer">@{c.github.replace(/^@/, "")}</a>],
    c.linkedin && ["LinkedIn", <a key="l" href={c.linkedin} target="_blank" rel="noreferrer">Profile</a>],
  ].filter(Boolean);
  return (
    <LegalPage title="Contact us">
      <p>We read every message. For account or payment problems, include the email on your account and, if you have one, the payment reference.</p>
      {site === null ? <p className="faint">Loading contact details…</p> : rows.length === 0 ? (
        <p className="faint">Contact details will appear here once they are set up.</p>
      ) : (
        <table className="table" style={{ maxWidth: 520 }}>
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}><th style={{ textAlign: "left", width: 150 }}>{label}</th><td>{value}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </LegalPage>
  );
}

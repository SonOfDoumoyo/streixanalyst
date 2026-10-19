"use client";
// Email confirmation for signed-in accounts. The server decides (user.email_verified, from /auth/me).
// The banner stays up while the email is unconfirmed; when an action is refused for that reason (lib/api.js
// announces it), a dialog asks the person to confirm before they continue. Hidden on the sign-in pages and when
// no email server is set up (then every account counts as confirmed).
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/components/Providers";
import { Modal } from "@/components/ui";
import { post } from "@/lib/api";

const QUIET = ["/verify", "/login", "/signup", "/terms", "/privacy", "/contact", "/forgot", "/reset"];

export default function VerifyGate() {
  const { user, toast } = useAuth();
  const path = usePathname() || "/";
  const [busy, setBusy] = useState(false);
  const [askOpen, setAskOpen] = useState(false);

  useEffect(() => {
    const open = () => setAskOpen(true);
    window.addEventListener("streix:email-unverified", open);
    return () => window.removeEventListener("streix:email-unverified", open);
  }, []);

  if (!user || user.email_verified !== false) return null;

  const resend = async () => {
    setBusy(true);
    try {
      const d = await post("/auth/resend-verification");
      toast(d.message, "success");
    } catch (e) {
      toast(e.message || "Couldn't send the link. Try again shortly.", "error");
    } finally {
      setBusy(false);
    }
  };

  const banner = QUIET.some((p) => path === p || path.startsWith(`${p}/`)) ? null : (
    <div role="status" style={{ position: "sticky", top: 0, zIndex: 40, display: "flex", gap: 12, alignItems: "center", justifyContent: "center", flexWrap: "wrap", padding: "8px 16px", borderBottom: "1px solid var(--line, #26324a)", background: "var(--bg-2, #111827)", fontSize: "0.88rem" }}>
      <span>Confirm your email to use StreixAnalyst and to pay for a plan. Check your inbox for the link.</span>
      <button className="btn sm" disabled={busy} onClick={resend}>Resend link</button>
    </div>
  );

  return (
    <>
      {banner}
      <Modal
        open={askOpen}
        onClose={() => setAskOpen(false)}
        title="Confirm your email to continue"
        subtitle={`This action is locked until ${user.email ? user.email : "your email"} is confirmed.`}
        footer={<>
          <button className="btn" onClick={() => setAskOpen(false)}>Not now</button>
          <button className="btn primary" disabled={busy} onClick={resend}>Send me a new link</button>
        </>}
      >
        <p className="muted" style={{ margin: "0 0 4px" }}>
          Open the link in the email we sent you, then try again. Links last 48 hours.
        </p>
      </Modal>
    </>
  );
}

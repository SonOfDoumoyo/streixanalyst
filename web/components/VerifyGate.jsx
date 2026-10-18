"use client";
// A slim reminder for accounts whose email isn't confirmed yet. The server decides (user.email_verified, read from
// /auth/me). Hidden on the sign-in pages and when no email server is set up (then every account counts as confirmed).
import { useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/components/Providers";
import { post } from "@/lib/api";

const QUIET = ["/verify", "/login", "/signup", "/terms", "/privacy", "/contact", "/forgot", "/reset"];

export default function VerifyGate() {
  const { user, toast } = useAuth();
  const path = usePathname() || "/";
  const [busy, setBusy] = useState(false);
  if (!user || user.email_verified !== false || QUIET.some((p) => path === p || path.startsWith(`${p}/`))) return null;

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

  return (
    <div role="status" style={{ position: "sticky", top: 0, zIndex: 40, display: "flex", gap: 12, alignItems: "center", justifyContent: "center", flexWrap: "wrap", padding: "8px 16px", borderBottom: "1px solid var(--line, #26324a)", background: "var(--bg-2, #111827)", fontSize: "0.88rem" }}>
      <span>Confirm your email to keep your account safe and to pay for a plan. Check your inbox for the link.</span>
      <button className="btn sm" disabled={busy} onClick={resend}>Resend link</button>
    </div>
  );
}

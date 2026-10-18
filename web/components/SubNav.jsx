"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Brand, { Mark } from "@/components/Brand";
import Icon from "@/components/Icons";
import { useAuth } from "@/components/Providers";
import { Menu } from "@/components/ui";
import AlertsBell from "@/components/AlertsBell";
import UsageMeter from "@/components/UsageMeter";
import { initials } from "@/lib/format";

export const APP_LINKS = [
  ["/terminal", "Terminal", "candles"],
  ["/ai", "StreixAI", "sparkles"],
  ["/practice", "Draw & score", "target"],
  ["/strategy", "Strategy lab", "sliders"],
  ["/track-record", "Track record", "shield"],
];

export function AvatarMenu({ extra = null }) {
  const { user, logout, settings, updateSettings } = useAuth();
  const [open, setOpen] = useState(false);
  if (!user) {
    return (
      <div className="row" style={{ gap: 6 }}>
        <Link href="/login" className="btn sm ghost">Sign in</Link>
        <Link href="/signup" className="btn sm primary">Start free</Link>
      </div>
    );
  }
  const ent = user && user.entitlements;
  return (
    <div style={{ position: "relative" }}>
      <button className="avatar" style={{ cursor: "pointer", padding: 0 }} onClick={() => setOpen(!open)} aria-label="Account menu">
        {user && user.avatar_url ? <img src={user.avatar_url} alt="" referrerPolicy="no-referrer" /> : initials(user && user.name)}
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorStyle={{ top: 44, right: 0 }}>
        <div style={{ padding: "8px 10px" }}>
          <b>{user && user.name}</b>
          <div className="faint" style={{ fontSize: "0.8rem" }}>{user && user.email}</div>
          {ent ? <div style={{ marginTop: 6 }}><span className="badge brand" style={{ textTransform: "capitalize" }}>{ent.tier}{ent.tier === "trial" ? ` · ${ent.trial_days_left} days left` : ""}</span></div> : null}
        </div>
        <UsageMeter />
        <hr />
        {APP_LINKS.map(([href, label, ic]) => <Link key={href} href={href}><Icon name={ic} size={16} /> {label}</Link>)}
        <hr />
        {extra}
        <Link href="/settings"><Icon name="settings" size={16} /> Settings</Link>
        <Link href="/billing"><Icon name="card" size={16} /> Plan & billing</Link>
        <Link href="/support"><Icon name="info" size={16} /> Support</Link>
        <Link href="/donate"><Icon name="star" size={16} /> Donate</Link>
        {user && user.role === "admin" ? <Link href="/admin"><Icon name="shield" size={16} /> Admin</Link> : null}
        <button onClick={() => updateSettings({ theme: settings.theme === "light" ? "dark" : "light" })}>
          <Icon name={settings.theme === "light" ? "moon" : "sun"} size={16} /> {settings.theme === "light" ? "Dark" : "Light"} interface
        </button>
        <hr />
        <button onClick={logout}><Icon name="logout" size={16} /> Sign out</button>
      </Menu>
    </div>
  );
}

/** Top bar for the app's secondary workspaces (practice, strategy lab, track record). */
export default function SubNav({ children, mobile, bell = null }) {
  const path = usePathname();
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const f = () => setWide(window.innerWidth >= 1100);
    f();
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return (
    <header className="topbar">
      {mobile ? <Link href="/" aria-label="Home"><Mark size={34} /></Link> : <Brand href="/" size={34} compact={!wide} />}
      <span className="sep hide-mobile" />
      <nav className="topnav hide-mobile">
        {APP_LINKS.map(([href, label, ic]) => (
          <Link key={href} href={href} className={`tv-tab${path === href ? " on" : ""}`}>
            <Icon name={ic} size={15} /> {label}
          </Link>
        ))}
      </nav>
      {children}
      <div className="grow" />
      {bell || <AlertsBell />}
      <AvatarMenu />
    </header>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/Icons";
import { useAuth } from "@/components/Providers";
import { Mark } from "@/components/Brand";

export function useClickOutside(ref, onOutside, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onOutside(e);
    };
    document.addEventListener("pointerdown", h, true);
    return () => document.removeEventListener("pointerdown", h, true);
  }, [ref, onOutside, active]);
}

export function Modal({ open, onClose, title, subtitle, children, wide = false, footer }) {
  useEffect(() => {
    if (!open) return undefined;
    const k = (e) => e.key === "Escape" && onClose && onClose();
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", k);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <div className="row" style={{ alignItems: "flex-start", marginBottom: 14 }}>
          <div className="grow">
            {title ? <h3>{title}</h3> : null}
            {subtitle ? <div className="muted" style={{ fontSize: "0.9rem" }}>{subtitle}</div> : null}
          </div>
          {onClose ? (
            <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
          ) : null}
        </div>
        {children}
        {footer ? <div className="row" style={{ justifyContent: "flex-end", marginTop: 18, gap: 8 }}>{footer}</div> : null}
      </div>
    </div>
  );
}

export function Menu({ open, onClose, anchorStyle, children, className = "" }) {
  const ref = useRef(null);
  useClickOutside(ref, () => onClose && onClose(), open);
  useEffect(() => {
    if (!open) return undefined;
    const k = (e) => e.key === "Escape" && onClose && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className={`menu glass ${className}`} style={anchorStyle}>
      {children}
    </div>
  );
}

export function Spinner({ dark = true, size }) {
  return <span className={`spinner ${dark ? "dark" : ""}`} style={size ? { width: size, height: size } : undefined} />;
}

export function FullScreenLoader({ text = "Loading" }) {
  return (
    <div style={{ height: "100dvh", display: "grid", placeItems: "center" }} className="page-bg">
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
        <div style={{ animation: "pulse 1.4s infinite" }}><Mark size={84} /></div>
        <div className="muted" style={{ fontSize: "0.9rem" }}>{text}…</div>
      </div>
    </div>
  );
}

/** Pages that need an account: sends signed-out visitors to /login and new OAuth users to /onboarding. */
export function RequireAuth({ children, admin = false }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (loading) return;
    const here = window.location.pathname + window.location.search;
    if (!user) router.replace(`/login?next=${encodeURIComponent(here)}`);
    else if (user.needs_onboarding && !here.startsWith("/onboarding")) router.replace(`/onboarding?next=${encodeURIComponent(here)}`);
    else if (admin && user.role !== "admin") router.replace("/terminal");
    else setOk(true);
  }, [user, loading, admin, router]);
  if (!ok) return <FullScreenLoader text="Getting your workspace ready" />;
  return children;
}

export function Field({ label, hint, error, children, htmlFor }) {
  return (
    <div className="field">
      {label ? <label htmlFor={htmlFor}>{label}</label> : null}
      {children}
      {error ? <div className="error-text">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Empty({ icon = "info", title, children }) {
  return (
    <div className="empty">
      <Icon name={icon} />
      {title ? <div style={{ fontWeight: 700, color: "var(--text-2)", marginBottom: 4 }}>{title}</div> : null}
      <div style={{ fontSize: "0.88rem" }}>{children}</div>
    </div>
  );
}

/** Tiny, safe Markdown renderer for StreixAI answers (bold, italics, code, headings, lists, links). */
export function Markdown({ text }) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let list = null;
  const flush = () => {
    if (list) blocks.push(list);
    list = null;
  };
  lines.forEach((ln) => {
    const m = ln.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
    if (m) {
      const ordered = /\d/.test(m[1]);
      if (!list || list.ordered !== ordered) {
        flush();
        list = { type: "list", ordered, items: [] };
      }
      list.items.push(m[2]);
      return;
    }
    flush();
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) blocks.push({ type: "h", text: h[2] });
    else if (ln.trim() === "") blocks.push({ type: "br" });
    else blocks.push({ type: "p", text: ln });
  });
  flush();
  const merged = [];
  blocks.forEach((b) => {
    const last = merged[merged.length - 1];
    if (b.type === "p" && last && last.type === "p") last.text += "\n" + b.text;
    else if (!(b.type === "br" && (!last || last.type === "br"))) merged.push(b);
  });
  return (
    <div className="md">
      {merged.map((b, i) => {
        if (b.type === "h") return <h4 key={i}>{inline(b.text)}</h4>;
        if (b.type === "p") return <p key={i}>{b.text.split("\n").map((t, j) => <span key={j}>{j ? <br /> : null}{inline(t)}</span>)}</p>;
        if (b.type === "list") {
          const Tag = b.ordered ? "ol" : "ul";
          return <Tag key={i}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</Tag>;
        }
        return null;
      })}
    </div>
  );
}

function inline(s) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_|\*[^*]+\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("[")) {
      const label = t.slice(1, t.indexOf("]"));
      out.push(<a key={k++} href={m[2]} target="_blank" rel="noopener noreferrer">{label}</a>);
    } else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

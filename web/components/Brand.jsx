"use client";
import Link from "next/link";

/**
 * The S + A mark (Streixcorp S blades with the StreixAnalyst A), in one colour that follows the theme:
 * white on the dark theme, black on the light theme. The crossbar of the A is cut out in the background colour.
 */
export function Mark({ size = 38, className = "", title = "StreixAnalyst" }) {
  return (
    <svg viewBox="0 0 184 96" width={size} height={(size * 96) / 184} className={className} role="img" aria-label={title}
         fill="none" style={{ color: "var(--text)" }}>
      <path d="M53 6 H88 L59 37 Q55 41.5 49 41.5 H16 L45 10.5 Q48.5 6 53 6 Z" fill="currentColor" />
      <path d="M59 48.5 H92 L63 85.5 Q59.5 90 53.5 90 H20 L50 53 Q53.5 48.5 59 48.5 Z" fill="currentColor" />
      <path fillRule="evenodd" d="M126.5 6 H145.5 L172 90 H157.5 L152.6 74.5 H120.4 L115.5 90 H101 Z M124.2 62.5 H148.8 L136.5 23.5 Z" fill="currentColor" />
      <path d="M136 6 H145.5 L172 90 H157.5 L136.5 23.5 Z" fill="currentColor" />
      <path d="M121.6 62.5 H156.6 L153.9 74.5 H117.9 Z" fill="var(--bg)" />
    </svg>
  );
}

export function Wordmark({ compact = false }) {
  return (
    <span className="brand-word">
      STREIX<b>{compact ? "A" : "ANALYST"}</b>
    </span>
  );
}

export default function Brand({ href = "/", compact = false, size = 38, hideWordOnMobile = false }) {
  return (
    <Link href={href} className="brand" aria-label="StreixAnalyst home">
      <Mark size={size} className="brand-mark" />
      <span className={hideWordOnMobile ? "hide-mobile" : ""}>
        <Wordmark compact={compact} />
      </span>
    </Link>
  );
}

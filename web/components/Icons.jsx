// One small, consistent icon set (24×24, stroke = currentColor). No icon library needed.

const P = {
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></>,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m6 15 6-6 6 6" />,
  chevronLeft: <path d="m15 6-6 6 6 6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  more: <><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 7.4M21.5 20a6.5 6.5 0 0 0-4-6" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>,
  sparkles: <><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8zM5 15l.6 1.4L7 17l-1.4.6L5 19l-.6-1.4L3 17l1.4-.6z" /></>,
  candles: <><path d="M7 3v4M7 17v4M17 3v6M17 17v4" /><rect x="5" y="7" width="4" height="10" rx="1" /><rect x="15" y="9" width="4" height="8" rx="1" /></>,
  list: <><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></>,
  news: <><path d="M4 5h13v14a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z" /><path d="M17 9h3v10a2 2 0 0 1-4 0M8 9h5M8 13h5M8 17h3" /></>,
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>,
  tv: <><rect x="2" y="5" width="20" height="13" rx="2" /><path d="M8 22h8M12 18v4" /></>,
  maximize: <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />,
  minimize: <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />,
  trash: <><path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></>,
  lock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  unlock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-2" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-6.5 0-10-7-10-7a18 18 0 0 1 4.1-5M9.9 4.2A9.6 9.6 0 0 1 12 4c6.5 0 10 8 10 8a18 18 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2" /><path d="M2 2l20 20" /></>,
  magnet: <><path d="M6 3v8a6 6 0 0 0 12 0V3" /><path d="M6 7h4M14 7h4M10 3v8a2 2 0 0 0 4 0V3" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>,
  cursor: <path d="M5 3l14 7-6 1.8L11 19z" />,
  crosshair: <><circle cx="12" cy="12" r="8" /><path d="M12 2v5M12 17v5M2 12h5M17 12h5" /></>,
  trendline: <><path d="M5 19 19 5" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="5" r="2" /></>,
  ray: <><path d="M5 19 21 3" /><circle cx="5" cy="19" r="2" /><circle cx="12" cy="12" r="2" /></>,
  extline: <><path d="M2 22 22 2" /><circle cx="9" cy="15" r="2" /><circle cx="15" cy="9" r="2" /></>,
  hline: <><path d="M2 12h20" /><circle cx="12" cy="12" r="2" /></>,
  hray: <><path d="M8 12h14" /><circle cx="6" cy="12" r="2" /></>,
  vline: <><path d="M12 2v20" /><circle cx="12" cy="12" r="2" /></>,
  rect: <><rect x="4" y="6" width="16" height="12" rx="1" /><circle cx="4" cy="6" r="1.6" /><circle cx="20" cy="18" r="1.6" /></>,
  channel: <><path d="M3 17 17 5M7 21 21 9" /></>,
  fib: <><path d="M3 5h18M3 10h18M3 14h18M3 19h18" /><path d="M5 19 19 5" strokeDasharray="2 2" /></>,
  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  arrow: <><path d="M5 19 19 5" /><path d="M10 5h9v9" /></>,
  long: <><rect x="4" y="4" width="16" height="9" rx="1" fill="rgba(38,166,154,.25)" /><rect x="4" y="13" width="16" height="7" rx="1" fill="rgba(239,83,80,.25)" /></>,
  short: <><rect x="4" y="4" width="16" height="7" rx="1" fill="rgba(239,83,80,.25)" /><rect x="4" y="11" width="16" height="9" rx="1" fill="rgba(38,166,154,.25)" /></>,
  ruler: <><path d="M3 17 17 3l4 4L7 21z" /><path d="M7 13l2 2M10 10l2 2M13 7l2 2" /></>,
  note: <><path d="M4 4h16v12l-4 4H4z" /><path d="M16 20v-4h4M8 9h8M8 13h5" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>,
  sliders: <><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  check: <path d="m5 12 5 5L20 7" />,
  alert: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  refresh: <><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8" /><path d="M21 3v5h-5M3 21v-5h5" /></>,
  send: <><path d="M22 2 11 13" /><path d="m22 2-7 20-4-9-9-4z" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5M12 3v12" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5M12 15V3" /></>,
  card: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20M6 15h4" /></>,
  bank: <><path d="M3 10h18L12 4z" /><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18" /></>,
  phone: <><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M11 18h2" /></>,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>,
  star: <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />,
  flame: <path d="M12 22c4.4 0 7-3 7-7 0-4-3-7-5-10-.5 2.5-2 4-3.5 4.5C9 8 8.5 6 9 4 6.5 6 5 9.5 5 15c0 4 2.6 7 7 7z" />,
  play: <path d="M7 4v16l13-8z" />,
  pause: <path d="M7 4h4v16H7zM15 4h4v16h-4z" />,
  book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" /><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" /></>,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
  zap: <path d="M13 2 3 14h9l-1 8 10-12h-9z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  external: <><path d="M14 3h7v7M21 3l-9 9" /><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  camera: <><path d="M3 8a2 2 0 0 1 2-2h2l2-3h6l2 3h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><circle cx="12" cy="13" r="4" /></>,
  building: <><rect x="4" y="2" width="16" height="20" rx="1" /><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01" /></>,
  palette: <><circle cx="13.5" cy="6.5" r="1.3" /><circle cx="17.5" cy="10.5" r="1.3" /><circle cx="8.5" cy="7.5" r="1.3" /><circle cx="6.5" cy="12.5" r="1.3" /><path d="M12 2a10 10 0 0 0 0 20c1.7 0 2-1.3 1.5-2.5-.6-1.4.3-2.5 1.7-2.5H17a5 5 0 0 0 5-5C22 6 17.5 2 12 2z" /></>,
  home: <><path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 22V12h6v10" /></>,
  pen: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  google: null,
  linkedin: null,
  dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
  arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
  arrowDown: <path d="M12 5v14M19 12l-7 7-7-7" />,
  fit: <><path d="M3 9V5a2 2 0 0 1 2-2h4M21 9V5a2 2 0 0 0-2-2h-4M3 15v4a2 2 0 0 0 2 2h4M21 15v4a2 2 0 0 1-2 2h-4" /><path d="M7 15l3-3 2 2 5-5" /></>,
  indicator: <><path d="M3 17c3-6 5-6 7-3s4 3 6-2 3-6 5-6" /><path d="M3 21h18" /></>,
  review: <><path d="M9 11l3 3 8-8" /><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" /></>,
};

export function Icon({ name, size, className, style, title, strokeWidth = 1.8 }) {
  if (name === "google") {
    return (
      <svg viewBox="0 0 48 48" width={size || 18} height={size || 18} className={className} style={style} aria-hidden={!title}>
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z" />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
      </svg>
    );
  }
  if (name === "linkedin") {
    return (
      <svg viewBox="0 0 24 24" width={size || 18} height={size || 18} className={className} style={style} aria-hidden={!title}>
        <rect width="24" height="24" rx="4" fill="#0A66C2" />
        <path fill="#fff" d="M7.1 9.5H4.6V19h2.5zM5.9 5a1.45 1.45 0 1 0 0 2.9 1.45 1.45 0 0 0 0-2.9zM19.4 13.7c0-2.6-.6-4.5-3.6-4.5-1.5 0-2.4.8-2.8 1.5V9.5h-2.4V19h2.5v-4.7c0-1.2.2-2.4 1.8-2.4 1.5 0 1.5 1.4 1.5 2.5V19h2.5z" />
      </svg>
    );
  }
  const d = P[name];
  if (!d) return null;
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} className={className} style={style} fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden={!title} role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {d}
    </svg>
  );
}

export default Icon;

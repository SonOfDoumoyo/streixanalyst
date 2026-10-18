// Talks to the FastAPI backend through /api on the same site (Next.js rewrites it), so the session cookie
// is first-party. Every state-changing call carries X-Requested-With (the backend's CSRF check).

export const API_BASE = "/api";

export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.code = detail && typeof detail === "object" ? detail.code : undefined;
  }
}

function messageFrom(data, status) {
  const d = data && data.detail;
  if (typeof d === "string") return d;
  if (d && typeof d === "object" && !Array.isArray(d) && d.message) return d.message;
  if (Array.isArray(d) && d.length) {
    return d.map((x) => {
      const field = Array.isArray(x.loc) ? x.loc[x.loc.length - 1] : "";
      const msg = String(x.msg || "").replace(/^Value error, /, "");
      return field && field !== "body" ? `${field}: ${msg}` : msg;
    }).join(" · ");
  }
  if (status === 0) return "You're offline or the server can't be reached.";
  if (status >= 500) return "The server had a problem. Please try again in a moment.";
  return `Request failed (${status}).`;
}

export async function api(path, { method = "GET", body, form, signal, headers = {} } = {}) {
  const h = { "X-Requested-With": "streix", ...headers };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    h["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers: h, body: payload, credentials: "include", signal, cache: "no-store" });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new ApiError(messageFrom(null, 0), 0, null);
  }
  let data = null;
  const text = await res.text();
  if (text) {
    // a plain-text body (for example "Internal Server Error" from a proxy) is never shown raw; the status decides the message
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) throw new ApiError(messageFrom(data, res.status), res.status, data && data.detail);
  return data;
}

export const get = (p, o) => api(p, { ...o, method: "GET" });
export const post = (p, body, o) => api(p, { ...o, method: "POST", body: body === undefined ? {} : body });
export const put = (p, body, o) => api(p, { ...o, method: "PUT", body });
export const patch = (p, body, o) => api(p, { ...o, method: "PATCH", body });
export const del = (p, o) => api(p, { ...o, method: "DELETE" });

/** POST that answers with server-sent events (StreixAI). onEvent receives each parsed `data:` object. */
export async function stream(path, body, onEvent, signal) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method: "POST", credentials: "include", signal,
      headers: { "Content-Type": "application/json", "X-Requested-With": "streix", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new ApiError(messageFrom(null, 0), 0, null);
  }
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    throw new ApiError(messageFrom(data, res.status), res.status, data && data.detail);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data:")) {
          try { onEvent(JSON.parse(line.slice(5).trim())); } catch { /* ignore partial */ }
        }
      }
    }
  }
}

export const qs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

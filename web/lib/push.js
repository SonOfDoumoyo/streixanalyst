// Phone alerts (Web push). The browser keeps a push subscription for this device, and the server sends alerts to it.
import { get, post } from "@/lib/api";

export function pushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function keyBytes(b64) {
  const padded = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function readyRegistration() {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

/** "on", "off" or "unsupported" for this device. */
export async function currentPushState() {
  if (!pushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub ? "on" : "off";
}

/** Asks for permission, subscribes this device and tells the server. Call it from a click. */
export async function enablePush() {
  if (!pushSupported()) throw new Error("This browser can't show phone alerts.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications are blocked for this site. Allow them in your browser settings, then try again.");
  }
  const info = await get("/push");
  if (!info.available || !info.public_key) throw new Error("Phone alerts aren't switched on for this server yet.");
  const reg = await readyRegistration();
  const old = await reg.pushManager.getSubscription();
  if (old) {
    // an old subscription may use a key the server no longer has, so start again with a fresh one
    await post("/push/unsubscribe", { endpoint: old.endpoint }).catch(() => {});
    await old.unsubscribe();
  }
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.public_key) });
  const j = sub.toJSON();
  await post("/push/subscribe", { endpoint: j.endpoint, keys: j.keys });
  return true;
}

export async function disablePush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await post("/push/unsubscribe", { endpoint }).catch(() => {});
}

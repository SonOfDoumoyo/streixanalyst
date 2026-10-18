"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { get, patch, post } from "@/lib/api";
import { DEFAULT_SETTINGS, loadLocalSettings, mergeSettings, saveLocalSettings } from "@/lib/settings";
import Icon from "@/components/Icons";
import LoadingGlass from "@/components/LoadingGlass";
import TermsGate from "@/components/TermsGate";
import VerifyGate from "@/components/VerifyGate";

const AuthCtx = createContext(null);
const ToastCtx = createContext(() => {});

export function useAuth() {
  return useContext(AuthCtx);
}

export function useToast() {
  return useContext(ToastCtx);
}

function ToastHost({ toasts, dismiss }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>
          <Icon name={t.type === "error" ? "alert" : t.type === "success" ? "check" : "info"} size={18}
            style={{ color: t.type === "error" ? "var(--down)" : t.type === "success" ? "var(--up)" : "var(--brand-2)", flex: "none", marginTop: 1 }} />
          <div className="grow">{t.msg}</div>
          <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export default function Providers({ children }) {
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out
  const [config, setConfig] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [toasts, setToasts] = useState([]);
  const saveTimer = useRef(null);

  const toast = useCallback((msg, type = "info", ms = 4500) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);
  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const applyUser = useCallback((u) => {
    setUser(u);
    const local = loadLocalSettings();
    const merged = mergeSettings(mergeSettings(DEFAULT_SETTINGS, local || {}), (u && u.settings) || {});
    setSettings(merged);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const d = await get("/auth/me");
      applyUser(d.user || null);
      return d.user || null;
    } catch {
      applyUser(null);
      return null;
    }
  }, [applyUser]);

  useEffect(() => {
    refresh();
    get("/config").then(setConfig).catch(() => setConfig(null));
  }, [refresh]);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", settings.theme === "light" ? "light" : "dark");
  }, [settings.theme]);

  const updateSettings = useCallback((fnOrPatch) => {
    setSettings((prev) => {
      const next = typeof fnOrPatch === "function" ? fnOrPatch(prev) : mergeSettings(prev, fnOrPatch);
      saveLocalSettings(next);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        patch("/auth/me", { settings: next }).catch(() => {});
      }, 1200);
      return next;
    });
  }, []);

  const logout = useCallback(async () => {
    try { await post("/auth/logout"); } catch { /* ignore */ }
    setUser(null);
    window.location.href = "/";
  }, []);

  const value = useMemo(() => ({
    user, loading: user === undefined, setUser: applyUser, refresh, logout, settings, updateSettings, config, toast,
    can: (f) => !!(user && user.entitlements && user.entitlements.features.includes(f)),
  }), [user, applyUser, refresh, logout, settings, updateSettings, config, toast]);

  return (
    <AuthCtx.Provider value={value}>
      <ToastCtx.Provider value={toast}>
        <LoadingGlass />
        {children}
        <TermsGate />
        <VerifyGate />
        <ToastHost toasts={toasts} dismiss={dismiss} />
      </ToastCtx.Provider>
    </AuthCtx.Provider>
  );
}

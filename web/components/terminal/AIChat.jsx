"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icons";
import { Mark } from "@/components/Brand";
import { Markdown } from "@/components/ui";
import { useAuth } from "@/components/Providers";
import { ApiError, del, get, stream } from "@/lib/api";
import { greeting, initials } from "@/lib/format";

export default function AIChat({ symbol, tf, analysisId, pending, clearPending, onLimit, compact = false }) {
  const { user, refresh } = useAuth();
  const [msgs, setMsgs] = useState([]);
  const [thread, setThread] = useState(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sugs, setSugs] = useState([]);
  const [threads, setThreads] = useState(null);
  const [provider, setProvider] = useState(null);
  const box = useRef(null);
  const ta = useRef(null);
  const ctl = useRef(null);

  useEffect(() => {
    get("/ai/suggestions").then((d) => { setSugs(d.suggestions || []); setProvider(d.provider); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [msgs]);

  const send = useCallback(async (text) => {
    const q = (text || "").trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "", streaming: true }]);
    ctl.current = new AbortController();
    try {
      await stream("/ai/chat", { message: q, thread_id: thread, symbol, tf, analysis_id: analysisId }, (ev) => {
        if (ev.t === "start") setThread(ev.thread_id);
        else if (ev.t === "meta") setProvider(ev.provider);
        else if (ev.t === "delta") setMsgs((m) => {
          const c = m.slice();
          const last = c[c.length - 1];
          c[c.length - 1] = { ...last, content: last.content + ev.v };
          return c;
        });
        else if (ev.t === "error") setMsgs((m) => {
          const c = m.slice();
          c[c.length - 1] = { role: "assistant", content: ev.v, error: true };
          return c;
        });
      }, ctl.current.signal);
    } catch (e) {
      if (e && e.name === "AbortError") {
        // stopped by the user
      } else {
        setMsgs((m) => m.slice(0, -2));
        if (e instanceof ApiError && (e.status === 429 || e.status === 402)) onLimit && onLimit(e);
        else setMsgs((m) => [...m, { role: "user", content: q }, { role: "assistant", content: e.message || "Something went wrong.", error: true }]);
      }
    } finally {
      setMsgs((m) => m.map((x) => (x.streaming ? { ...x, streaming: false } : x)));
      setBusy(false);
      refresh();
    }
  }, [busy, thread, symbol, tf, analysisId, onLimit, refresh]);

  useEffect(() => {
    if (pending) {
      send(pending);
      clearPending && clearPending();
    }
  }, [pending, send, clearPending]);

  const newChat = () => {
    if (ctl.current) ctl.current.abort();
    setMsgs([]);
    setThread(null);
    setThreads(null);
  };
  const openThreads = async () => {
    if (threads) return setThreads(null);
    try {
      const d = await get("/ai/threads");
      setThreads(d.threads || []);
    } catch { setThreads([]); }
  };
  const loadThread = async (id) => {
    const d = await get(`/ai/threads/${id}`);
    setMsgs(d.messages.map((m) => ({ role: m.role, content: m.content })));
    setThread(id);
    setThreads(null);
  };
  const removeThread = async (id) => {
    await del(`/ai/threads/${id}`);
    setThreads((t) => (t || []).filter((x) => x.thread_id !== id));
    if (id === thread) newChat();
  };
  const usage = user && user.entitlements ? user.entitlements : null;
  const left = usage && usage.limits.ai !== null ? Math.max(0, usage.limits.ai - (usage.usage.ai || 0)) : null;

  return (
    <div className="chat">
      <div className="row" style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)", gap: 6 }}>
        <div className="row grow" style={{ gap: 8, minWidth: 0 }}>
          <span style={{ width: 26, height: 26, borderRadius: 8, display: "grid", placeItems: "center", background: "linear-gradient(135deg,#1b3a72,#0a1d42)", border: "1px solid rgba(85,174,255,.35)" }}>
            <Mark size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: "0.9rem" }}>StreixAI</div>
            <div className="faint" style={{ fontSize: "0.72rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {analysisId ? `Reading your ${symbol} ${tf} analysis` : "Ask about trading or press Analyse for chart context"}
            </div>
          </div>
        </div>
        {left !== null ? <span className="badge" title="Messages left today">{left} left</span> : null}
        <button className="icon-btn" onClick={openThreads} title="Past conversations"><Icon name="clock" /></button>
        <button className="icon-btn" onClick={newChat} title="New conversation"><Icon name="plus" /></button>
      </div>
      {threads ? (
        <div style={{ borderBottom: "1px solid var(--line)", maxHeight: 260, overflowY: "auto" }}>
          {threads.length ? threads.map((t) => (
            <div key={t.thread_id} className="wl-row" style={{ gridTemplateColumns: "1fr auto" }} onClick={() => loadThread(t.thread_id)}>
              <div className="s" style={{ fontWeight: 600 }}>{t.title}</div>
              <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={(e) => { e.stopPropagation(); removeThread(t.thread_id); }} aria-label="Delete conversation">
                <Icon name="trash" size={14} />
              </button>
            </div>
          )) : <div className="empty">No conversations yet.</div>}
        </div>
      ) : null}
      <div className="chat-msgs" ref={box}>
        {!msgs.length ? (
          <div className="stack" style={{ gap: 14 }}>
            <div className="msg ai">
              <span className="av"><Mark size={20} /></span>
              <div className="bubble">
                <b>{greeting(user && user.first_name)}!</b> I'm StreixAI. I can explain any trading idea in plain words, walk you through this chart's analysis, check your risk and leverage, or help you build a strategy.
                {provider === "offline" ? <div className="hint" style={{ marginTop: 6 }}>Running on my built-in trading notes.</div> : null}
              </div>
            </div>
            {sugs.length ? (
              <div className="chips" style={{ paddingLeft: compact ? 0 : 40 }}>
                {sugs.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}
              </div>
            ) : null}
          </div>
        ) : null}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role === "user" ? "me" : "ai"}`}>
            <span className="av" style={m.role === "user" ? { background: "linear-gradient(135deg,#d97757,#b65d3f)", color: "#fff", fontSize: "0.72rem", fontWeight: 800 } : undefined}>
              {m.role === "user" ? initials(user && user.name) : <Mark size={20} />}
            </span>
            <div className="bubble" style={m.error ? { borderColor: "rgba(239,83,80,.4)" } : undefined}>
              {m.role === "user" ? m.content : m.content ? <Markdown text={m.content} /> : <span className="typing"><i /><i /><i /></span>}
            </div>
          </div>
        ))}
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <textarea ref={ta} value={input} placeholder={`Ask StreixAI${symbol ? ` about ${symbol}` : ""}…`} aria-label="Message StreixAI"
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = "44px";
            e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }} />
        {busy ? (
          <button type="button" className="btn" style={{ height: 44 }} onClick={() => ctl.current && ctl.current.abort()} aria-label="Stop"><Icon name="pause" size={16} /></button>
        ) : (
          <button type="submit" className="btn primary" style={{ height: 44, width: 48, padding: 0 }} disabled={!input.trim()} aria-label="Send"><Icon name="send" size={18} /></button>
        )}
      </form>
    </div>
  );
}

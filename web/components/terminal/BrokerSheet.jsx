"use client";
// Connect a broker, see the accounts connected, and set each one's safety limits. The keys go to the server once, are
// stored encrypted and are never shown again. Use keys that can trade but cannot withdraw.
import { useCallback, useEffect, useState } from "react";
import Icon from "@/components/Icons";
import Sheet from "@/components/terminal/Sheet";
import { useAuth } from "@/components/Providers";
import { ApiError, del, get, patch, post } from "@/lib/api";

const KIND_HELP = {
  mt: { title: "MetaTrader 4 / 5", about: "Most forex and gold brokers. Enter your MT login, trading password and your broker's server name (it's in your MT login screen). It's sent to MetaApi, our MetaTrader link, and isn't kept here." },
  oanda: { title: "OANDA", about: "In OANDA, open Manage API Access to make a token, and copy your account number (like 101-001-1234567-001)." },
  bybit: { title: "Bybit", about: "Make an API key in Bybit (API management) with Contract trading on and Withdrawals off. Uses USDT perpetual futures." },
  binance: { title: "Binance Futures", about: "Make an API key in Binance with Enable Futures on and Withdrawals off. Uses USDT-M futures. Binance sends one take profit." },
};
const FIELDS = {
  mt: [["login", "MT login number", "text"], ["password", "Trading password", "password"], ["server", "Broker server (e.g. ICMarketsSC-Demo)", "text"]],
  oanda: [["token", "API token", "password"], ["account_id", "Account number", "text"]],
  bybit: [["key", "API key", "text"], ["secret", "API secret", "password"]],
  binance: [["key", "API key", "text"], ["secret", "API secret", "password"]],
};
const LIMITS = {
  mt: [["max_size", "Largest order (lots)", "1"], ["auto_size", "Auto-send size (lots)", ""], ["max_orders_day", "Orders a day", "5"], ["symbol_suffix", "Symbol ending (if your broker adds one, e.g. m)", ""]],
  oanda: [["max_size", "Largest order (units)", "10000"], ["auto_size", "Auto-send size (units)", ""], ["max_orders_day", "Orders a day", "5"]],
  bybit: [["max_notional", "Largest order (USDT)", "1000"], ["auto_size", "Auto-send size (coins)", ""], ["max_orders_day", "Orders a day", "5"]],
  binance: [["max_notional", "Largest order (USDT)", "1000"], ["auto_size", "Auto-send size (coins)", ""], ["max_orders_day", "Orders a day", "5"]],
};

function money(info) {
  return info && Number.isFinite(info.balance) ? `${Number(info.balance).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${info.currency || ""}` : null;
}

function Limits({ kind, values, onChange }) {
  return (
    <div className="bk-limits">
      {LIMITS[kind].map(([k, label, ph]) => (
        <label key={k} className="bk-f">
          <span>{label}</span>
          <input className="input sm num" inputMode={k === "symbol_suffix" ? "text" : "decimal"} value={values[k] ?? ""} placeholder={ph || "off"} onChange={(e) => onChange({ ...values, [k]: e.target.value })} />
        </label>
      ))}
    </div>
  );
}

export default function BrokerSheet({ open, onClose, onLimit }) {
  const { toast } = useAuth();
  const [data, setData] = useState(null);
  const [kind, setKind] = useState(null);
  const [creds, setCreds] = useState({});
  const [live, setLive] = useState(false);
  const [limits, setLimits] = useState({});
  const [label, setLabel] = useState("");
  const [useId, setUseId] = useState(false);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null);
  const [editVals, setEditVals] = useState({});

  const load = useCallback(() => get("/brokers").then(setData).catch(() => setData({ available: {}, accounts: [] })), []);
  useEffect(() => { if (open) { load(); setKind(null); setEdit(null); } }, [open, load]);

  const fail = (e) => {
    if (e instanceof ApiError && (e.status === 402 || e.status === 429) && onLimit) onLimit({ message: e.message, detail: e.detail });
    else toast(e.message, "error", 7000);
  };
  const pick = (k) => { setKind(k); setCreds({}); setLimits({}); setLabel(""); setLive(false); setUseId(false); };

  const connect = async () => {
    setBusy(true);
    try {
      const body = { kind, label: label || null, live, credentials: useId && kind === "mt" ? { account_id: creds.account_id } : creds, settings: limits };
      const a = await post("/brokers", body);
      toast(a.status === "pending" ? `${a.label} added. It's still connecting; check it again in a minute.` : `${a.label} connected.`, "success", 5000);
      setKind(null);
      load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const check = async (a) => {
    try {
      await post(`/brokers/${a.id}/check`, {});
      load();
    } catch (e) {
      fail(e);
      load();
    }
  };
  const remove = async (a) => {
    try {
      await del(`/brokers/${a.id}`);
      toast("Disconnected. Delete the API key in your broker too.", "info", 6000);
      load();
    } catch (e) {
      fail(e);
    }
  };
  const openEdit = (a) => { setEdit(a.id); setEditVals(Object.fromEntries(LIMITS[a.kind].map(([k]) => [k, a.settings[k] ?? ""]))); };
  const saveEdit = async (a) => {
    try {
      await patch(`/brokers/${a.id}`, { settings: editVals });
      setEdit(null);
      load();
    } catch (e) {
      fail(e);
    }
  };

  const avail = (data && data.available) || {};
  const fields = kind ? FIELDS[kind] : [];
  const canSend = kind && (useId && kind === "mt" ? !!creds.account_id : fields.every(([k]) => (creds[k] || "").trim()));

  return (
    <Sheet open={open} onClose={onClose} title="Connect a broker" wide>
      <div className="bk">
        <p className="wt-lead">Send a plan's entry, stop loss and take profit straight to your broker, so it shows there. Nothing is sent until you press Send, unless you switch on auto-send for a watch.</p>

        {data && data.accounts.length ? (
          <section className="wt-sec">
            <h4>Connected</h4>
            {data.accounts.map((a) => (
              <div key={a.id} className="bk-acct">
                <div className="bk-top">
                  <div className="grow">
                    <b>{a.label}</b>
                    <span className={`bk-tag ${a.live ? "live" : "demo"}`}>{a.live ? "LIVE" : "Demo"}</span>
                    <span className="faint bk-meta">
                      {a.name}{money(a.info) ? ` · ${money(a.info)}` : ""}{a.status === "pending" ? " · connecting…" : ""}
                    </span>
                    {a.error ? <span className="bk-err">{a.error}</span> : null}
                  </div>
                  <button className="icon-btn" onClick={() => check(a)} title="Check the connection" aria-label="Check the connection"><Icon name="refresh" size={15} /></button>
                  <button className="icon-btn" onClick={() => (edit === a.id ? setEdit(null) : openEdit(a))} title="Limits" aria-label="Limits"><Icon name="sliders" size={15} /></button>
                  <button className="icon-btn" onClick={() => remove(a)} title="Disconnect" aria-label="Disconnect"><Icon name="trash" size={15} /></button>
                </div>
                {edit === a.id ? (
                  <div className="bk-edit">
                    <Limits kind={a.kind} values={editVals} onChange={setEditVals} />
                    <p className="faint bk-note">Orders above the largest size, or past the daily count, are refused here before they reach your broker. Auto-send size is what a watch with auto-send places each time.</p>
                    <button className="btn sm primary" onClick={() => saveEdit(a)}>Save limits</button>
                  </div>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}

        <section className="wt-sec">
          <h4>{data && data.accounts.length ? "Connect another" : "Choose your broker"}</h4>
          <div className="bk-kinds">
            {["mt", "oanda", "bybit", "binance"].map((k) => (
              <button key={k} className={`chip${kind === k ? " on" : ""}`} onClick={() => pick(k)} disabled={data && avail[k] === false} title={avail[k] === false ? "Not switched on yet" : ""}>
                {KIND_HELP[k].title}{avail[k] === false ? " · not switched on" : ""}
              </button>
            ))}
          </div>
          {data && avail.mt === false ? <p className="faint bk-note">MetaTrader turns on when the site owner adds a MetaApi token (METAAPI_TOKEN). Binance, Bybit and OANDA work with your own keys.</p> : null}
          {kind ? (
            <div className="bk-form">
              <p className="bk-about">{KIND_HELP[kind].about}</p>
              {kind === "mt" ? (
                <label className="check bk-usid"><input type="checkbox" checked={useId} onChange={(e) => setUseId(e.target.checked)} /> I already have a MetaApi account id</label>
              ) : null}
              {useId && kind === "mt" ? (
                <input className="input" placeholder="MetaApi account id" value={creds.account_id || ""} onChange={(e) => setCreds({ ...creds, account_id: e.target.value })} autoComplete="off" />
              ) : fields.map(([k, ph, type]) => (
                <input key={k} className="input" type={type} placeholder={ph} value={creds[k] || ""} onChange={(e) => setCreds({ ...creds, [k]: e.target.value })} autoComplete="off" spellCheck={false} />
              ))}
              {kind === "mt" && !useId ? (
                <div className="seg" role="group" aria-label="Platform">
                  {["mt5", "mt4"].map((p) => <button key={p} className={(creds.platform || "mt5") === p ? "on" : ""} onClick={() => setCreds({ ...creds, platform: p })}>{p.toUpperCase()}</button>)}
                </div>
              ) : null}
              <input className="input" placeholder="Name for this account (optional)" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
              {kind !== "mt" ? (
                <div className="seg" role="group" aria-label="Account type">
                  <button className={!live ? "on" : ""} onClick={() => setLive(false)}>{kind === "oanda" ? "Practice" : "Test account"}</button>
                  <button className={live ? "on" : ""} onClick={() => setLive(true)}>Live (real money)</button>
                </div>
              ) : (
                <div className="seg" role="group" aria-label="Account type">
                  <button className={!live ? "on" : ""} onClick={() => setLive(false)}>Demo</button>
                  <button className={live ? "on" : ""} onClick={() => setLive(true)}>Live (real money)</button>
                </div>
              )}
              <h4 className="bk-h">Safety limits</h4>
              <Limits kind={kind} values={limits} onChange={setLimits} />
              <p className="faint bk-note">Start with a demo or test account. Orders above these limits are refused. You can change them later.</p>
              <button className="btn primary" onClick={connect} disabled={busy || !canSend} style={{ justifyContent: "center" }}>
                {busy ? <span className="spinner" /> : <Icon name="check" size={16} />} Check and connect
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </Sheet>
  );
}

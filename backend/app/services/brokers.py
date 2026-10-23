"""Brokers: send a trade plan (entry, stop loss, take profits) to the person's own broker account.

Four kinds are supported, each through the broker's own API:
  * mt       MetaTrader 4 / 5, through MetaApi (metaapi.cloud). The server needs METAAPI_TOKEN (a paid plan); the person
             enters the MT login, the trading password and the broker's server once. The password goes to MetaApi only
             and is not kept here.
  * binance  Binance USDⓈ-M futures (USDT perpetuals), with the person's own API key.
  * bybit    Bybit V5 linear USDT perpetuals, with the person's own API key.
  * oanda    OANDA v20 (forex, gold, indices), with the person's token and account id.

The keys are encrypted in the database (Fernet) and never sent back to the browser. Use keys that can trade but cannot
withdraw. Every order goes through the same safety checks first: the stop is on the right side, targets are on the
right side, the size is within the person's own cap, and no more than a set number of orders a day.

Nothing here trades by itself: an order is sent when the person presses Send, or by a watch the person switched to
auto-send (watcher.py), within the same caps. Research tool, not financial advice; trading can lose all of the money."""
import base64
import hashlib
import hmac
import json
import logging
import math
import re
import time
import uuid
from datetime import timedelta
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import func, select

from ..config import settings
from ..models import BrokerAccount, BrokerOrder, jdump, jload, utcnow

log = logging.getLogger("streix.broker")
KINDS = ("mt", "binance", "bybit", "oanda")
NAMES = {"mt": "MetaTrader 4/5", "binance": "Binance Futures", "bybit": "Bybit", "oanda": "OANDA"}
SIZE_UNIT = {"mt": "lots", "oanda": "units", "binance": "coins", "bybit": "coins"}
DEFAULTS = dict(max_size=None, max_notional=1000.0, max_orders_day=5, auto_size=None, symbol_suffix="")
DEFAULT_MAX_SIZE = {"mt": 1.0, "oanda": 10000.0}
TIMEOUT = httpx.Timeout(20.0)
_client = {"c": None}


class BrokerError(Exception):
    """Something to tell the person in plain words (a refused order, a wrong key ...)."""


def set_client(c):
    _client["c"] = c


def _http():
    if _client["c"] is None:
        _client["c"] = httpx.Client(timeout=TIMEOUT)
    return _client["c"]


# ───────────────────────── secrets ─────────────────────────
def _fernet():
    raw = (settings.broker_key or settings.secret_key).encode()
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(b"streix-broker|" + raw).digest()))


def seal(d):
    return _fernet().encrypt(json.dumps(d).encode()).decode()


def unseal(s):
    try:
        return json.loads(_fernet().decrypt((s or "").encode()).decode())
    except (InvalidToken, ValueError):
        raise BrokerError("The saved keys can't be read any more (the server's secret key changed). Connect the broker again.")


def available():
    """Which kinds the server can connect right now. MetaTrader appears once METAAPI_TOKEN is set."""
    return dict(mt=bool(settings.metaapi_token), binance=True, bybit=True, oanda=True)


def cfg(acct):
    d = dict(DEFAULTS)
    d.update(jload(acct.settings, {}) or {})
    if d.get("max_size") is None:
        d["max_size"] = DEFAULT_MAX_SIZE.get(acct.kind)
    return d


def public(acct):
    c = cfg(acct)
    info = jload(acct.info, {}) or {}
    return dict(id=acct.id, kind=acct.kind, name=NAMES.get(acct.kind), label=acct.label or NAMES.get(acct.kind),
                live=acct.live, status=acct.status, error=acct.error, info=info, unit=SIZE_UNIT.get(acct.kind),
                settings=dict(max_size=c["max_size"], max_notional=c["max_notional"], max_orders_day=c["max_orders_day"],
                              auto_size=c["auto_size"], symbol_suffix=c.get("symbol_suffix") or ""),
                created_at=acct.created_at.replace(microsecond=0).isoformat() + "Z")


# ───────────────────────── small helpers ─────────────────────────
def norm_symbol(sym):
    return re.sub(r"[^A-Z0-9]", "", str(sym or "").upper())


def _floor_step(x, step):
    if not step or step <= 0:
        return x
    return math.floor(x / step + 1e-9) * step


def _round_tick(x, tick):
    if not tick or tick <= 0:
        return x
    return round(round(x / tick) * tick, 12)


def _dec_places(step):
    s = f"{step:.12f}".rstrip("0")
    return len(s.split(".")[1]) if "." in s else 0


def num(x, step=None, places=None):
    """A number as the broker wants it in text: no exponent, trimmed to the step's decimals."""
    if step:
        places = _dec_places(step)
    places = 8 if places is None else places
    t = f"{x:.{places}f}"
    return t.rstrip("0").rstrip(".") if "." in t else t


def _err(r, who):
    try:
        j = r.json()
    except ValueError:
        j = {}
    msg = (j.get("message") or j.get("msg") or j.get("retMsg") or j.get("errorMessage") or j.get("error")
           or (r.text or "")[:200] or f"HTTP {r.status_code}")
    return BrokerError(f"{who}: {str(msg)[:240]}")


def split_sizes(total, parts, step, minimum):
    """Split an order across take-profits: equal parts, rounded down to the step, the remainder on the first.
    Falls back to one order when the parts would be below the broker's minimum size."""
    if parts <= 1:
        return [total]
    each = _floor_step(total / parts, step)
    if each < (minimum or 0) or each <= 0:
        return [total]
    out = [each] * parts
    out[0] = _floor_step(total - each * (parts - 1), step)
    return out if out[0] >= (minimum or 0) else [total]


def tp_list(o):
    tps = [float(t) for t in (o.get("tps") or []) if t][:3]
    if not tps:
        raise BrokerError("The plan has no take profit.")
    return tps if o.get("tp_mode") == "split" else tps[:1]


# ───────────────────────── MetaTrader through MetaApi ─────────────────────────
class MT:
    PROV = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai"

    def __init__(self, acct, creds):
        self.acct, self.c = acct, creds
        self.set = cfg(acct)
        self.region = creds.get("region") or settings.metaapi_region
        self.id = creds["account_id"]

    def _h(self, extra=None):
        return {"auth-token": settings.metaapi_token or "", "Content-Type": "application/json", **(extra or {})}

    @property
    def base(self):
        return f"https://mt-client-api-v1.{self.region}.agiliumtrade.ai/users/current/accounts/{self.id}"

    def _get(self, url):
        r = _http().get(url, headers=self._h())
        if r.status_code == 401:
            raise BrokerError("MetaApi refused the server's token. The site owner should check METAAPI_TOKEN.")
        if r.status_code >= 300:
            raise _err(r, "MetaApi")
        return r.json()

    @staticmethod
    def provision(creds):
        """Creates the MetaApi account for this MT login and returns {account_id, region}. The password is sent to
        MetaApi and not stored."""
        if not settings.metaapi_token:
            raise BrokerError("MetaTrader connections aren't switched on for this server yet.")
        body = dict(name=f"streix-{creds['login']}"[:60], login=str(creds["login"]), password=creds["password"],
                    server=creds["server"], platform=creds.get("platform", "mt5"), magic=0, type="cloud-g2")
        for _ in range(8):
            r = _http().post(MT.PROV + "/users/current/accounts", json=body,
                             headers={"auth-token": settings.metaapi_token, "transaction-id": uuid.uuid4().hex,
                                      "Content-Type": "application/json"})
            if r.status_code == 202:                                  # still detecting the broker's settings
                time.sleep(min(10, max(1, int(r.headers.get("Retry-After", "2")))))
                continue
            break
        if r.status_code == 401:
            raise BrokerError("MetaApi refused the server's token. The site owner should check METAAPI_TOKEN.")
        if r.status_code >= 300:
            raise _err(r, "MetaApi")
        aid = r.json().get("id")
        if not aid:
            raise BrokerError("MetaApi didn't return an account id. Try again.")
        return MT.lookup(aid)

    @staticmethod
    def lookup(aid):
        r = _http().get(f"{MT.PROV}/users/current/accounts/{aid}", headers={"auth-token": settings.metaapi_token or ""})
        if r.status_code == 404:
            raise BrokerError("MetaApi has no account with that id on this token.")
        if r.status_code >= 300:
            raise _err(r, "MetaApi")
        j = r.json()
        return dict(account_id=aid, region=j.get("region") or settings.metaapi_region, state=j.get("state"),
                    connection=j.get("connectionStatus"))

    def info(self):
        j = self._get(self.base + "/account-information")
        return dict(name=j.get("name") or f"MT {j.get('login', '')}", balance=j.get("balance"), currency=j.get("currency"),
                    detail=f"{j.get('platform', 'mt')} · {j.get('server', '')}".strip(" ·"))

    def _spec(self, sym):
        try:
            return self._get(f"{self.base}/symbols/{sym}/specification")
        except BrokerError:
            return {}

    def place(self, o):
        sym = norm_symbol(o["symbol"]) + (self.set.get("symbol_suffix") or "")
        spec = self._spec(sym)
        step, vmin, vmax = spec.get("volumeStep") or 0.01, spec.get("minVolume") or 0.01, spec.get("maxVolume")
        digits = spec.get("digits")
        long = o["side"] == "long"
        tps = tp_list(o)
        sizes = split_sizes(_floor_step(o["size"], step), len(tps), step, vmin)
        if len(sizes) < len(tps):
            tps = tps[:1]
        ids = []
        for tp, vol in zip(tps, sizes, strict=False):
            vol = min(vol, vmax) if vmax else vol
            if vol < vmin:
                raise BrokerError(f"{num(vol, step)} lots is below this broker's minimum ({num(vmin, step)}) for {sym}.")
            rnd = (lambda x: round(x, digits)) if digits is not None else (lambda x: round(x, 5))
            body = dict(actionType=("ORDER_TYPE_BUY" if long else "ORDER_TYPE_SELL") if o["kind"] == "market"
                        else ("ORDER_TYPE_BUY_LIMIT" if long else "ORDER_TYPE_SELL_LIMIT"),
                        symbol=sym, volume=float(num(vol, step)), stopLoss=rnd(o["sl"]), takeProfit=rnd(tp),
                        comment="StreixAnalyst")
            if o["kind"] != "market":
                body["openPrice"] = rnd(o["entry"])
            r = _http().post(self.base + "/trade", json=body, headers=self._h())
            if r.status_code >= 300:
                raise _err(r, "MetaTrader")
            j = r.json()
            if j.get("stringCode") not in ("TRADE_RETCODE_DONE", "TRADE_RETCODE_PLACED", "TRADE_RETCODE_DONE_PARTIAL", None):
                raise BrokerError(f"MetaTrader: {j.get('message') or j.get('stringCode')}")
            ids.append(j.get("orderId") or j.get("positionId") or "")
        return dict(ids=ids, orders=len(ids), note=f"{len(ids)} order{'s' if len(ids) > 1 else ''} on {sym}")


# ───────────────────────── OANDA ─────────────────────────
OANDA_INDEX = {"NAS100": "NAS100_USD", "US30": "US30_USD", "SPX500": "SPX500_USD", "US500": "SPX500_USD",
               "GER40": "DE30_EUR", "DE40": "DE30_EUR", "UK100": "UK100_GBP", "JP225": "JP225_USD"}


class Oanda:
    def __init__(self, acct, creds):
        self.acct, self.c = acct, creds
        self.host = "https://api-fxtrade.oanda.com" if acct.live else "https://api-fxpractice.oanda.com"
        self.aid = creds["account_id"]

    def _h(self):
        return {"Authorization": f"Bearer {self.c['token']}", "Content-Type": "application/json"}

    def info(self):
        r = _http().get(f"{self.host}/v3/accounts/{self.aid}/summary", headers=self._h())
        if r.status_code in (401, 403):
            raise BrokerError("OANDA refused the token. Check the token, and that it is for a "
                              f"{'live' if self.acct.live else 'practice'} account.")
        if r.status_code >= 300:
            raise _err(r, "OANDA")
        a = r.json().get("account", {})
        return dict(name=a.get("alias") or self.aid, balance=float(a.get("balance", 0)), currency=a.get("currency"),
                    detail="live" if self.acct.live else "practice")

    @staticmethod
    def instrument(sym):
        s = norm_symbol(sym)
        if s in OANDA_INDEX:
            return OANDA_INDEX[s]
        if len(s) == 6 and s.isalpha():
            return f"{s[:3]}_{s[3:]}"
        raise BrokerError(f"I don't know OANDA's name for {sym}. Send it from OANDA's own app.")

    def place(self, o):
        inst = self.instrument(o["symbol"])
        long = o["side"] == "long"
        tps = tp_list(o)
        total = int(o["size"])
        if total < 1:
            raise BrokerError("OANDA sizes are whole units (for example 1000).")
        sizes = split_sizes(float(total), len(tps), 1.0, 1.0)
        if len(sizes) < len(tps):
            tps = tps[:1]
        prec = 3 if o["entry"] > 20 else 5
        if "JPY" in inst:
            prec = 3
        ids = []
        for tp, units in zip(tps, sizes, strict=False):
            u = int(units) * (1 if long else -1)
            order = dict(units=str(u), instrument=inst, positionFill="DEFAULT",
                         stopLossOnFill=dict(price=f"{o['sl']:.{prec}f}"),
                         takeProfitOnFill=dict(price=f"{tp:.{prec}f}"))
            if o["kind"] == "market":
                order.update(type="MARKET", timeInForce="FOK")
            else:
                order.update(type="LIMIT", price=f"{o['entry']:.{prec}f}", timeInForce="GTC")
            r = _http().post(f"{self.host}/v3/accounts/{self.aid}/orders", json=dict(order=order), headers=self._h())
            if r.status_code >= 300:
                raise _err(r, "OANDA")
            j = r.json()
            if j.get("orderCancelTransaction"):
                raise BrokerError(f"OANDA cancelled the order: {j['orderCancelTransaction'].get('reason', 'unknown reason')}")
            t = j.get("orderFillTransaction") or j.get("orderCreateTransaction") or {}
            ids.append(t.get("id") or j.get("lastTransactionID") or "")
        return dict(ids=ids, orders=len(ids), note=f"{len(ids)} order{'s' if len(ids) > 1 else ''} on {inst}")


# ───────────────────────── Bybit (V5, linear USDT) ─────────────────────────
class Bybit:
    RECV = "10000"

    def __init__(self, acct, creds):
        self.acct, self.c = acct, creds
        self.host = "https://api.bybit.com" if acct.live else "https://api-testnet.bybit.com"

    def _sign(self, payload):
        ts = str(int(time.time() * 1000))
        sig = hmac.new(self.c["secret"].encode(), (ts + self.c["key"] + self.RECV + payload).encode(), hashlib.sha256).hexdigest()
        return {"X-BAPI-API-KEY": self.c["key"], "X-BAPI-SIGN": sig, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": self.RECV,
                "Content-Type": "application/json"}

    def _call(self, method, path, params=None, body=None):
        if method == "GET":
            qs = urlencode(params or {})
            r = _http().get(f"{self.host}{path}" + (f"?{qs}" if qs else ""), headers=self._sign(qs))
        else:
            raw = json.dumps(body or {}, separators=(",", ":"))
            r = _http().post(f"{self.host}{path}", content=raw, headers=self._sign(raw))
        try:
            j = r.json()
        except ValueError:
            raise BrokerError(f"Bybit: unexpected answer (HTTP {r.status_code})")
        if j.get("retCode") != 0:
            code = j.get("retCode")
            hint = {10003: " Check the API key.", 10004: " The key's signature was refused: check the secret.",
                    10005: " The key has no permission for this (turn on Contract trade).",
                    10010: " Bybit refused this server's address: remove the key's IP restriction or allow it."}.get(code, "")
            raise BrokerError(f"Bybit: {j.get('retMsg', 'refused')}{hint}")
        return j.get("result") or {}

    def info(self):
        j = self._call("GET", "/v5/account/wallet-balance", {"accountType": "UNIFIED"})
        acc = (j.get("list") or [{}])[0]
        return dict(name="Bybit unified account", balance=float(acc.get("totalEquity") or 0), currency="USDT",
                    detail="live" if self.acct.live else "testnet")

    def place(self, o):
        sym = norm_symbol(o["symbol"])
        if not sym.endswith("USDT"):
            raise BrokerError(f"{o['symbol']} isn't a USDT perpetual on Bybit.")
        ins = self._call("GET", "/v5/market/instruments-info", {"category": "linear", "symbol": sym})
        row = (ins.get("list") or [None])[0]
        if not row:
            raise BrokerError(f"Bybit has no {sym} perpetual.")
        step = float(row["lotSizeFilter"]["qtyStep"])
        qmin = float(row["lotSizeFilter"]["minOrderQty"])
        tick = float(row["priceFilter"]["tickSize"])
        long = o["side"] == "long"
        tps = tp_list(o)
        sizes = split_sizes(_floor_step(o["size"], step), len(tps), step, qmin)
        if len(sizes) < len(tps):
            tps = tps[:1]
        ids = []
        for tp, q in zip(tps, sizes, strict=False):
            if q < qmin:
                raise BrokerError(f"{num(q, step)} is below Bybit's minimum order size ({num(qmin, step)}) for {sym}.")
            body = dict(category="linear", symbol=sym, side="Buy" if long else "Sell",
                        orderType="Market" if o["kind"] == "market" else "Limit", qty=num(q, step),
                        stopLoss=num(_round_tick(o["sl"], tick), tick), takeProfit=num(_round_tick(tp, tick), tick),
                        tpslMode="Full", tpOrderType="Market", slOrderType="Market", positionIdx=0,
                        orderLinkId=uuid.uuid4().hex[:32])
            if o["kind"] != "market":
                body.update(price=num(_round_tick(o["entry"], tick), tick), timeInForce="GTC")
            res = self._call("POST", "/v5/order/create", body=body)
            ids.append(res.get("orderId", ""))
        return dict(ids=ids, orders=len(ids), note=f"{len(ids)} order{'s' if len(ids) > 1 else ''} on {sym}")


# ───────────────────────── Binance USDⓈ-M futures ─────────────────────────
class Binance:
    def __init__(self, acct, creds):
        self.acct, self.c = acct, creds
        self.host = "https://fapi.binance.com" if acct.live else "https://testnet.binancefuture.com"

    def _call(self, method, path, params=None, signed=True):
        p = dict(params or {})
        if signed:
            p["timestamp"] = int(time.time() * 1000)
            p["recvWindow"] = 10000
            qs = urlencode(p)
            qs += "&signature=" + hmac.new(self.c["secret"].encode(), qs.encode(), hashlib.sha256).hexdigest()
        else:
            qs = urlencode(p)
        r = _http().request(method, f"{self.host}{path}?{qs}", headers={"X-MBX-APIKEY": self.c["key"]})
        try:
            j = r.json()
        except ValueError:
            raise BrokerError(f"Binance: unexpected answer (HTTP {r.status_code})")
        if r.status_code >= 300 or (isinstance(j, dict) and isinstance(j.get("code"), int) and j["code"] < 0):
            code = j.get("code") if isinstance(j, dict) else None
            hint = {-2014: " Check the API key.", -2015: " The key, its permissions or its IP restriction were refused.",
                    -1022: " The secret doesn't match the key."}.get(code, "")
            raise BrokerError(f"Binance: {(j.get('msg') if isinstance(j, dict) else None) or 'refused'}{hint}")
        return j

    def info(self):
        try:
            rows = self._call("GET", "/fapi/v3/balance")
        except BrokerError:
            rows = self._call("GET", "/fapi/v2/balance")
        usdt = next((x for x in rows if x.get("asset") == "USDT"), {})
        return dict(name="Binance Futures", balance=float(usdt.get("balance") or 0), currency="USDT",
                    detail="live" if self.acct.live else "testnet")

    def place(self, o):
        sym = norm_symbol(o["symbol"])
        if not sym.endswith("USDT"):
            raise BrokerError(f"{o['symbol']} isn't a USDT perpetual on Binance.")
        ex = self._call("GET", "/fapi/v1/exchangeInfo", {"symbol": sym}, signed=False)
        row = next((x for x in ex.get("symbols", []) if x.get("symbol") == sym), None)
        if not row:
            raise BrokerError(f"Binance has no {sym} perpetual.")
        flt = {f["filterType"]: f for f in row.get("filters", [])}
        step = float(flt["LOT_SIZE"]["stepSize"])
        qmin = float(flt["LOT_SIZE"]["minQty"])
        tick = float(flt["PRICE_FILTER"]["tickSize"])
        qty = _floor_step(o["size"], step)
        if qty < qmin:
            raise BrokerError(f"{num(qty, step)} is below Binance's minimum order size ({num(qmin, step)}) for {sym}.")
        long = o["side"] == "long"
        side, opp = ("BUY", "SELL") if long else ("SELL", "BUY")
        tp = tp_list(o)[0]                                   # one take-profit that closes the whole position
        entry = dict(symbol=sym, side=side, quantity=num(qty, step), newOrderRespType="RESULT")
        if o["kind"] == "market":
            entry.update(type="MARKET")
        else:
            entry.update(type="LIMIT", timeInForce="GTC", price=num(_round_tick(o["entry"], tick), tick))
        placed = self._call("POST", "/fapi/v1/order", entry)
        ids = [str(placed.get("orderId", ""))]
        try:
            for kind, price in (("STOP_MARKET", o["sl"]), ("TAKE_PROFIT_MARKET", tp)):
                a = self._call("POST", "/fapi/v1/algoOrder", dict(
                    algoType="CONDITIONAL", symbol=sym, side=opp, type=kind, triggerPrice=num(_round_tick(price, tick), tick),
                    closePosition="true", workingType="MARK_PRICE"))
                ids.append(str(a.get("algoId") or a.get("orderId") or ""))
        except BrokerError as e:
            # an entry without its stop must not stay: cancel it, or close what already filled
            try:
                if o["kind"] == "market":
                    self._call("POST", "/fapi/v1/order", dict(symbol=sym, side=opp, type="MARKET", quantity=num(qty, step), reduceOnly="true"))
                else:
                    self._call("DELETE", "/fapi/v1/order", dict(symbol=sym, orderId=placed.get("orderId")))
            except BrokerError:
                raise BrokerError(f"{e} The entry may be open WITHOUT a stop: check Binance now.")
            raise BrokerError(f"{e} The entry was cancelled so nothing is left without a stop.")
        return dict(ids=ids, orders=1, note=f"entry, stop and take profit 1 on {sym}"
                    + (" (Binance takes one take profit here)" if len(o.get("tps") or []) > 1 else ""))


ADAPTERS = {"mt": MT, "oanda": Oanda, "bybit": Bybit, "binance": Binance}


def adapter(acct):
    creds = unseal(acct.secrets)
    return ADAPTERS[acct.kind](acct, creds)


# ───────────────────────── connect and send ─────────────────────────
def need(creds, *keys):
    for k in keys:
        if not str(creds.get(k) or "").strip():
            raise BrokerError(f"Fill in {k.replace('_', ' ')}.")
    return {k: str(v).strip() for k, v in creds.items() if v is not None}


def connect(db, user, kind, label, live, creds, config=None):
    """Checks the keys with the broker and saves the account. Returns the BrokerAccount."""
    if kind not in KINDS:
        raise BrokerError("Unknown broker.")
    if kind == "mt" and not settings.metaapi_token:
        raise BrokerError("MetaTrader connections aren't switched on for this server yet.")
    if kind == "mt":
        c = need(creds, "account_id") if creds.get("account_id") else need(creds, "login", "password", "server")
        looked = MT.lookup(c["account_id"]) if c.get("account_id") else MT.provision(c)
        sealed = dict(account_id=looked["account_id"], region=looked["region"])
        live = True if live is None else live
    elif kind == "oanda":
        c = need(creds, "token", "account_id")
        sealed = dict(token=c["token"], account_id=c["account_id"])
    else:
        c = need(creds, "key", "secret")
        sealed = dict(key=c["key"], secret=c["secret"])
    acct = BrokerAccount(user_id=user.id, kind=kind, label=(label or NAMES[kind])[:60], live=bool(live),
                         secrets=seal(sealed), settings=jdump(clean_settings(config or {})))
    refresh(acct, soft=(kind == "mt"))
    db.add(acct)
    db.flush()
    return acct


def clean_settings(c):
    out = {}
    for k in ("max_size", "max_notional", "auto_size"):
        v = c.get(k)
        if v in (None, ""):
            out[k] = None
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            raise BrokerError(f"{k.replace('_', ' ')} must be a number.")
        if v <= 0:
            raise BrokerError(f"{k.replace('_', ' ')} must be above zero.")
        out[k] = v
    if c.get("max_orders_day") not in (None, ""):
        try:
            out["max_orders_day"] = max(1, min(50, int(c["max_orders_day"])))
        except (TypeError, ValueError):
            raise BrokerError("Orders a day must be a whole number.")
    suffix = str(c.get("symbol_suffix") or "").strip()
    out["symbol_suffix"] = re.sub(r"[^A-Za-z0-9._#-]", "", suffix)[:8]
    return out


def refresh(acct, soft=False):
    """Asks the broker for the account's balance, to prove the keys work. soft: a MetaTrader account that is still
    connecting is kept as pending instead of failing."""
    try:
        info = adapter(acct).info()
        acct.info, acct.status, acct.error = jdump(info), "ok", None
    except BrokerError as e:
        if soft:
            acct.status, acct.error = "pending", "Still connecting to your broker. Check again in a minute."
            log.info("broker pending: %s", e)
            return
        raise
    except httpx.HTTPError as e:
        raise BrokerError(f"Couldn't reach the broker: {type(e).__name__}")


def check_order(o):
    """Plain sanity checks, before any money moves. Raises BrokerError with what's wrong."""
    side, entry, sl = o.get("side"), float(o.get("entry") or 0), float(o.get("sl") or 0)
    tps = [float(t) for t in (o.get("tps") or []) if t]
    if side not in ("long", "short") or o.get("kind") not in ("market", "limit"):
        raise BrokerError("The order must be a buy or sell, at market or a limit price.")
    if entry <= 0 or sl <= 0 or not tps:
        raise BrokerError("The order needs an entry, a stop loss and at least one take profit.")
    d = 1 if side == "long" else -1
    if d * (entry - sl) <= 0:
        raise BrokerError("The stop loss must be below the entry for a buy, above it for a sell.")
    if any(d * (t - entry) <= 0 for t in tps):
        raise BrokerError("Take profits must be above the entry for a buy, below it for a sell.")
    if not (float(o.get("size") or 0) > 0):
        raise BrokerError("Enter the size to trade.")


def check_caps(db, acct, o):
    c = cfg(acct)
    size = float(o["size"])
    cap = c.get("max_size")
    if acct.kind in ("mt", "oanda") and cap and size > cap + 1e-9:
        raise BrokerError(f"{size:g} {SIZE_UNIT[acct.kind]} is above the {cap:g} you allow on this account. "
                          "Lower the size, or raise the cap in your broker settings.")
    if acct.kind in ("binance", "bybit"):
        notional = size * float(o["entry"])
        if c.get("max_notional") and notional > c["max_notional"] + 1e-6:
            raise BrokerError(f"This order is worth about {notional:,.0f} USDT, above the {c['max_notional']:,.0f} "
                              "you allow on this account. Lower the size, or raise the cap in your broker settings.")
    since = utcnow() - timedelta(hours=24)
    n = db.execute(select(func.count(BrokerOrder.id)).where(BrokerOrder.account_id == acct.id, BrokerOrder.status == "sent",
                                                            BrokerOrder.created_at > since)).scalar()
    if n >= int(c.get("max_orders_day") or 5):
        raise BrokerError(f"{n} orders already went to this account in the last 24 hours, the limit you set "
                          f"({c.get('max_orders_day')}). Raise it in your broker settings if that's intended.")


def send(db, user, acct, o, source="manual", ref=None):
    """Checks, sends, and records one order. Returns dict(ok, note, ids, order_id). A refusal is recorded too."""
    if ref:
        prev = db.execute(select(BrokerOrder).where(BrokerOrder.ref == ref)).scalar_one_or_none()
        if prev is not None:
            return dict(ok=prev.status == "sent", note="Already sent.", ids=jload(prev.external, []), order_id=prev.id,
                        error=prev.error, duplicate=True)
    check_order(o)
    check_caps(db, acct, o)
    row = BrokerOrder(user_id=user.id, account_id=acct.id, symbol=o["symbol"], side=o["side"], kind=o["kind"],
                      entry=float(o["entry"]), sl=float(o["sl"]), tps=jdump([float(t) for t in o["tps"]]),
                      size=float(o["size"]), source=source, ref=ref)
    try:
        res = adapter(acct).place(o)
        row.external, row.status = jdump(res["ids"]), "sent"
        acct.status, acct.error = "ok", None
        out = dict(ok=True, note=res["note"], ids=res["ids"])
    except BrokerError as e:
        row.status, row.error = "failed", str(e)[:400]
        out = dict(ok=False, error=str(e), note=None, ids=[])
    except httpx.HTTPError as e:
        row.status, row.error = "failed", f"Couldn't reach the broker: {type(e).__name__}"
        out = dict(ok=False, error=row.error, note=None, ids=[])
    db.add(row)
    db.flush()
    out["order_id"] = row.id
    return out


def order_from_signal(sig, symbol, size):
    """The order a watch's setup makes (strategy signals only; fixed-time calls have no stop or target)."""
    return dict(symbol=symbol, side=sig["side"], kind=sig["kind"], entry=sig["entry"], sl=sig["sl"],
                tps=[sig["tp"]], size=size, tp_mode="first")


def auto_place(db, user, w, sig, symbol):
    """A watch with auto-send on: place the order for a fresh setup. Returns a sentence for the alert."""
    acct = db.get(BrokerAccount, w.broker_id) if w.broker_id else None
    if acct is None or acct.user_id != user.id:
        return "Not sent to your broker: the connected account is gone."
    if sig.get("fixed_time"):
        return None
    if sig["age"] > 0:
        return "Not sent to your broker: the signal was not on the newest candle."
    if sig.get("chase") and sig["kind"] == "limit":
        return "Not sent to your broker: price already ran past the entry."
    size = cfg(acct).get("auto_size")
    if not size:
        return "Not sent to your broker: set an auto-send size in your broker settings first."
    try:
        res = send(db, user, acct, order_from_signal(sig, symbol, size), source="watch",
                   ref=f"w{w.id}:{sig['id']}:{sig['bar']}:{sig['dir']}")
    except BrokerError as e:
        return f"Not sent to your broker: {e}"
    label = acct.label or NAMES[acct.kind]
    if res["ok"]:
        return f"Sent to {label}{' (LIVE)' if acct.live else ' (demo)'}: {res['note']}."
    return f"Not sent to {label}: {res['error']}"

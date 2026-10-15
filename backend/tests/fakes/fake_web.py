"""Offline stand-ins for every outside service the API talks to, answering in each service's documented format:
crypto exchanges (Bybit, OKX, MEXC, Gate, Binance futures, ticker lists), the news feeds, Paystack, OPay and
the Anthropic streaming API."""
import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone

import httpx
import pandas as pd

import fake_http
import synth

ONLY_MEXC = {"CAP"}
ONLY_GATE = {"NEWT"}
ONLY_PERP = {"PERPX"}
synth.CRYPTO.update(ONLY_MEXC | ONLY_GATE | ONLY_PERP)
SPOT = set(fake_http.KNOWN)
Resp = fake_http.Resp
IV_MIN = {"1": 1, "5": 5, "15": 15, "30": 30, "60": 60, "240": 240, "D": 1440, "1m": 1, "5m": 5, "15m": 15, "30m": 30,
          "1H": 60, "4H": 240, "1Dutc": 1440, "60m": 60, "4h": 240, "1d": 1440, "1h": 60}


def _rows(base, minutes, s, e):
    df = synth.window(base, s, e, minutes)
    df = df[(df.index >= s) & (df.index <= e)]
    ms = (df.index - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(milliseconds=1)
    return [(int(t), o, h, l, c, v) for t, o, h, l, c, v in zip(ms, df["open"], df["high"], df["low"], df["close"],
                                                               df["volume"])]


def _base(sym, quotes=("USDT", "USDC")):
    for q in quotes:
        if sym.endswith(q):
            return sym[: -len(q)]
    return sym


def _ts(ms):
    return pd.to_datetime(int(ms), unit="ms", utc=True)


class Session(fake_http.Session):
    def get(self, url, params=None, headers=None, timeout=None):
        params = params or {}
        host = url.split("/")[2]
        if host in fake_http.BLOCK:
            fake_http.LOG.append((url, dict(params)))
            return Resp(451, {"code": 0, "msg": "Service unavailable from a restricted location"})
        if host == "api.bybit.com":
            fake_http.LOG.append((url, dict(params)))
            if url.endswith("/v5/market/kline"):
                sym = params["symbol"]
                base = _base(sym)
                ok = base in SPOT or (params["category"] == "linear" and base in ONLY_PERP)
                if not ok:
                    return Resp(200, {"retCode": 10001, "retMsg": "Not supported symbols", "result": {}})
                rows = _rows(base, IV_MIN[params["interval"]], _ts(params["start"]), _ts(params["end"]))[-1000:][::-1]
                return Resp(200, {"retCode": 0, "result": {"list": [[str(t), f"{o:.8f}", f"{h:.8f}", f"{l:.8f}",
                                                                      f"{c:.8f}", f"{v:.4f}", "0"]
                                                                     for t, o, h, l, c, v in rows]}})
            if url.endswith("/v5/market/tickers"):
                names = SPOT | (ONLY_PERP if params.get("category") == "linear" else set())
                return Resp(200, {"retCode": 0, "result": {"list": [
                    {"symbol": b + "USDT", "lastPrice": "100", "price24hPcnt": "0.0123", "turnover24h": "5000000"}
                    for b in names]}})
        if host == "www.okx.com":
            fake_http.LOG.append((url, dict(params)))
            if url.endswith("/history-candles"):
                inst = params["instId"].split("-")
                if inst[0] not in SPOT:
                    return Resp(200, {"code": "51001", "msg": "Instrument ID does not exist", "data": []})
                end = _ts(int(params["after"]) - 1)
                m = IV_MIN[params["bar"]]
                rows = _rows(inst[0], m, end - pd.Timedelta(minutes=m * 100), end)[-100:][::-1]
                return Resp(200, {"code": "0", "data": [[str(t), str(o), str(h), str(l), str(c), str(v), "0", "0", "1"]
                                                        for t, o, h, l, c, v in rows]})
            if url.endswith("/market/tickers"):
                return Resp(200, {"code": "0", "data": [{"instId": f"{b}-USDT", "last": "100", "open24h": "98",
                                                         "volCcy24h": "3000000"} for b in SPOT]})
        if host == "api.mexc.com":
            fake_http.LOG.append((url, dict(params)))
            if url.endswith("/klines"):
                base = _base(params["symbol"])
                if base not in SPOT | ONLY_MEXC:
                    return Resp(400, {"code": -1121, "msg": "Invalid symbol."})
                rows = _rows(base, IV_MIN[params["interval"]], _ts(params["startTime"]), _ts(params["endTime"]))[:1000]
                return Resp(200, [[t, f"{o:.8f}", f"{h:.8f}", f"{l:.8f}", f"{c:.8f}", f"{v:.4f}", t + 1, "0"]
                                  for t, o, h, l, c, v in rows])
            if url.endswith("/ticker/24hr"):
                return Resp(200, [{"symbol": b + "USDT", "lastPrice": "2.5", "openPrice": "2.4", "quoteVolume": "800000"}
                                  for b in SPOT | ONLY_MEXC])
        if host == "api.gateio.ws":
            fake_http.LOG.append((url, dict(params)))
            if url.endswith("/candlesticks"):
                base = params["currency_pair"].split("_")[0]
                if base not in SPOT | ONLY_GATE:
                    return Resp(400, {"label": "INVALID_CURRENCY_PAIR", "message": "Invalid currency pair"})
                s = pd.to_datetime(int(params["from"]), unit="s", utc=True)
                e = pd.to_datetime(int(params["to"]), unit="s", utc=True)
                rows = _rows(base, IV_MIN[params["interval"]], s, e)
                return Resp(200, [[str(t // 1000), "0", str(c), str(h), str(l), str(o), str(v), "true"]
                                  for t, o, h, l, c, v in rows])
            if url.endswith("/spot/tickers"):
                return Resp(200, [{"currency_pair": f"{b}_USDT", "last": "1.1", "change_percentage": "-3.2",
                                   "quote_volume": "250000"} for b in SPOT | ONLY_GATE])
        if host == "fapi.binance.com":
            fake_http.LOG.append((url, dict(params)))
            if url.endswith("/klines"):
                base = _base(params["symbol"])
                if base not in SPOT | ONLY_PERP:
                    return Resp(400, {"code": -1121, "msg": "Invalid symbol."})
                m = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440}[params["interval"]]
                rows = _rows(base, m, _ts(params["startTime"]), _ts(params["endTime"]))[:1500]
                return Resp(200, [[t, f"{o:.8f}", f"{h:.8f}", f"{l:.8f}", f"{c:.8f}", f"{v:.4f}", t + 1, "0", 1, "0",
                                   "0", "0"] for t, o, h, l, c, v in rows])
            if url.endswith("/ticker/24hr"):
                return Resp(200, [{"symbol": b + "USDT", "lastPrice": "100", "priceChangePercent": "1.0",
                                   "quoteVolume": "9000000"} for b in SPOT | ONLY_PERP] +
                            [{"symbol": "BTCUSDT_261225", "lastPrice": "1", "priceChangePercent": "0", "quoteVolume": "1"}])
        if host == "api.kucoin.com" and url.endswith("/allTickers"):
            return Resp(200, {"code": "200000", "data": {"ticker": [
                {"symbol": f"{b}-USDT", "last": "100", "changeRate": "0.01", "volValue": "100000"} for b in SPOT]}})
        if url.endswith("/api/v3/ticker/24hr"):          # Binance spot ticker list
            return Resp(200, [{"symbol": b + "USDT", "lastPrice": "100", "priceChangePercent": "2.0",
                               "quoteVolume": "20000000", "count": 1000} for b in SPOT])
        return super().get(url, params, headers, timeout)


# ───────────── news ─────────────
def calendar_json(now=None):
    now = now or datetime.now(timezone.utc)
    ev = lambda mins, title, ccy, impact: dict(title=title, country=ccy, impact=impact, forecast="0.3%", previous="0.2%",
                                               date=(now + timedelta(minutes=mins)).astimezone(
                                                   timezone(timedelta(hours=-4))).isoformat())
    return [ev(45, "CPI m/m", "USD", "High"), ev(300, "ECB Press Conference", "EUR", "High"),
            ev(90, "Retail Sales m/m", "GBP", "Medium"), ev(-600, "Unemployment Claims", "USD", "Medium"),
            ev(2000, "BOJ Policy Rate", "JPY", "High")]


RSS = """<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Bitcoin surges to record high as ETF inflows jump</title><link>https://example.com/a</link><pubDate>{d}</pubDate></item>
<item><title>Ethereum slides as traders fear a sell-off</title><link>https://example.com/b</link><pubDate>{d}</pubDate></item>
<item><title>Dollar steadies ahead of US CPI; Fed in focus</title><link>https://example.com/c</link><pubDate>{d}</pubDate></item>
<item><title>Gold climbs as yields ease</title><link>https://example.com/d</link><pubDate>{d}</pubDate></item>
</channel></rss>"""


def news_handler(request):
    u = str(request.url)
    if "ff_calendar_thisweek" in u:
        return httpx.Response(200, json=calendar_json())
    if "ff_calendar_nextweek" in u:
        return httpx.Response(404)
    d = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")
    return httpx.Response(200, content=RSS.format(d=d).encode(), headers={"content-type": "application/rss+xml"})


# ───────────── Paystack ─────────────
class FakePaystack:
    def __init__(self, secret):
        self.secret = secret
        self.tx = {}            # reference → dict(status, amount, currency)
        self.customers = {}
        self.calls = []

    def handler(self, request):
        self.calls.append((request.method, request.url.path))
        if request.headers.get("authorization") != f"Bearer {self.secret}":
            return httpx.Response(401, json={"status": False, "message": "Invalid key"})
        p = request.url.path
        if p == "/transaction/initialize":
            b = json.loads(request.content)
            self.tx[b["reference"]] = dict(status="abandoned", amount=b["amount"], currency=b.get("currency", "NGN"),
                                           metadata=b.get("metadata"), channels=b.get("channels"))
            return httpx.Response(200, json={"status": True, "data": {
                "authorization_url": f"https://checkout.paystack.com/{b['reference']}", "access_code": "ac_" +
                b["reference"], "reference": b["reference"]}})
        if p.startswith("/transaction/verify/"):
            ref = p.rsplit("/", 1)[1]
            t = self.tx.get(ref)
            if not t:
                return httpx.Response(400, json={"status": False, "message": "Transaction reference not found"})
            return httpx.Response(200, json={"status": True, "data": dict(
                id=123456, reference=ref, status=t["status"], amount=t["amount"], currency=t["currency"],
                channel=t.get("channel", "card"), customer=dict(customer_code=t.get("customer", "CUS_x")))})
        if p == "/customer":
            b = json.loads(request.content)
            code = "CUS_" + hashlib.md5(b["email"].encode()).hexdigest()[:8]
            self.customers[code] = b
            return httpx.Response(200, json={"status": True, "data": {"customer_code": code, "email": b["email"]}})
        if p.startswith("/customer/"):
            return httpx.Response(200, json={"status": True, "data": {}})
        if p == "/dedicated_account":
            b = json.loads(request.content)
            return httpx.Response(200, json={"status": True, "data": dict(
                account_number="9930000902", account_name="STREIXANALYST/ADA LOVELACE", bank=dict(name="Wema Bank"),
                customer=dict(customer_code=b["customer"]))})
        return httpx.Response(404, json={"status": False, "message": "not found"})

    def sign(self, body: bytes):
        return hmac.new(self.secret.encode(), body, hashlib.sha512).hexdigest()


# ───────────── OPay ─────────────
class FakeOPay:
    def __init__(self, public, secret, merchant):
        self.public, self.secret, self.merchant = public, secret, merchant
        self.orders = {}

    def handler(self, request):
        if request.headers.get("merchantid") != self.merchant:
            return httpx.Response(200, json={"code": "02000", "message": "authentication failed"})
        b = json.loads(request.content)
        auth = request.headers.get("authorization", "")
        if request.url.path.endswith("/cashier/create"):
            if auth != f"Bearer {self.public}":
                return httpx.Response(200, json={"code": "02000", "message": "authentication failed"})
            self.orders[b["reference"]] = dict(status="INITIAL", total=b["amount"]["total"], currency=b["amount"]["currency"])
            return httpx.Response(200, json={"code": "00000", "message": "SUCCESSFUL", "data": {
                "reference": b["reference"], "orderNo": "OP" + b["reference"][-6:], "cashierUrl":
                f"https://cashier.opaycheckout.com/{b['reference']}", "status": "INITIAL"}})
        if request.url.path.endswith("/cashier/status"):
            sig = hmac.new(self.secret.encode(), request.content, hashlib.sha512).hexdigest()
            if auth != f"Bearer {sig}":
                return httpx.Response(200, json={"code": "02000", "message": "authentication failed"})
            o = self.orders.get(b["reference"])
            if not o:
                return httpx.Response(200, json={"code": "02006", "message": "not found"})
            return httpx.Response(200, json={"code": "00000", "message": "SUCCESSFUL", "data": {
                "reference": b["reference"], "orderNo": "OP1", "status": o["status"],
                "amount": {"total": o["total"], "currency": o["currency"]}}})
        return httpx.Response(404)


# ───────────── Anthropic (streaming) ─────────────
def anthropic_handler(request):
    body = json.loads(request.content)
    assert request.headers["x-api-key"] and request.headers["anthropic-version"] == "2023-06-01"
    assert body["stream"] is True and body["messages"][0]["role"] == "user" and "StreixAI" in body["system"]
    text = "Here is the plan: wait for the **entry**. Risk 1%."
    events = [dict(type="message_start", message=dict(id="m1")),
              dict(type="content_block_start", index=0, content_block=dict(type="text", text=""))]
    for w in text.split(" "):
        events.append(dict(type="content_block_delta", index=0, delta=dict(type="text_delta", text=w + " ")))
    events += [dict(type="content_block_stop", index=0), dict(type="message_stop")]
    sse = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)
    return httpx.Response(200, content=sse.encode(), headers={"content-type": "text/event-stream"})

"""Symbol search across crypto exchanges + forex, metals, indices, energies, commodities and US stocks."""
import json
import logging
import math
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import market_data as md

from ..config import settings

log = logging.getLogger("streix.catalog")

CRYPTO_NAMES = {
    "BTC": "Bitcoin", "ETH": "Ethereum", "SOL": "Solana", "BNB": "BNB", "XRP": "XRP", "ADA": "Cardano",
    "DOGE": "Dogecoin", "AVAX": "Avalanche", "DOT": "Polkadot", "LINK": "Chainlink", "LTC": "Litecoin",
    "BCH": "Bitcoin Cash", "TRX": "TRON", "TON": "Toncoin", "SHIB": "Shiba Inu", "NEAR": "NEAR Protocol",
    "UNI": "Uniswap", "ATOM": "Cosmos", "ETC": "Ethereum Classic", "XLM": "Stellar", "FIL": "Filecoin",
    "APT": "Aptos", "ARB": "Arbitrum", "OP": "Optimism", "SUI": "Sui", "PEPE": "Pepe", "INJ": "Injective",
    "AAVE": "Aave", "XMR": "Monero", "ICP": "Internet Computer", "HBAR": "Hedera", "VET": "VeChain",
    "ALGO": "Algorand", "SAND": "The Sandbox", "MANA": "Decentraland", "SEI": "Sei", "TIA": "Celestia",
    "WIF": "dogwifhat", "BONK": "Bonk", "FLOKI": "Floki", "JUP": "Jupiter", "RENDER": "Render", "FET": "Fetch.ai",
    "GRT": "The Graph", "IMX": "Immutable", "STX": "Stacks", "RUNE": "THORChain", "KAS": "Kaspa",
    "TAO": "Bittensor", "ENA": "Ethena", "ONDO": "Ondo", "WLD": "Worldcoin", "TRUMP": "Official Trump",
    "HYPE": "Hyperliquid", "PENGU": "Pudgy Penguins", "CRV": "Curve", "LDO": "Lido DAO", "ZEC": "Zcash",
    "POL": "Polygon", "MATIC": "Polygon (old)", "PAXG": "PAX Gold", "XAUT": "Tether Gold", "PI": "Pi Network",
    "VIRTUAL": "Virtuals Protocol", "FARTCOIN": "Fartcoin", "BERA": "Berachain", "S": "Sonic", "IP": "Story",
    "KAITO": "Kaito", "SUPER": "SuperVerse", "CAKE": "PancakeSwap", "DYDX": "dYdX", "GMX": "GMX",
}
_FX_NAMES = {"USD": "US Dollar", "EUR": "Euro", "GBP": "British Pound", "JPY": "Japanese Yen", "CHF": "Swiss Franc",
             "CAD": "Canadian Dollar", "AUD": "Australian Dollar", "NZD": "New Zealand Dollar", "ZAR": "South African Rand",
             "TRY": "Turkish Lira", "MXN": "Mexican Peso", "SGD": "Singapore Dollar", "HKD": "Hong Kong Dollar",
             "SEK": "Swedish Krona", "NOK": "Norwegian Krone", "PLN": "Polish Zloty", "CNH": "Chinese Yuan",
             "HUF": "Hungarian Forint", "CZK": "Czech Koruna", "DKK": "Danish Krone"}
_G = ["EUR", "GBP", "AUD", "NZD", "USD", "CAD", "CHF", "JPY"]
FX_PAIRS = [a + b for i, a in enumerate(_G) for b in _G[i + 1:]] + [
    "USDZAR", "USDTRY", "USDMXN", "USDSGD", "USDHKD", "USDSEK", "USDNOK", "USDPLN", "USDCNH", "USDHUF", "USDCZK",
    "USDDKK", "EURTRY", "EURPLN", "EURNOK", "EURSEK", "EURZAR", "GBPZAR"]
OTHER = [
    ("XAUUSD", "Gold", "metal"), ("XAGUSD", "Silver", "metal"), ("XPTUSD", "Platinum", "metal"),
    ("XPDUSD", "Palladium", "metal"), ("COPPER", "Copper", "metal"),
    ("US30", "Dow Jones 30", "index"), ("NAS100", "Nasdaq 100", "index"), ("US500", "S&P 500", "index"),
    ("US2000", "Russell 2000", "index"), ("DXY", "US Dollar Index", "index"), ("VIX", "Volatility Index", "index"),
    ("GER40", "Germany 40 (DAX)", "index"), ("UK100", "UK 100 (FTSE)", "index"), ("FRA40", "France 40 (CAC)", "index"),
    ("EU50", "Euro Stoxx 50", "index"), ("ESP35", "Spain 35 (IBEX)", "index"), ("SWI20", "Swiss 20 (SMI)", "index"),
    ("JP225", "Japan 225 (Nikkei)", "index"), ("HK50", "Hong Kong 50", "index"), ("AUS200", "Australia 200", "index"),
    ("CHINA50", "China A50", "index"),
    ("USOIL", "WTI Crude Oil", "energy"), ("UKOIL", "Brent Crude Oil", "energy"), ("NATGAS", "Natural Gas", "energy"),
    ("COCOA", "Cocoa", "commodity"), ("COFFEE", "Coffee", "commodity"), ("COTTON", "Cotton", "commodity"),
    ("SOYBEAN", "Soybeans", "commodity"), ("SUGAR", "Sugar", "commodity"),
]
STOCKS = {
    "AAPL": "Apple", "MSFT": "Microsoft", "NVDA": "NVIDIA", "AMZN": "Amazon", "GOOGL": "Alphabet (Google)",
    "META": "Meta Platforms", "TSLA": "Tesla", "AMD": "AMD", "NFLX": "Netflix", "AVGO": "Broadcom", "ORCL": "Oracle",
    "CRM": "Salesforce", "ADBE": "Adobe", "INTC": "Intel", "QCOM": "Qualcomm", "PLTR": "Palantir",
    "COIN": "Coinbase Global", "MSTR": "Strategy (MicroStrategy)", "HOOD": "Robinhood", "UBER": "Uber",
    "SHOP": "Shopify", "PYPL": "PayPal", "BABA": "Alibaba", "JPM": "JPMorgan Chase", "BAC": "Bank of America",
    "GS": "Goldman Sachs", "V": "Visa", "MA": "Mastercard", "WMT": "Walmart", "COST": "Costco", "KO": "Coca-Cola",
    "PEP": "PepsiCo", "MCD": "McDonald's", "DIS": "Disney", "NKE": "Nike", "BA": "Boeing", "XOM": "Exxon Mobil",
    "CVX": "Chevron", "JNJ": "Johnson & Johnson", "PFE": "Pfizer", "LLY": "Eli Lilly", "UNH": "UnitedHealth",
    "ARM": "Arm Holdings", "SMCI": "Super Micro Computer", "SNOW": "Snowflake", "MU": "Micron", "TSM": "TSMC",
    "ASML": "ASML", "SPY": "SPDR S&P 500 ETF", "QQQ": "Invesco QQQ ETF", "IBIT": "iShares Bitcoin Trust",
}
POPULAR = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "XAUUSD", "EURUSD", "GBPUSD",
           "USDJPY", "NAS100", "US30", "US500", "USOIL", "AAPL", "TSLA", "NVDA"]
QUOTES = ("FDUSD", "USDT", "USDC", "TUSD", "BUSD", "DAI", "USD", "BTC", "ETH", "BNB", "EUR", "TRY", "BRL", "JPY")

_CAT = {"crypto": {}, "updated": 0.0, "status": {}}
_LOCK = threading.Lock()


def _split(sym):
    for q in QUOTES:
        if sym.endswith(q) and len(sym) > len(q):
            return sym[: -len(q)], q
    return None, None


def _f(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def _binance():
    out = []
    for t in md._get_json("https://api.binance.com/api/v3/ticker/24hr", tries=2):
        if int(t.get("count") or 0) <= 0:
            continue
        b, q = _split(t["symbol"])
        if b:
            out.append(dict(base=b, quote=q, ex="binance", price=_f(t["lastPrice"]), change=_f(t["priceChangePercent"]),
                            vol=_f(t["quoteVolume"]), perp=False))
    return out


def _binancef():
    out = []
    for t in md._get_json("https://fapi.binance.com/fapi/v1/ticker/24hr", tries=2):
        s = t.get("symbol", "")
        if "_" in s:
            continue
        b, q = _split(s)
        if b and q in ("USDT", "USDC"):
            out.append(dict(base=b, quote=q, ex="binancef", price=_f(t["lastPrice"]),
                            change=_f(t["priceChangePercent"]), vol=_f(t["quoteVolume"]), perp=True))
    return out


def _bybit(category):
    js = md._get_json("https://api.bybit.com/v5/market/tickers", dict(category=category), tries=2)
    out = []
    for t in (js.get("result") or {}).get("list") or []:
        b, q = _split(t.get("symbol", ""))
        if b:
            ch = _f(t.get("price24hPcnt"))
            out.append(dict(base=b, quote=q, ex="bybit", price=_f(t.get("lastPrice")),
                            change=None if ch is None else ch * 100, vol=_f(t.get("turnover24h")),
                            perp=category == "linear"))
    return out


def _okx():
    js = md._get_json("https://www.okx.com/api/v5/market/tickers", dict(instType="SPOT"), tries=2)
    out = []
    for t in js.get("data") or []:
        parts = t.get("instId", "").split("-")
        if len(parts) != 2:
            continue
        last, op = _f(t.get("last")), _f(t.get("open24h"))
        out.append(dict(base=parts[0], quote=parts[1], ex="okx", price=last,
                        change=(last / op - 1) * 100 if last and op else None, vol=_f(t.get("volCcy24h")), perp=False))
    return out


def _kucoin():
    js = md._get_json("https://api.kucoin.com/api/v1/market/allTickers", tries=2)
    out = []
    for t in ((js.get("data") or {}).get("ticker")) or []:
        parts = t.get("symbol", "").split("-")
        if len(parts) != 2:
            continue
        ch = _f(t.get("changeRate"))
        out.append(dict(base=parts[0], quote=parts[1], ex="kucoin", price=_f(t.get("last")),
                        change=None if ch is None else ch * 100, vol=_f(t.get("volValue")), perp=False))
    return out


def _mexc():
    out = []
    for t in md._get_json("https://api.mexc.com/api/v3/ticker/24hr", tries=2):
        b, q = _split(t.get("symbol", ""))
        last, op = _f(t.get("lastPrice")), _f(t.get("openPrice"))
        if b and last:
            out.append(dict(base=b, quote=q, ex="mexc", price=last, change=(last / op - 1) * 100 if op else None,
                            vol=_f(t.get("quoteVolume")), perp=False))
    return out


def _gate():
    out = []
    for t in md._get_json("https://api.gateio.ws/api/v4/spot/tickers", tries=2):
        parts = t.get("currency_pair", "").split("_")
        if len(parts) != 2:
            continue
        out.append(dict(base=parts[0], quote=parts[1], ex="gate", price=_f(t.get("last")),
                        change=_f(t.get("change_percentage")), vol=_f(t.get("quote_volume")), perp=False))
    return out


FETCHERS = {"binance": _binance, "binancef": _binancef, "bybit": lambda: _bybit("spot"),
            "bybit_perp": lambda: _bybit("linear"), "okx": _okx, "kucoin": _kucoin, "mexc": _mexc, "gate": _gate}
EX_LABEL = {"binance": "Binance", "binancef": "Binance Futures", "bybit": "Bybit", "okx": "OKX", "kucoin": "KuCoin",
            "mexc": "MEXC", "gate": "Gate"}
MAIN_EX = ("binance", "bybit", "okx", "kucoin")


def refresh(force=False):
    """Download every exchange's ticker list (a few MB in total). Called at start-up and every 6 hours."""
    if not force and time.time() - _CAT["updated"] < 6 * 3600 and _CAT["crypto"]:
        return
    rows, status = [], {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {name: ex.submit(fn) for name, fn in FETCHERS.items()}
        for name, fu in futs.items():
            try:
                r = fu.result(timeout=60)
                rows.extend(r)
                status[name] = len(r)
            except Exception as e:
                status[name] = f"error: {str(e)[:80]}"
    btc = next((r["price"] for r in rows if r["base"] == "BTC" and r["quote"] == "USDT" and r["price"]), None) or 0
    eth = next((r["price"] for r in rows if r["base"] == "ETH" and r["quote"] == "USDT" and r["price"]), None) or 0
    to_usd = {"BTC": btc, "ETH": eth}
    cat = {}
    for r in rows:
        if not r["price"] or not re.fullmatch(r"[A-Z0-9]{1,20}", r["base"] or "") or not r["quote"]:
            continue
        key = r["base"] + r["quote"] + (".P" if r["perp"] else "")
        e = cat.setdefault(key, dict(symbol=key, base=r["base"], quote=r["quote"], cls="crypto", perp=r["perp"],
                                     exchanges=[], price=None, change=None, vol_usd=0.0, _best=-1.0))
        if r["ex"] not in e["exchanges"]:
            e["exchanges"].append(r["ex"])
        mult = 1.0 if r["quote"] in md.STABLE else to_usd.get(r["quote"], 0.0)
        v = (r["vol"] or 0.0) * mult
        e["vol_usd"] += v
        if v > e["_best"]:
            e["_best"], e["price"], e["change"] = v, r["price"], r["change"]
    for e in cat.values():
        e.pop("_best", None)
        ex = e["exchanges"]
        e["name"] = CRYPTO_NAMES.get(e["base"], e["base"]) + (" Perpetual" if e["perp"] else "")
        if not e["perp"] and not any(x in MAIN_EX for x in ex):
            pref = "MEXC" if "mexc" in ex else "GATE" if "gate" in ex else None
            e["chart_symbol"] = f"{pref}:{e['symbol']}" if pref else e["symbol"]
        else:
            e["chart_symbol"] = e["symbol"]
        e["exchanges"] = [EX_LABEL.get(x, x) for x in ex]
    with _LOCK:
        if cat:
            _CAT["crypto"] = cat
            _CAT["updated"] = time.time()
        _CAT["status"] = status
    _save_disk()
    log.info("catalog refreshed: %d crypto pairs (%s)", len(cat), status)


def _disk_path():
    return settings.cache_dir / "catalog.json"


def _save_disk():
    try:
        settings.cache_dir.mkdir(parents=True, exist_ok=True)
        _disk_path().write_text(json.dumps(dict(updated=_CAT["updated"], crypto=_CAT["crypto"])))
    except Exception:
        pass


def load_disk():
    try:
        d = json.loads(_disk_path().read_text())
        if d.get("crypto") and not _CAT["crypto"]:
            _CAT["crypto"], _CAT["updated"] = d["crypto"], float(d.get("updated", 0))
    except Exception:
        pass


def _static():
    out = []
    for p in FX_PAIRS:
        a, b = p[:3], p[3:]
        out.append(dict(symbol=p, chart_symbol=p, name=f"{_FX_NAMES.get(a, a)} / {_FX_NAMES.get(b, b)}", cls="forex",
                        base=a, quote=b, exchanges=["FX"]))
    for s, name, cls in OTHER:
        out.append(dict(symbol=s, chart_symbol=s, name=name, cls=cls, base=s, quote="USD", exchanges=["CFD"]))
    for s, name in STOCKS.items():
        out.append(dict(symbol=s, chart_symbol=s, name=name, cls="stock", base=s, quote="USD", exchanges=["US"]))
    return out


STATIC = _static()


def _norm(q):
    q = (q or "").strip().upper()
    if ":" in q:
        q = q.split(":", 1)[1]
    return re.sub(r"[/\-_ .]", "", q)


def search(q, limit=40, kind=None):
    nq = _norm(q)
    ql = (q or "").strip().lower()
    with _LOCK:
        crypto = list(_CAT["crypto"].values())
    pool = ([] if kind in ("forex", "metal", "index", "energy", "commodity", "stock") else crypto) + \
           ([] if kind == "crypto" else STATIC)
    if kind:
        pool = [e for e in pool if e["cls"] == kind or (kind == "commodity" and e["cls"] in ("energy", "metal"))]
    if not nq:
        by = {e["symbol"]: e for e in pool}
        pop = [by[s] for s in POPULAR if s in by]
        rest = sorted((e for e in pool if e["symbol"] not in POPULAR), key=lambda e: -(e.get("vol_usd") or 0))
        return [_public(e) for e in (pop + rest)[:limit]]
    scored = []
    for e in pool:
        sym, base = e["symbol"].replace(".P", ""), e["base"]
        s = 0
        if sym == nq:
            s = 1000
        elif base == nq:
            s = 900
        elif sym.startswith(nq):
            s = 650
        elif base.startswith(nq):
            s = 600
        elif nq in sym:
            s = 300
        elif len(ql) >= 3 and ql in e.get("name", "").lower():
            s = 450
        if not s:
            continue
        if e.get("perp"):
            s -= 40
        if e.get("quote") in ("USDT", "USD"):
            s += 25
        s += math.log10(1 + (e.get("vol_usd") or 0)) * 4
        scored.append((s, e))
    scored.sort(key=lambda t: -t[0])
    out = [_public(e) for _, e in scored[:limit]]
    if not out and re.fullmatch(r"[A-Z0-9]{2,15}", nq):
        # not in our lists: let the chart try every source anyway
        out = [dict(symbol=nq, chart_symbol=nq, name="Search all exchanges", cls="unknown", exchanges=[])]
    return out


def _public(e):
    return {k: e.get(k) for k in ("symbol", "chart_symbol", "name", "cls", "base", "quote", "exchanges", "price",
                                  "change", "vol_usd", "perp")}


def lookup(symbol):
    nq = _norm(symbol)
    with _LOCK:
        e = _CAT["crypto"].get(nq) or _CAT["crypto"].get(nq + "USDT")
    return _public(e) if e else None


def status():
    return dict(pairs=len(_CAT["crypto"]), updated=_CAT["updated"], sources=_CAT["status"])

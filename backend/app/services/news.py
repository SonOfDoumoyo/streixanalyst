"""News for the analysis: the economic calendar (ForexFactory weekly feed) and headlines (public RSS feeds).

Every analysis gets the relevant upcoming events and recent headlines, plus a simple news-risk flag
(high-impact event close in time → spreads widen, stops slip, setups fail more often)."""
import email.utils
import html
import logging
import re
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import httpx


log = logging.getLogger("streix.news")
UA = "Mozilla/5.0 (compatible; StreixAnalyst/1.0; +https://streixanalyst.com)"
CAL_URLS = ["https://nfs.faireconomy.media/ff_calendar_thisweek.json",
            "https://nfs.faireconomy.media/ff_calendar_nextweek.json"]
FEEDS = {
    "crypto": [("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
               ("Cointelegraph", "https://cointelegraph.com/rss"), ("Decrypt", "https://decrypt.co/feed")],
    "macro": [("FXStreet", "https://www.fxstreet.com/rss/news"),
              ("Yahoo Finance", "https://finance.yahoo.com/news/rssindex")],
}
YAHOO_TICKER = "https://feeds.finance.yahoo.com/rss/2.0/headline?s={t}&region=US&lang=en-US"
CCY_WORDS = {
    "USD": ["dollar", "fed", "fomc", "powell", "treasury", "nonfarm", "payrolls", "cpi", "u.s.", "us economy"],
    "EUR": ["euro", "ecb", "lagarde", "eurozone", "euro area"],
    "GBP": ["pound", "sterling", "boe", "bank of england", "uk "],
    "JPY": ["yen", "boj", "bank of japan", "japan"],
    "AUD": ["aussie", "rba", "australia"], "NZD": ["kiwi", "rbnz", "new zealand"],
    "CAD": ["loonie", "bank of canada", "canada"], "CHF": ["franc", "snb", "swiss"],
    "CNY": ["china", "yuan", "pboc"],
}
ASSET_WORDS = {
    "XAUUSD": ["gold", "xau", "bullion"], "XAGUSD": ["silver", "xag"], "USOIL": ["oil", "crude", "opec", "wti"],
    "UKOIL": ["oil", "crude", "opec", "brent"], "NATGAS": ["natural gas", "natgas", "lng"], "COPPER": ["copper"],
    "US30": ["dow", "wall street", "stocks", "equities"], "NAS100": ["nasdaq", "tech stocks", "wall street", "stocks"],
    "US500": ["s&p", "wall street", "stocks", "equities"], "US2000": ["russell", "small caps"],
    "GER40": ["dax", "german"], "UK100": ["ftse", "uk stocks"], "JP225": ["nikkei", "japan"], "HK50": ["hang seng"],
    "DXY": ["dollar index", "dxy", "dollar"],
}
INDEX_CCY = {"GER40": "EUR", "FRA40": "EUR", "EU50": "EUR", "ESP35": "EUR", "UK100": "GBP", "JP225": "JPY",
             "HK50": "CNY", "CHINA50": "CNY", "AUS200": "AUD", "SWI20": "CHF"}
POS = ["surge", "soar", "rally", "rallies", "jump", "gain", "gains", "rise", "rises", "record high", "bullish", "beats",
       "upgrade", "approve", "approval", "approved", "inflows", "breakout", "rebound", "climbs", "all-time high", "adopt"]
NEG = ["plunge", "crash", "slump", "falls", "fall", "drop", "drops", "decline", "bearish", "misses", "downgrade", "hack",
       "exploit", "lawsuit", "sues", "ban", "outflows", "sell-off", "selloff", "liquidation", "fears", "tumble", "sinks",
       "slides", "recession", "fraud", "delist"]

_cache = {}
_lock = threading.Lock()
_client = {"c": None}


def set_client(c):
    """Swap the HTTP client (tests)."""
    _client["c"] = c


def _http():
    if _client["c"] is None:
        _client["c"] = httpx.Client(timeout=12, headers={"User-Agent": UA}, follow_redirects=True)
    return _client["c"]


def _cached(key, ttl, fn, stale_ok=6 * 3600):
    now = time.time()
    with _lock:
        hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    try:
        val = fn()
        with _lock:
            _cache[key] = (now, val)
        return val
    except Exception as e:
        log.info("news fetch %s failed: %s", key, e)
        if hit and now - hit[0] < stale_ok:
            return hit[1]
        return None


def _calendar_raw():
    events = []
    for url in CAL_URLS:
        r = _http().get(url)
        if r.status_code == 404 and "nextweek" in url:
            continue
        r.raise_for_status()
        for e in r.json():
            try:
                t = datetime.fromisoformat(e["date"]).astimezone(timezone.utc)
            except (KeyError, ValueError):
                continue
            events.append(dict(title=e.get("title", ""), country=(e.get("country") or "").upper(),
                               time=t.isoformat().replace("+00:00", "Z"), ts=t.timestamp(),
                               impact=e.get("impact", "Low"), forecast=e.get("forecast") or None,
                               previous=e.get("previous") or None, actual=e.get("actual") or None))
    events.sort(key=lambda e: e["ts"])
    return events


def calendar():
    return _cached("calendar", 3600, _calendar_raw) or []


def _text(el, tag):
    x = el.find(tag)
    return (x.text or "").strip() if x is not None and x.text else ""


def _parse_feed(source, content):
    root = ET.fromstring(content)
    items = []
    for it in root.iter("item"):
        title = html.unescape(re.sub(r"<[^>]+>", "", _text(it, "title")))
        link = _text(it, "link")
        pub = _text(it, "pubDate")
        try:
            ts = email.utils.parsedate_to_datetime(pub).timestamp() if pub else None
        except (TypeError, ValueError):
            ts = None
        if title:
            items.append(dict(title=title, link=link, source=source, ts=ts))
    if not items:                                           # Atom
        ns = "{http://www.w3.org/2005/Atom}"
        for it in root.iter(ns + "entry"):
            title = _text(it, ns + "title")
            ln = it.find(ns + "link")
            upd = _text(it, ns + "updated") or _text(it, ns + "published")
            try:
                ts = datetime.fromisoformat(upd.replace("Z", "+00:00")).timestamp() if upd else None
            except ValueError:
                ts = None
            if title:
                items.append(dict(title=html.unescape(title), link=ln.get("href") if ln is not None else "",
                                  source=source, ts=ts))
    return items[:60]


def feed(source, url, ttl=600):
    def get():
        r = _http().get(url)
        r.raise_for_status()
        return _parse_feed(source, r.content)
    return _cached("feed:" + url, ttl, get) or []


def tone_of(title):
    t = title.lower()
    s = sum(1 for w in POS if re.search(r"\b" + re.escape(w) + r"\b", t)) - \
        sum(1 for w in NEG if re.search(r"\b" + re.escape(w) + r"\b", t))
    return "positive" if s > 0 else "negative" if s < 0 else "neutral"


def currencies_for(spec):
    cls, base, quote = spec.get("asset_class"), spec.get("base"), spec.get("quote")
    if cls == "fx":
        return [base, quote]
    if cls == "index":
        return [INDEX_CCY.get(base, "USD")]
    return ["USD"]


def keywords_for(spec):
    from .catalog import CRYPTO_NAMES
    cls, base = spec.get("asset_class"), spec.get("base", "")
    if cls == "crypto":
        words = [base.lower()]
        name = CRYPTO_NAMES.get(base)
        if name and name.lower() != base.lower():
            words.append(name.lower())
        return words
    if cls == "fx":
        return CCY_WORDS.get(spec["base"], []) + CCY_WORDS.get(spec["quote"], [])
    if cls == "stock":
        return [base.lower()]
    return ASSET_WORDS.get(base, [base.lower()])


def headlines(spec, limit=8):
    cls = spec.get("asset_class")
    sources = list(FEEDS["crypto"] if cls == "crypto" else FEEDS["macro"])
    if cls == "stock":
        sources = [("Yahoo Finance", YAHOO_TICKER.format(t=spec["base"]))] + sources
    items = []
    for src, url in sources:
        items.extend(feed(src, url))
    words = keywords_for(spec)
    cutoff = time.time() - 4 * 86400

    def hit(title):
        t = " " + title.lower() + " "
        for w in words:
            if len(w) <= 4 and w.isalnum():
                if re.search(r"(?<![a-z0-9])" + re.escape(w) + r"(?![a-z0-9])", t):
                    return True
            elif w in t:
                return True
        return False

    seen, specific, general = set(), [], []
    for it in sorted(items, key=lambda x: -(x["ts"] or 0)):
        k = it["title"].lower()[:80]
        if k in seen or (it["ts"] and it["ts"] < cutoff):
            continue
        seen.add(k)
        d = dict(title=it["title"], link=it["link"], source=it["source"],
                 published=datetime.fromtimestamp(it["ts"], timezone.utc).isoformat().replace("+00:00", "Z")
                 if it["ts"] else None, tone=tone_of(it["title"]))
        (specific if hit(it["title"]) else general).append(d)
    out = specific[:limit]
    for d in general:
        if len(out) >= max(4, min(limit, len(specific) + 3)):
            break
        d["general"] = True
        out.append(d)
    return out


WINDOW_MIN = {"1m": 60, "5m": 90, "15m": 120, "30m": 180, "1h": 240, "4h": 720, "1D": 2880, "3D": 4320, "1W": 10080,
              "1M": 20160}


def for_symbol(spec, tf="1h", now=None):
    now = now or datetime.now(timezone.utc)
    ccys = currencies_for(spec)
    win = WINDOW_MIN.get(tf, 240)
    evs = []
    for e in calendar():
        if e["country"] not in ccys or e["impact"] not in ("High", "Medium"):
            continue
        mins = (e["ts"] - now.timestamp()) / 60
        if -60 <= mins <= max(win, 24 * 60):
            evs.append(dict(e, minutes_until=round(mins)))
    risk, note = "low", "No high-impact news for this market in the analysis window."
    soon = [e for e in evs if 0 <= e["minutes_until"] <= win]
    just = [e for e in evs if -30 <= e["minutes_until"] < 0 and e["impact"] == "High"]
    hi = [e for e in soon if e["impact"] == "High"]
    if just:
        risk, note = "high", f"{just[0]['country']} {just[0]['title']} was released {-just[0]['minutes_until']} min ago: " \
                             "expect fast, erratic moves and wide spreads for a while."
    elif hi:
        e = hi[0]
        risk, note = "high", f"{e['country']} {e['title']} (high impact) in {_human(e['minutes_until'])}. Spreads widen " \
                             "and stops slip around the release: wait for it, or trade smaller."
    elif soon:
        e = soon[0]
        risk, note = "medium", f"{e['country']} {e['title']} (medium impact) in {_human(e['minutes_until'])}."
    heads = headlines(spec)
    tones = [h["tone"] for h in heads if not h.get("general")]
    pos, neg = tones.count("positive"), tones.count("negative")
    tone = "positive" if pos > neg + 1 else "negative" if neg > pos + 1 else "mixed" if pos or neg else "neutral"
    for e in evs:
        e.pop("ts", None)
    return dict(currencies=ccys, events=evs[:12], risk=risk, note=note, headlines=heads,
                tone=dict(label=tone, positive=pos, negative=neg,
                          method="keyword scan of headline wording (context, not a prediction)"),
                calendar_ok=bool(calendar()), updated=now.isoformat().replace("+00:00", "Z"))


def _human(m):
    m = int(m)
    if m < 60:
        return f"{m} min"
    if m < 1440:
        return f"{m // 60} h {m % 60:02d} min"
    return f"{m // 1440} d {(m % 1440) // 60} h"


def upcoming(currencies=None, days=7, impact=("High", "Medium", "Low")):
    now = datetime.now(timezone.utc).timestamp()
    out = []
    for e in calendar():
        if currencies and e["country"] not in currencies:
            continue
        if e["impact"] not in impact and not (e["impact"] == "Holiday" and "Holiday" in impact):
            continue
        if now - 3 * 3600 <= e["ts"] <= now + days * 86400:
            d = dict(e)
            d["minutes_until"] = round((d.pop("ts") - now) / 60)
            out.append(d)
    return out

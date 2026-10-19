"""End-to-end API tests, fully offline (fake exchanges, news, Paystack, OPay and Anthropic).
Run from backend/:  python tests/test_api.py      (optional: TEST_BRAIN=/path/to/guru_brain.joblib)"""
import json
import os
import shutil
import sys
import tempfile
import time
import traceback
from datetime import timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE / "fakes"), str(HERE.parent)]
TMP = Path(tempfile.mkdtemp(prefix="streix_test_"))
os.environ.update(
    ENV="test", SECRET_KEY="test-secret-key-for-unit-tests-only-0123456789", DATA_DIR=str(TMP), ENABLE_BACKGROUND="0",
    ADMIN_EMAIL="owner@streixcorp.com", ADMIN_PASSWORD="Admin-Pass-2026!", FRONTEND_URL="http://localhost:3000",
    PAYSTACK_SECRET_KEY="sk_test_abc", PAYSTACK_DVA_ENABLED="1", OPAY_MERCHANT_ID="256612345678901",
    OPAY_PUBLIC_KEY="OPAYPUB123", OPAY_SECRET_KEY="OPAYSEC456", AI_PROVIDER="auto", ANTHROPIC_API_KEY="", GEMINI_API_KEY="",
    API_RATE_PER_MIN="1000000",                      # the whole suite runs from one address
    GURU_BRAIN_PATH=os.environ.get("TEST_BRAIN", str(TMP / "none.joblib")),
    MANUAL_ACCOUNTS=json.dumps([{"bank": "OPay", "number": "9160309499", "name": "NIMI DOUMOYO MEREMUBIO"},
                                {"bank": "UBA", "number": "2385227704", "name": "NIMI DOUMOYO MEREMUBIO"}]))

import logging                                        # noqa: E402
import httpx                                          # noqa: E402
logging.getLogger("httpx").setLevel(logging.WARNING)
from fastapi.testclient import TestClient             # noqa: E402

import fake_http                                      # noqa: E402
import fake_web                                       # noqa: E402
from app.config import settings                       # noqa: E402
from app.main import app                              # noqa: E402
from app.services import catalog, engine, news, opay, paystack, streixai   # noqa: E402
import market_data as md                              # noqa: E402

md.set_http(fake_web.Session())
news.set_client(httpx.Client(transport=httpx.MockTransport(fake_web.news_handler)))
PS = fake_web.FakePaystack("sk_test_abc")
paystack.set_client(httpx.Client(transport=httpx.MockTransport(PS.handler)))
OP = fake_web.FakeOPay("OPAYPUB123", "OPAYSEC456", "256612345678901")
opay.set_client(httpx.Client(transport=httpx.MockTransport(OP.handler)))
streixai.set_client(httpx.Client(transport=httpx.MockTransport(fake_web.ai_handler)))

H = {"X-Requested-With": "streix"}
RESULTS = []


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def client():
    return TestClient(app, base_url="http://localhost:8000")


def signup(c, email, exp="beginner", **kw):
    from app.security import signup_limiter
    signup_limiter.hits.clear()
    body = dict(email=email, password="Trade-2026x", first_name="Ada", last_name="Lovelace", experience=exp,
                accept_terms=True, learn=True, **kw)     # tests ask for learning consent so their rows can be exported
    return c.post("/api/auth/signup", json=body, headers=H)


def sse_text(resp):
    text, events = "", []
    for line in resp.text.splitlines():
        if line.startswith("data: "):
            e = json.loads(line[6:])
            events.append(e)
            if e["t"] == "delta":
                text += e["v"]
    return text, events


def run(name, fn, *a):
    t0 = time.time()
    try:
        fn(*a)
        RESULTS.append((name, True, ""))
        print(f"  ✓ {name}  ({time.time() - t0:.1f}s)")
    except Exception as e:
        RESULTS.append((name, False, f"{type(e).__name__}: {e}"))
        print(f"  ✗ {name}: {type(e).__name__}: {e}")
        traceback.print_exc()


# ───────────────────────── tests ─────────────────────────
def t_health(c):
    r = c.get("/api/health")
    check(r.status_code == 200 and r.json()["ok"], r.text)
    r = c.get("/api/config")
    check(r.json()["trial_days"] == 7 and r.json()["google"] is False, r.text)
    r = c.get("/api/auth/providers")
    check(r.json() == dict(google=False, linkedin=False, email=True, password_reset_email=False), r.text)


def t_signup_rules(c):
    check(c.post("/api/auth/signup", json=dict(email="bad", password="x", first_name="a", last_name="b",
                                               experience="beginner"), headers=H).status_code == 422, "bad email")
    r = c.post("/api/auth/signup", json=dict(email="a@b.co", password="short", first_name="a", last_name="b", accept_terms=True,
                                             experience="beginner"), headers=H)
    check(r.status_code == 422 and "8 characters" in r.json()["detail"], r.text)
    r = c.post("/api/auth/signup", json=dict(email="a@b.co", password="onlyletters", first_name="a", last_name="b", accept_terms=True,
                                             experience="beginner"), headers=H)
    check(r.status_code == 422, r.text)
    r = c.post("/api/auth/signup", json=dict(email="a@b.co", password="Good-pass1", first_name="a", last_name="b",
                                             experience="guru"), headers=H)
    check(r.status_code == 422 and "experience" in r.json()["detail"], r.text)


def t_signup_and_me(c):
    r = signup(c, "Ada@Example.com")
    check(r.status_code == 201, r.text)
    u = r.json()["user"]
    check(u["email"] == "ada@example.com" and "token" not in r.json(), u)
    check("sa_session" in r.cookies or "sa_session" in c.cookies, "session cookie")
    e = u["entitlements"]
    check(e["tier"] == "trial" and e["trial_days_left"] == 7 and "strategy" in e["features"], e)
    me = c.get("/api/auth/me").json()["user"]
    check(me["streak_days"] == 1 and me["needs_onboarding"] is False, me)
    check(signup(c, "ada@example.com").status_code == 409, "duplicate email")
    r = c.patch("/api/auth/me", json=dict(experience="advanced"))
    check(r.status_code == 403, "cookie writes need X-Requested-With")
    r = c.patch("/api/auth/me", json=dict(experience="advanced", settings=dict(candles=dict(up="#00ff00"))), headers=H)
    check(r.json()["user"]["experience"] == "advanced" and r.json()["user"]["settings"]["candles"]["up"] == "#00ff00",
          r.text)
    c.patch("/api/auth/me", json=dict(experience="beginner"), headers=H)


def t_login(c):
    c.post("/api/auth/logout", headers=H)
    c.cookies.clear()
    check(c.get("/api/auth/me").json()["user"] is None, "logged out")
    check(c.post("/api/auth/login", json=dict(email="ada@example.com", password="nope-123"), headers=H).status_code
          == 401, "wrong password")
    r = c.post("/api/auth/login", json=dict(email="ADA@example.com", password="Trade-2026x"), headers=H)
    check(r.status_code == 200, r.text)
    r = c.post("/api/auth/login", json=dict(email="ada@example.com", password="Trade-2026x"),
               headers=dict(H, **{"X-Client": "app"}))
    tok = r.json()["token"]
    c2 = client()
    me = c2.get("/api/auth/me", headers={"Authorization": f"Bearer {tok}"}).json()["user"]
    check(me and me["email"] == "ada@example.com", "bearer auth works")
    r = c2.patch("/api/auth/me", json=dict(first_name="Ada"), headers={"Authorization": f"Bearer {tok}"})
    check(r.status_code == 200, "bearer writes don't need the CSRF header")


def t_watchlist(c):
    wl = c.get("/api/user/watchlist").json()["symbols"]
    check(wl[:3] == ["BTCUSDT", "ETHUSDT", "SOLUSDT"] and len(wl) == 8, wl)
    wl = c.post("/api/user/watchlist", json=dict(symbol="mexc:capusdt"), headers=H).json()["symbols"]
    check(wl[-1] == "MEXC:CAPUSDT", wl)
    wl = c.delete("/api/user/watchlist/MEXC:CAPUSDT", headers=H).json()["symbols"]
    check("MEXC:CAPUSDT" not in wl, wl)
    wl = c.put("/api/user/watchlist", json=dict(symbols=["EURUSD", "BTCUSDT"]), headers=H).json()["symbols"]
    check(wl[0] == "EURUSD" and wl[1] == "BTCUSDT", wl)
    r = c.put("/api/user/drawings", json=dict(symbol="BTCUSDT", items=[dict(id="d1", type="hline", price=100.5)]),
              headers=H)
    check(r.json()["count"] == 1, r.text)
    check(c.get("/api/user/drawings?symbol=btcusdt").json()["items"][0]["price"] == 100.5, "drawings saved")
    # the analysis stays on its chart until it is cleaned; each symbol and timeframe keeps its own
    r = c.put("/api/user/analysis", json=dict(symbol="BTCUSDT", tf="1h", data=dict(symbol="BTCUSDT", tf="1h",
              verdict=dict(action="BUY"), candles=[[1700000000]])), headers=H)
    check(r.json()["ok"], r.text)
    a = c.get("/api/user/analysis?symbol=btcusdt&tf=1h").json()
    check(a["data"]["verdict"]["action"] == "BUY" and a["updated_at"], a)
    check(c.get("/api/user/analysis?symbol=btcusdt&tf=4h").json()["data"] is None, "another timeframe is empty")
    check(c.get("/api/user/analysis?symbol=ethusdt&tf=1h").json()["data"] is None, "another symbol is empty")
    c.put("/api/user/analysis", json=dict(symbol="BTCUSDT", tf="1h", data=dict(verdict=dict(action="SELL"))), headers=H)
    check(c.get("/api/user/analysis?symbol=btcusdt&tf=1h").json()["data"]["verdict"]["action"] == "SELL", "analysis replaced")
    check(c.delete("/api/user/analysis?symbol=btcusdt&tf=1h", headers=H).json()["ok"], "clean")
    check(c.get("/api/user/analysis?symbol=btcusdt&tf=1h").json()["data"] is None, "cleaned analysis is gone")


def t_search(c):
    catalog.refresh(force=True)
    st = catalog.status()
    check(st["pairs"] > 10 and "451" in str(st["sources"]["binance"]), st)       # fake = a US server: Binance refuses
    check(all(isinstance(v, int) for k, v in st["sources"].items() if k != "binance"), st)
    res = c.get("/api/market/search?q=cap").json()["results"]
    check(res[0]["symbol"] == "CAPUSDT" and res[0]["chart_symbol"] == "MEXC:CAPUSDT", res[:2])
    res = c.get("/api/market/search?q=newt").json()["results"]
    check(res[0]["chart_symbol"] == "GATE:NEWTUSDT", res[:2])
    res = c.get("/api/market/search?q=btc").json()["results"]
    check(res[0]["symbol"] == "BTCUSDT" and res[0]["name"] == "Bitcoin", res[:2])
    check(any(r["symbol"] == "BTCUSDT.P" for r in res), "perp listed")
    res = c.get("/api/market/search?q=gold").json()["results"]
    check(res[0]["symbol"] == "XAUUSD", res[:2])
    res = c.get("/api/market/search?q=eur/usd").json()["results"]
    check(res[0]["symbol"] == "EURUSD", res[:2])
    res = c.get("/api/market/search?q=").json()["results"]
    check(res[0]["symbol"] == "BTCUSDT" and len(res) == 40, [r["symbol"] for r in res[:5]])
    res = c.get("/api/market/search?q=zzzqq").json()["results"]
    check(res[0]["cls"] == "unknown", res)


def t_candles(c):
    fake_http.LOG.clear()
    r = c.get("/api/market/candles?symbol=BTCUSDT&tf=1h&bars=300")
    check(r.status_code == 200, r.text)
    d = r.json()
    check(d["source"] == "bybit" and len(d["candles"]) >= 300 and d["display"] == "BTC/USDT", (d["source"], len(d["candles"])))
    check(d["candles"][-1][0] > d["candles"][-2][0], "time ascending")
    for sym, tf, src in (("MEXC:CAPUSDT", "15m", "mexc"), ("GATE:NEWTUSDT", "1h", "gate"),
                         ("PERPXUSDT.P", "4h", "binancef"), ("OKX:ETHUSDT", "1h", "okx"), ("EURUSD", "15m", "dukascopy"),
                         ("CAPUSDT", "1h", "mexc"), ("SOLUSDT", "1W", "bybit")):
        r = c.get(f"/api/market/candles?symbol={sym}&tf={tf}&bars=200")
        check(r.status_code == 200 and r.json()["source"] == src, (sym, r.status_code, r.text[:200]))
    check(c.get("/api/market/candles?symbol=PERPXUSDT.P&tf=4h").json()["perp"] is True, "perp flag")
    r = c.get("/api/market/candles?symbol=NOPEZUSDT&tf=1h")
    check(r.status_code == 404 and "Couldn't load" in r.json()["detail"], r.text)
    r = c.get("/api/market/candles?symbol=BTCUSDT&tf=7m")
    check(r.status_code == 404 and "Unknown timeframe" in r.json()["detail"], r.text)
    r = c.get("/api/market/latest?symbol=BTCUSDT&tf=1m")
    check(r.status_code == 200 and len(r.json()["candles"]) == 3, r.text[:200])
    r = c.get("/api/market/quotes?symbols=BTCUSDT,EURUSD,NOPEUSDT")
    q = {x["symbol"]: x for x in r.json()["quotes"]}
    check(q["BTCUSDT"]["price"] > 0 and q["EURUSD"]["change"] is not None and "error" in q["NOPEUSDT"], q)
    check(c.get("/api/market/demo").status_code == 200, "demo")
    anon = client()
    check(anon.get("/api/market/candles?symbol=BTCUSDT").status_code == 401, "auth needed")


def t_divergence(c):
    """The divergence scorecard: nine oscillators, consistent counts, and the past-results disclaimer."""
    r = c.get("/api/market/divergence?symbol=BTCUSDT&tf=1h&bars=600")
    check(r.status_code == 200, r.text)
    d = r.json()
    check(len(d["indicators"]) == 9 and d["bars"] >= 200, (len(d["indicators"]), d.get("bars")))
    for row in d["indicators"]:
        check(row["signals"] == row["wins"] + row["losses"], row)
        check(row["win_rate"] is None or 0 <= row["win_rate"] <= 100, row)
    check(any("Past signals" in n for n in d["notes"]), d["notes"])


def t_analysis(c):
    before = c.get("/api/auth/me").json()["user"]["entitlements"]["usage"].get("analysis", 0)
    body = dict(symbol="BTCUSDT", tf="1h", account=1000, risk_pct=1,
                drawings=[dict(type="hline", price=101.0, label="my level"), dict(type="junk")])
    r = c.post("/api/analysis/run", json=body, headers=H)
    check(r.status_code == 200, r.text[:500])
    a = r.json()
    for k in ("verdict", "plan", "levels", "drawings", "candles", "report", "news", "meta", "analysis_id"):
        check(k in a, f"missing {k}")
    check(a["news"]["risk"] == "high" and "CPI" in a["news"]["note"], a["news"])
    check(a["verdict"].get("news_warning"), a["verdict"])
    check(any("Bitcoin" in h["title"] for h in a["news"]["headlines"]), a["news"]["headlines"])
    check(a["mode"] == "beginner" and a["report"] == a["report_beginner"], "beginner mode by experience")
    check(len(a["user_drawings"]) == 1 and a["user_drawings"][0].get("label") == "my level", a["user_drawings"])
    after = c.get("/api/auth/me").json()["user"]["entitlements"]["usage"]["analysis"]
    check(after == before + 1, (before, after))
    s = c.get(f"/api/analysis/{a['analysis_id']}/summary").json()["summary"]
    check(s["symbol"] == "BTC/USDT" and "report" in s, s.keys())
    r = c.post("/api/analysis/run", json=dict(symbol="EURUSD", tf="4h", mode="pro"), headers=H)
    check(r.status_code == 200 and r.json()["news"]["currencies"] == ["EUR", "USD"], r.text[:300])
    r = c.post("/api/analysis/run", json=dict(symbol="NOPEZUSDT", tf="1h"), headers=H)
    check(r.status_code == 422, r.text)
    check(c.get("/api/auth/me").json()["user"]["entitlements"]["usage"]["analysis"] == after + 1, "failed run refunded")
    h = c.get("/api/analysis/history").json()["items"]
    check(len(h) == 2 and h[0]["symbol"] == "EURUSD", h)


def t_review(c):
    a = c.post("/api/analysis/run", json=dict(symbol="SOLUSDT", tf="1h"), headers=H).json()
    p, atr = a["price"], a["atr"]
    r = c.post("/api/analysis/review", json=dict(symbol="SOLUSDT", tf="1h", side="long", entry=p, sl=p - 1.5 * atr,
                                                 tp=p + 3 * atr), headers=H)
    check(r.status_code == 200 and r.json()["ok"] and r.json()["verdict"], r.text[:300])
    r = c.post("/api/analysis/review", json=dict(symbol="SOLUSDT", tf="1h", side="long", entry=p, sl=p + atr,
                                                 tp=p + 3 * atr), headers=H)
    check(r.json()["ok"] is False and "stop must be below" in r.json()["text"], r.text)


def t_ai_offline(c):
    check(streixai.provider() == "offline", streixai.provider())
    r = c.post("/api/ai/chat", json=dict(message="What is an order block?"), headers=H)
    check(r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream"), r.text[:200])
    text, ev = sse_text(r)
    check("Order blocks" in text and ev[0]["t"] == "start" and ev[-1]["t"] == "done", text[:200])
    tid = ev[-1]["thread_id"]
    r = c.post("/api/ai/chat", json=dict(message="Explain this chart analysis", thread_id=tid, symbol="SOLUSDT",
                                         tf="1h"), headers=H)
    text, ev = sse_text(r)
    check("SOL/USDT" in text and ev[0]["has_context"] is True, text[:300])
    th = c.get("/api/ai/threads").json()["threads"]
    check(th[0]["thread_id"] == tid and th[0]["messages"] == 4, th)
    msgs = c.get(f"/api/ai/threads/{tid}").json()["messages"]
    check([m["role"] for m in msgs] == ["user", "assistant", "user", "assistant"], msgs)
    check(c.get("/api/ai/suggestions").json()["provider"] == "offline", "suggestions")


def t_ai_claude(c):
    settings.anthropic_api_key = "sk-ant-test"
    try:
        check(streixai.provider() == "anthropic", "provider")
        r = c.post("/api/ai/chat", json=dict(message="Should I buy now?", symbol="SOLUSDT", tf="1h"), headers=H)
        text, ev = sse_text(r)
        check(text.strip() == "Here is the plan: wait for the **entry**. Risk 1%.", text)
        meta = [e for e in ev if e["t"] == "meta"][0]
        check(meta["provider"] == "anthropic" and meta["model"] == settings.anthropic_model, meta)
        # provider down → honest fallback to the built-in answer
        streixai.set_client(httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(529, json={}))))
        text, ev = sse_text(c.post("/api/ai/chat", json=dict(message="what is leverage"), headers=H))
        check("unavailable" in text and "Leverage" in text, text[:200])
    finally:
        settings.anthropic_api_key = None
        streixai.set_client(httpx.Client(transport=httpx.MockTransport(fake_web.ai_handler)))


def t_gemini(c):
    """Gemini answers when it is the model with a key, and takes over when the first model is down."""
    signup(c, "gemini@example.com")
    settings.gemini_api_key = "g-test"
    try:
        check(streixai.provider() == "gemini" and streixai.providers() == ["gemini"], streixai.providers())
        text, ev = sse_text(c.post("/api/ai/chat", json=dict(message="What is a liquidity sweep?"), headers=H))
        meta = [e for e in ev if e["t"] == "meta"][0]
        check(meta["provider"] == "gemini" and meta["model"] == settings.gemini_model_fast and "liquidity sweep" in text,
              (meta, text[:200]))
        settings.anthropic_api_key = "fail"                  # Claude first in line, but overloaded
        check(streixai.providers() == ["anthropic", "gemini"], streixai.providers())
        text, ev = sse_text(c.post("/api/ai/chat", json=dict(message="What is a liquidity sweep?"), headers=H))
        meta = [e for e in ev if e["t"] == "meta"][0]
        check(meta["provider"] == "gemini" and "unavailable" not in text and "liquidity sweep" in text, (meta, text[:200]))
        settings.ai_provider = "gemini"
        check(streixai.providers() == ["gemini", "anthropic"], "AI_PROVIDER puts its model first")
    finally:
        settings.gemini_api_key = None
        settings.anthropic_api_key = None
        settings.ai_provider = "auto"


def t_sweeps(_c):
    """After a stop, a call is watched until its time is up: reaching the target afterwards is a stop sweep."""
    import numpy as np

    from app.services import excursion as ex
    t = np.arange(10) * 60
    h = np.array([100.5, 100, 99, 99.5, 101, 104.5, 104, 103, 102, 101.0])
    lo = np.array([99.5, 99, 97.5, 97.2, 99, 101, 103, 102, 101, 100.0])
    check(ex.excursions(t, h, lo, "long", 0, 100.0, 120, 2.0) == (1.25, 0.25), "worst and best while open")
    s = ex.after_stop(t, h, lo, "long", 98, 104, 120, 600, 2.0, 700)
    check(s["swept"] is True and abs(s["depth_r"] - 0.4) < 1e-9 and s["final"], s)
    s = ex.after_stop(t, h, lo, "long", 98, 110, 120, 600, 2.0, 700)
    check(s["swept"] is False and s["final"], ("no target after the stop: not a sweep", s))
    s = ex.after_stop(t, h, lo, "long", 98, 110, 120, 600, 2.0, 400)
    check(s["swept"] is None and not s["final"], ("still being watched", s))
    s = ex.after_stop(t, 200 - lo, 200 - h, "short", 102, 96, 120, 600, 2.0, 700)
    check(s["swept"] is True and abs(s["depth_r"] - 0.4) < 1e-9, ("short", s))


def t_selflearn(_c):
    """The self-learning check: sweep statistics, the note beside an analysis, and no probability shown until it has
    beaten the plain win rate on calls it has not seen."""
    import random

    from app.services import selflearn as sl
    rnd = random.Random(1)
    rows = []
    for i in range(240):
        win = rnd.random() < 0.45
        swept = None if win else rnd.random() < 0.3
        rows.append(dict(id=i, kind="analysis", symbol="BTCUSDT", tf="1h", grade=rnd.choice(["A", "B", "C"]), side="long",
                         type="limit", entry=100, sl=98, tp=104, p_tp=0.4, called=True, outcome="tp" if win else "sl",
                         r=2.0 if win else -1.05, swept=swept, depth=rnd.random() * 0.8 if swept else 0.3, post_final=True,
                         mae=0.5, cls="crypto"))
    m = sl.train(rows)
    ov = m["sweeps"]["overall"]
    check(m["settled"] == 240 and ov["stopped"] > 50 and 0 < ov["rate"] < 1 and ov["depth_p75"] > 0, ov)
    check(m["ship"] is False and m["weights"] is not None, "random outcomes must not ship a probability check")
    res = dict(tf="1h", symbol="BTCUSDT", decimals=2, meta=dict(asset_class="crypto"), verdict=dict(grade="A", trade=True),
               plan=dict(side="long", type="limit", entry=100.0, sl=98.0, tps=[103.0, 104.0], p_tp=[0.5, 0.4]))
    note = sl.note_for(res, m)
    check(note and "p_win" not in note and note["sweep"]["wider_sl"] < 98 and "swept" in note["message"], note)
    check(sl.note_for(res, sl.train(rows[:10])) is None, "too few calls: nothing to say")


def t_admin_accounts(c):
    """Admins suspend (signed out at once, sign-in refused with the reason), unsuspend and delete accounts."""
    signup(c, "suspect@example.com")
    adm = client()
    check(adm.post("/api/auth/login", json=dict(email="owner@streixcorp.com", password="Admin-Pass-2026!"),
                   headers=H).status_code == 200, "admin login")
    uid = c.get("/api/auth/me").json()["user"]["id"]
    r = adm.post(f"/api/admin/users/{uid}/suspend", json=dict(reason="chargeback"), headers=H)
    check(r.status_code == 200 and r.json()["user"]["is_active"] is False and r.json()["user"]["suspended_reason"] == "chargeback", r.text)
    check(c.get("/api/auth/me").json()["user"] is None, "a suspended account is signed out at once")
    r = client().post("/api/auth/login", json=dict(email="suspect@example.com", password="Trade-2026x"), headers=H)
    check(r.status_code == 403 and "suspended" in r.text and "chargeback" in r.text, r.text)
    me = adm.get("/api/auth/me").json()["user"]["id"]
    check(adm.post(f"/api/admin/users/{me}/suspend", json={}, headers=H).status_code == 409, "not yourself")
    check(adm.post(f"/api/admin/users/{uid}/unsuspend", headers=H).status_code == 200, "unsuspend")
    c2 = client()
    check(c2.post("/api/auth/login", json=dict(email="suspect@example.com", password="Trade-2026x"), headers=H).status_code == 200,
          "signs in again after unsuspend")
    r = adm.request("DELETE", f"/api/admin/users/{uid}", json=dict(confirm="wrong@example.com"), headers=H)
    check(r.status_code == 422, r.text)
    r = adm.request("DELETE", f"/api/admin/users/{uid}", json=dict(confirm="Suspect@example.com"), headers=H)
    check(r.status_code == 200 and r.json()["deleted"] == "suspect@example.com", r.text)
    check(c2.get("/api/auth/me").json()["user"] is None, "the deleted account's session is gone")
    r = client().post("/api/auth/login", json=dict(email="suspect@example.com", password="Trade-2026x"), headers=H)
    check(r.status_code == 401, r.text)
    users = adm.get("/api/admin/users?q=suspect").json()["users"]
    check(not users, users)
    check(c2.post("/api/admin/users/1/suspend", json={}, headers=H).status_code in (401, 403), "admins only")


def t_security(c):
    """Strict headers on every response, a cap on request size, and an account that locks under password guessing."""
    from app.security import account_failures, login_limiter
    r = c.get("/api/health")
    for k in ("X-Content-Type-Options", "X-Frame-Options", "Content-Security-Policy", "Referrer-Policy"):
        check(k.lower() in {x.lower() for x in r.headers}, (k, dict(r.headers)))
    r = c.post("/api/auth/login", content=b"x" * (9 * 1024 * 1024), headers={**H, "content-type": "application/json"})
    check(r.status_code == 413, r.status_code)
    signup(c, "guessme@example.com")
    for i in range(22):
        login_limiter.hits.clear()          # every guess from a "different" address
        r = client().post("/api/auth/login", json=dict(email="guessme@example.com", password=f"wrong-{i}x"), headers=H)
    check(r.status_code == 429 and "Too many wrong passwords" in r.text, r.text)
    login_limiter.hits.clear()
    r = client().post("/api/auth/login", json=dict(email="guessme@example.com", password="Trade-2026x"), headers=H)
    check(r.status_code == 429, "locked even with the right password until the lock ends")
    account_failures.hits.clear()
    login_limiter.hits.clear()
    r = client().post("/api/auth/login", json=dict(email="guessme@example.com", password="Trade-2026x"), headers=H)
    check(r.status_code == 200, r.text)


def _db():
    from app.db import SessionLocal
    return SessionLocal()


def _set_user(email, **fields):
    from app.models import User
    db = _db()
    u = db.query(User).filter(User.email == email).one()
    for k, v in fields.items():
        setattr(u, k, v)
    db.commit()
    db.close()


def t_free_limits(c):
    from app.models import utcnow
    signup(c, "free@example.com")
    _set_user("free@example.com", trial_ends_at=utcnow() - timedelta(days=1))
    e = c.get("/api/auth/me").json()["user"]["entitlements"]
    check(e["tier"] == "free" and e["limits"]["analysis"] == 5 and "strategy" in e["features"]
          and e["limits"]["strategy"] == 40, e)
    for i in range(5):
        check(c.post("/api/analysis/run", json=dict(symbol="ETHUSDT", tf="4h"), headers=H).status_code == 200, i)
    r = c.post("/api/analysis/run", json=dict(symbol="ETHUSDT", tf="4h"), headers=H)
    check(r.status_code == 429 and r.json()["detail"]["code"] == "limit" and "Upgrade" in r.json()["detail"]["message"],
          r.text)
    for _ in range(10):
        c.post("/api/ai/chat", json=dict(message="hi"), headers=H)
    r = c.post("/api/ai/chat", json=dict(message="hi"), headers=H)
    check(r.status_code == 429, r.status_code)
    for s in ["A1", "A2", "A3", "A4"]:
        c.post("/api/user/watchlist", json=dict(symbol=s), headers=H)
    r = c.post("/api/user/watchlist", json=dict(symbol="A5"), headers=H)
    check(r.status_code == 429 and "12" in r.json()["detail"]["message"], r.text)


def t_paystack(c):
    signup(c, "payer@example.com")
    plans = c.get("/api/billing/plans").json()
    # Pro is $15 a month; the naira charge is $15 x 1550 = ₦23,250. Yearly is $15 x 12 x 0.8 = $144 = ₦223,200.
    check(plans["quotes"]["pro"]["1"]["kobo"] == 2_325_000 and plans["quotes"]["pro"]["12"]["naira"] == 223_200, plans["quotes"])
    check(plans["quotes"]["org"]["1"]["usd"] == 10, "organization is $10 per person a month (one person by default)")
    check(plans["methods"] == dict(paystack=True, opay=True, dedicated_account=True, manual=True, crypto=False), plans["methods"])
    check(plans["manual_accounts"][0]["number"] == "9160309499", plans["manual_accounts"])
    r = c.post("/api/billing/checkout", json=dict(plan="pro", months=1, provider="paystack", channel="ussd"), headers=H)
    check(r.status_code == 200 and r.json()["url"].startswith("https://checkout.paystack.com/"), r.text)
    ref = r.json()["reference"]
    check(PS.tx[ref]["amount"] == 2_325_000 and PS.tx[ref]["channels"] == ["ussd"], PS.tx[ref])
    v = c.get(f"/api/billing/verify?reference={ref}").json()
    check(v["result"]["ok"] is False and v["user"]["entitlements"]["tier"] == "trial", v["result"])
    PS.tx[ref]["status"] = "success"
    v = c.get(f"/api/billing/verify?reference={ref}").json()
    check(v["result"]["ok"] and v["payment"]["status"] == "success" and v["user"]["entitlements"]["tier"] == "pro", v)
    exp1 = v["user"]["entitlements"]["plan_expires_at"]
    # replays: refresh, webhook — must not extend twice
    c.get(f"/api/billing/verify?reference={ref}")
    body = json.dumps(dict(event="charge.success", data=dict(reference=ref, status="success"))).encode()
    r = c.post("/api/billing/paystack/webhook", content=body, headers={"x-paystack-signature": PS.sign(body),
                                                                         "content-type": "application/json"})
    check(r.status_code == 200, r.text)
    exp2 = c.get("/api/auth/me").json()["user"]["entitlements"]["plan_expires_at"]
    check(exp1 == exp2, (exp1, exp2))
    # forged webhook
    r = c.post("/api/billing/paystack/webhook", content=body, headers={"x-paystack-signature": "0" * 128})
    check(r.status_code == 401, "bad signature refused")
    # underpaid transaction → review, not applied
    r = c.post("/api/billing/checkout", json=dict(plan="pro", months=3, provider="paystack"), headers=H)
    ref2 = r.json()["reference"]
    PS.tx[ref2].update(status="success", amount=100_000)
    body = json.dumps(dict(event="charge.success", data=dict(reference=ref2))).encode()
    c.post("/api/billing/paystack/webhook", content=body, headers={"x-paystack-signature": PS.sign(body)})
    p = [x for x in c.get("/api/billing/payments").json()["payments"] if x["reference"] == ref2][0]
    check(p["status"] == "review" and not p["applied"], p)
    # a stranger can't look at someone else's payment
    other = client()
    signup(other, "stranger@example.com")
    check(other.get(f"/api/billing/verify?reference={ref}").status_code == 404, "payment privacy")


def t_opay(c):
    r = c.post("/api/billing/checkout", json=dict(plan="pro", months=1, provider="opay"), headers=H)
    check(r.status_code == 200 and "cashier.opaycheckout.com" in r.json()["url"], r.text)
    ref = r.json()["reference"]
    c.post("/api/billing/opay/callback", json=dict(payload=dict(reference=ref, status="SUCCESS")))
    p = [x for x in c.get("/api/billing/payments").json()["payments"] if x["reference"] == ref][0]
    check(not p["applied"], "a callback alone proves nothing")
    OP.orders[ref]["status"] = "SUCCESS"
    c.post("/api/billing/opay/callback", json=dict(payload=dict(reference=ref)))
    p = [x for x in c.get("/api/billing/payments").json()["payments"] if x["reference"] == ref][0]
    check(p["applied"] and p["status"] == "success", p)


def t_dva(c):
    r = c.post("/api/billing/dva", headers=H)
    check(r.status_code == 422 and "phone" in r.json()["detail"], r.text)
    c.patch("/api/auth/me", json=dict(phone="+234 801 234 5678"), headers=H)
    r = c.post("/api/billing/dva", headers=H)
    check(r.json()["account"]["account_number"] == "9930000902", r.text)
    it = c.post("/api/billing/dva/intent", json=dict(plan="pro", months=1), headers=H).json()
    check(it["amount"] == 23250 and it["payment"]["status"] == "pending", it)
    exp_before = c.get("/api/auth/me").json()["user"]["entitlements"]["plan_expires_at"]
    cust = [k for k, v in PS.customers.items() if v["email"] == "payer@example.com"][0]
    PS.tx["T_DVA_1"] = dict(status="success", amount=2_325_000, currency="NGN", channel="dedicated_nuban", customer=cust)
    body = json.dumps(dict(event="charge.success", data=dict(reference="T_DVA_1", channel="dedicated_nuban",
                                                             authorization=dict(channel="dedicated_nuban")))).encode()
    r = c.post("/api/billing/paystack/webhook", content=body, headers={"x-paystack-signature": PS.sign(body)})
    check(r.json()["outcome"] == "applied", r.text)
    r = c.post("/api/billing/paystack/webhook", content=body, headers={"x-paystack-signature": PS.sign(body)})
    check(r.json()["outcome"] == "duplicate", r.text)
    exp_after = c.get("/api/auth/me").json()["user"]["entitlements"]["plan_expires_at"]
    check(exp_after > exp_before, (exp_before, exp_after))


PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 200


def t_manual_and_admin(c):
    signup(c, "transfer@example.com")
    r = c.post("/api/billing/manual/start", json=dict(plan="org", months=1, seats=6, account=1), headers=H)
    check(r.status_code == 200, r.text)
    d = r.json()
    ref = d["payment"]["reference"]
    check(len(ref) == 8 and ref.startswith("SA") and d["account"]["number"] == "2385227704" and d["amount"] == 46500, d)
    check(ref in d["instructions"] and "UBA" in d["instructions"], d["instructions"])
    r = c.post(f"/api/billing/manual/{ref}/proof", data=dict(payer_name="Ada Lovelace"),
               files=dict(file=("receipt.txt", b"hello", "text/plain")), headers=H)
    check(r.status_code == 415, r.text)
    r = c.post(f"/api/billing/manual/{ref}/proof", data=dict(payer_name="Ada Lovelace"),
               files=dict(file=("r.png", PNG, "image/png")), headers=H)
    check(r.status_code == 200 and r.json()["payment"]["status"] == "review", r.text)
    check(c.get("/api/auth/me").json()["user"]["entitlements"]["tier"] == "trial", "not unlocked before approval")
    check(c.get("/api/admin/stats").status_code == 403, "users can't open admin")
    adm = client()
    r = adm.post("/api/auth/login", json=dict(email="owner@streixcorp.com", password="Admin-Pass-2026!"), headers=H)
    check(r.status_code == 200 and r.json()["user"]["role"] == "admin", r.text)
    check(r.json()["user"]["entitlements"]["tier"] == "admin", "admin tier")
    st = adm.get("/api/admin/stats").json()
    check(st["pending_reviews"] >= 2 and st["users"] >= 5, st)
    pays = adm.get("/api/admin/payments?status=review").json()["payments"]
    mine = [p for p in pays if p["reference"] == ref][0]
    check(mine["has_proof"] and mine["user"]["email"] == "transfer@example.com", mine)
    pr = adm.get(f"/api/admin/payments/{mine['id']}/proof")
    check(pr.status_code == 200 and pr.content == PNG, pr.status_code)
    r = adm.post(f"/api/admin/payments/{mine['id']}/approve", json=dict(note="Seen in UBA app"), headers=H)
    check(r.status_code == 200 and r.json()["payment"]["applied"], r.text)
    check(adm.post(f"/api/admin/payments/{mine['id']}/approve", json={}, headers=H).status_code == 409, "no double apply")
    me = c.get("/api/auth/me").json()["user"]
    check(me["entitlements"]["tier"] == "org" and me["org"]["role"] == "owner" and me["org"]["seats"] >= 1000, me["org"])  # flat price: capacity is not a seat count
    code = me["org"]["invite_code"]
    stu = client()
    r = signup(stu, "student@example.com", invite_code=code)
    check(r.status_code == 201 and r.json()["user"]["entitlements"]["tier"] == "org", r.text)
    check(r.json()["user"]["org"]["invite_code"] is None, "members don't see the code")
    org = c.get("/api/user/org").json()
    check(org["org"]["used"] == 2 and len(org["members"]) == 2, org)
    # reject flow
    r = c.post("/api/billing/manual/start", json=dict(plan="pro", months=1, account=0), headers=H)
    ref2 = r.json()["payment"]["reference"]
    c.post(f"/api/billing/manual/{ref2}/proof", data=dict(payer_name="Ada"), files=dict(file=("r.png", PNG, "image/png")),
           headers=H)
    pid = [p for p in adm.get("/api/admin/payments?status=review").json()["payments"] if p["reference"] == ref2][0]["id"]
    r = adm.post(f"/api/admin/payments/{pid}/reject", json=dict(note="No transfer found"), headers=H)
    check(r.json()["payment"]["status"] == "rejected", r.text)
    # admin tools
    users = adm.get("/api/admin/users?q=free").json()
    check(users["total"] == 1, users)
    uid = users["users"][0]["id"]
    r = adm.patch(f"/api/admin/users/{uid}", json=dict(pro_days=30), headers=H)
    check(r.json()["user"]["tier"] == "pro", r.text)
    r = adm.post(f"/api/admin/users/{uid}/password", headers=H)
    temp = r.json()["temporary_password"]
    check(client().post("/api/auth/login", json=dict(email="free@example.com", password=temp), headers=H).status_code
          == 200, "temporary password works")
    s = adm.put("/api/admin/settings", json=dict(pricing=dict(pro_monthly=20), announcement="Welcome!"), headers=H)
    check(s.json()["pricing"]["pro_monthly"] == 20, s.text)
    check(c.get("/api/billing/plans").json()["quotes"]["pro"]["1"]["naira"] == 31_000, "new price used ($20 x 1550)")
    check(c.get("/api/config").json()["announcement"] == "Welcome!", "announcement")
    sysd = adm.get("/api/admin/system").json()
    check(sysd["paystack"] and sysd["ai_provider"] == "offline" and "brain" in sysd["engine"], sysd)
    check(len(adm.get("/api/admin/actions").json()["items"]) >= 4, "audit log")
    check(adm.patch(f"/api/admin/users/{adm.get('/api/auth/me').json()['user']['id']}", json=dict(role="user"),
                    headers=H).status_code == 409, "admin can't demote self")


def t_password_change(c):
    cc = client()
    signup(cc, "pw@example.com")
    old = cc.cookies.get("sa_session")
    r = cc.post("/api/auth/password", json=dict(current_password="wrong", new_password="New-pass-99"), headers=H)
    check(r.status_code == 401, r.text)
    r = cc.post("/api/auth/password", json=dict(current_password="Trade-2026x", new_password="New-pass-99"), headers=H)
    check(r.status_code == 200, r.text)
    stale = client()
    stale.cookies.set("sa_session", old)
    check(stale.get("/api/auth/me").json()["user"] is None, "old sessions are signed out")
    r = cc.post("/api/auth/forgot", json=dict(email="pw@example.com"), headers=H)
    check(r.json()["email_enabled"] is False, r.text)


def t_brain_status(c):
    st = engine.status()["brain"]
    want = "trained" if os.environ.get("TEST_BRAIN") else "untrained"
    check(st["status"] == want, st)


# ───────────────────────── phase 2 ─────────────────────────
def t_practice(c):
    signup(c, "prac@example.com", "intermediate")
    a = c.post("/api/analysis/run", json=dict(symbol="BTCUSDT", tf="1h"), headers=H).json()
    p, atr = a["price"], a["atr"]
    lv = sorted(a["levels"], key=lambda x: -x["strength"])[:2]
    drawings = [dict(type="hline", price=lv[0]["price"] + 0.1 * atr, label="my S/R"),
                dict(type="hline", price=p + 7.3 * atr), dict(type="zone", bottom=lv[1]["price"] - 0.2 * atr,
                                                              top=lv[1]["price"] + 0.2 * atr)]
    r = c.post("/api/practice/score", json=dict(symbol="BTCUSDT", tf="1h", bias="short", drawings=drawings,
                                               trade=dict(side="short", entry=p + 0.5 * atr, sl=p + 1.8 * atr,
                                                          tp=p - 2.5 * atr)), headers=H)
    check(r.status_code == 200, r.text)
    d = r.json()
    b = d["breakdown"]
    check(0 <= d["score"] <= 100 and d["score"] == b["levels"]["score"] + b["bias"]["score"] + b["trade"]["score"], d["score"])
    check(b["levels"]["count"] == 3 and 0 <= b["levels"]["recall"] <= 1 and d["corrections"] and d["analysis_id"], b["levels"])
    check(all(x["layer"] == "practice" and x["t2"] > x["t1"] for x in d["corrections"]), d["corrections"][:1])
    check(d["good"] or d["improve"], "feedback")
    text, ev = sse_text(c.post("/api/ai/chat", json=dict(message="Coach me on this practice",
                                                         analysis_id=d["analysis_id"]), headers=H))
    check(ev[0]["has_context"] and len(text) > 40, text[:200])
    ch = c.get("/api/practice/challenge").json()
    r = c.post("/api/practice/score", json=dict(symbol=ch["symbol"], tf=ch["tf"], bias="neutral", challenge=ch["id"]),
               headers=H)
    check(r.status_code == 200 and r.json()["challenge"] == ch["id"], r.text[:300])
    board = c.get("/api/practice/leaderboard").json()
    check(board["entries"] and board["entries"][0]["you"], board)
    check(c.get("/api/practice/history").json()["stats"]["attempts"] == 2, "history")
    check(c.post("/api/practice/score", json=dict(symbol="BTCUSDT", tf="1h"), headers=H).status_code == 422, "empty")


def t_strategy(c):
    signup(c, "lab@example.com", "advanced")
    r = c.post("/api/strategy/parse", json=dict(text="Buy when EMA 50 is above EMA 200 and RSI crosses back above 30, "
                                                     "stop 1.5 ATR, target 2R"), headers=H).json()
    types = [x["type"] for x in r["spec"]["conditions"]]
    check("trend_ema" in types and r["spec"]["target"]["type"] == "rr" and r["spec"]["target"]["value"] == 2, r)
    lib = c.get("/api/strategy/library").json()
    tpl = lib["templates"][0]
    d = c.post("/api/strategy/run", json=dict(symbol="BTCUSDT", tf="1h", spec=tpl, bars=1000), headers=H)
    check(d.status_code == 200, d.text[:300])
    d = d.json()
    check(d["live"]["total"] == len(tpl["conditions"]) and d["costs"]["round_trip_pct"] > 0 and "trades" in d["stats"], d["live"])
    check(all(t["entry_t"] <= t["exit_t"] for t in d["trades"]), "trade times")
    s = c.post("/api/strategy/saved", json=dict(name="Pullback", spec=tpl), headers=H).json()
    c.post("/api/strategy/run", json=dict(symbol="BTCUSDT", tf="1h", spec=s["spec"], save_id=s["id"], bars=1000), headers=H)
    check(c.get("/api/strategy/saved").json()["items"][0]["last_symbol"] == "BTCUSDT", "last run saved")
    bad = c.post("/api/strategy/run", json=dict(symbol="BTCUSDT", tf="1h", spec=dict(conditions=[dict(type="nope")])),
                 headers=H)
    check(bad.status_code == 422, bad.text)
    d1 = c.post("/api/strategy/run", json=dict(symbol="BTCUSDT", tf="1D", spec=lib["templates"][3], bars=1000), headers=H)
    check(d1.status_code == 200 and any("Session" in n for n in d1.json()["notes"]), d1.text[:300])


def t_scalp_template(c):
    """S.C.A.L.P. (London sweep): the premium/discount condition matches its definition, the template keeps its
    parts, and the API runs it on a live chart."""
    import numpy as np
    import pandas as pd
    from app.services import strategy as stg
    idx = pd.date_range("2026-01-05 00:00", periods=300, freq="1h", tz="UTC")
    rng = np.random.default_rng(3)
    close = 100 + np.cumsum(rng.normal(0, 0.5, 300))
    df = pd.DataFrame({"open": close, "high": close + 0.4, "low": close - 0.4, "close": close, "volume": 1000.0}, index=idx)
    ctx = stg.Context(df, "1h")
    lg, sh = stg.condition_masks(ctx, dict(type="premium_discount", lookback=50))
    hi = pd.Series(df["high"].to_numpy()).rolling(50).max().to_numpy()
    lo = pd.Series(df["low"].to_numpy()).rolling(50).min().to_numpy()
    mid = (hi + lo) / 2
    ok = ~np.isnan(mid)
    check(not lg[:49].any() and not sh[:49].any(), "no premium/discount before 50 candles")
    check(np.array_equal(lg, ok & (close < mid)) and np.array_equal(sh, ok & (close > mid)),
          "longs in the discount half, shorts in the premium half")
    check(stg.sanitize(dict(conditions=[dict(type="premium_discount", lookback=9000)]))["conditions"][0]["lookback"] == 300,
          "lookback is capped")
    signup(c, "scalp@example.com", "advanced")
    lib = c.get("/api/strategy/library").json()
    scalp = next((x for x in lib["templates"] if x["id"] == "scalp_london"), None)
    check(scalp is not None and [x["type"] for x in scalp["conditions"]] == ["session", "sweep", "structure", "premium_discount"],
          scalp)
    check(scalp["conditions"][0]["names"] == ["london"], scalp["conditions"][0])
    d = c.post("/api/strategy/run", json=dict(symbol="BTCUSDT", tf="1h", spec=scalp, bars=1000), headers=H)
    check(d.status_code == 200 and d.json()["live"]["total"] == 4, d.text[:300])


def t_tracker_rules(c):
    import numpy as np

    from app.services import tracker as tk
    t0, sec = 1_700_000_000, 3600

    def res(rows, kind="limit", side="long", entry=100.0, sl=95.0, tp=110.0, now=None):
        t = np.array([t0 + i * sec for i in range(len(rows))], dtype=float)
        o, h, lo, cl = (np.array([r[k] for r in rows], dtype=float) for k in range(4))
        return tk.resolve(t, o, h, lo, cl, t0, sec, side, kind, entry, sl, tp, 0.001, 0.0005,
                          now if now is not None else t0 + len(rows) * sec, expiry=5, max_hold=10)
    r = res([(102, 103, 101, 102), (101, 101.5, 99.5, 100), (100, 105, 99, 104), (104, 111, 103, 110)])
    check(r["status"] == "tp" and abs(r["r"] - (2 - 0.1 / 5)) < 1e-9, r)
    r = res([(100, 111, 94, 100)], kind="market")
    check(r["status"] == "sl" and abs(r["r"] - (-1 - 0.15 / 5)) < 1e-9, ("stop first", r))
    r = res([(101, 111, 99, 105), (105, 106, 104, 105)])
    check(r["status"] == "open", ("only the stop can trigger on the fill candle", r))
    r = res([(101, 110.5, 100.5, 108)])
    check(r["status"] == "missed", ("target before the fill cancels the order", r))
    r = res([(102, 103, 101, 102)] * 6)
    check(r["status"] == "expired", r)
    r = res([(102, 103, 101, 102)] * 2, now=t0 + 2 * sec)
    check(r["status"] == "pending", r)
    r = res([(100, 101, 99, 100), (90, 91, 88, 90)], kind="market")
    check(r["status"] == "sl" and abs(r["exit"] - 90) < 1e-9, ("gap through the stop fills at the open", r))
    r = res([(100, 101, 99.5, 100)] * 12, kind="market")
    check(r["status"] == "time" and r["exit_t"] == t0 + 10 * sec, ("time exit", r))
    r = res([(102, 103, 101, 102), (102, 103, 101, 102)], kind="stop")
    check(r["status"] == "open" and r["fill"] == 102, ("a stop order that gaps fills at the worse open", r))
    r = res([(99, 100.5, 98, 99), (99, 99.5, 89, 90)], side="short", sl=105.0, tp=90.0)
    check(r["status"] == "tp" and abs(r["r"] - (2 - 0.1 / 5)) < 1e-9, ("short", r))
    check(tk.fine_tf("1h") == "5m" and tk.fine_tf("4h") == "15m" and tk.fine_tf("1D") == "1h" and tk.fine_tf("1m") == "1m",
          "fine timeframes")


def t_track_record(c):
    import numpy as np
    import pandas as pd

    from app.models import AnalysisLog, jdump, utcnow
    from app.services import tracker as tk
    signup(c, "track@example.com")
    uid = c.get("/api/auth/me").json()["user"]["id"]
    db = _db()
    t_call = utcnow() - timedelta(hours=10)

    def mk(side, entry, sl, tp, kind="market", called=True, grade="A", minutes=0):
        row = AnalysisLog(user_id=uid, kind="analysis", symbol="TRACKUSDT", tf="1h", price=entry, side=side,
                          entry=entry, sl=sl, tp=tp, grade=grade, created_at=t_call + timedelta(minutes=minutes),
                          summary=jdump(dict(symbol="TRACK/USDT", plan=dict(type=kind), verdict=dict(trade=called))))
        db.add(row)
        db.commit()
        return row.id
    a = mk("long", 100.0, 95.0, 110.0)
    b = mk("long", 100.5, 95.5, 110.5, minutes=5)
    s = mk("short", 100.0, 105.0, 90.0, kind="limit", called=False, grade="C")
    db.close()

    def fetch(sym, tf, start):
        if sym != "TRACKUSDT":
            raise md.DataError("not in this test")
        idx = pd.date_range(start.floor("5min"), pd.Timestamp.now(tz="UTC"), freq="5min")
        x = np.minimum(100 + np.arange(len(idx)) * 0.25, 112.0)
        df = pd.DataFrame(dict(open=x, high=x + 0.2, low=x - 0.2, close=x + 0.1, volume=1.0), index=idx)
        return dict(df=df, forming=None, sub="crypto_major")
    tk.run_once(fetch=fetch)
    db = _db()
    ra, rb, rs = (db.get(AnalysisLog, i) for i in (a, b, s))
    check(ra.outcome == "tp" and ra.outcome_r > 1.9 and ra.called is True and ra.plan_type == "market", (ra.outcome, ra.outcome_r))
    check(rb.outcome == "dup" and rb.dup_of == a, (rb.outcome, rb.dup_of))
    check(rs.outcome == "sl" and rs.outcome_r < -1, (rs.outcome, rs.outcome_r))
    db.close()
    pub = client().get("/api/track-record?days=30").json()
    check(pub["summary"]["resolved"] == 1 and pub["summary"]["wins"] == 1, pub["summary"])
    check(pub["compare"]["rejected"]["resolved"] == 1 and pub["recent"][0]["id"] == a and "never edited" in pub["method"],
          pub["compare"])
    allc = client().get("/api/track-record?days=30&calls=all").json()
    check(allc["summary"]["resolved"] == 2 and {g["grade"] for g in allc["by_grade"]} >= {"A", "C"}, allc["by_grade"])
    mine = c.get("/api/track-record?scope=mine&calls=all").json()
    check(mine["summary"]["calls"] == 2 and mine["summary"]["resolved"] == 2, mine["summary"])
    check(client().get("/api/track-record?scope=mine").status_code == 401, "mine needs sign-in")


def t_alerts(c):
    from app.models import utcnow
    from app.services import alerts as al
    signup(c, "alerts@example.com")
    px = c.get("/api/market/latest?symbol=BTCUSDT&tf=1m").json()["price"]
    r = c.post("/api/alerts", json=dict(symbol="BTCUSDT", op="above", price=round(px * 1.05, 2), note="breakout",
                                        tf="1h", email=True), headers=H)
    check(r.status_code == 200 and abs(r.json()["last_price"] - px) < 1e-6, r.text)
    above = r.json()["id"]
    r = c.post("/api/alerts", json=dict(symbol="BTCUSDT", op="cross", price=round(px * 0.97, 2)), headers=H)
    cross = r.json()["id"]
    check(c.post("/api/alerts", json=dict(symbol="BTCUSDT", op="above"), headers=H).status_code == 422, "needs a price")
    now = utcnow()
    ts = int(now.timestamp()) if now.tzinfo else int((now - now.__class__(1970, 1, 1)).total_seconds())
    db = _db()
    n = al.check_prices(db, latest=lambda s: dict(price=px * 1.06, decimals=2,
                                                  candles=[[ts - 60, px, px * 1.06, px * 0.99, px * 1.06, 1.0]]))
    db.close()
    check(n == 1, ("only the above alert fires", n))
    items = {a["id"]: a for a in c.get("/api/alerts").json()["items"]}
    check(items[above]["status"] == "triggered" and items[cross]["status"] == "active", items)
    nt = c.get("/api/alerts/notifications").json()
    check(nt["unread"] == 1 and "BTCUSDT rose to" in nt["items"][0]["title"] and "breakout" in nt["items"][0]["body"], nt)
    db = _db()
    n = al.check_prices(db, latest=lambda s: dict(price=px, decimals=2,
                                                  candles=[[ts, px * 1.06, px * 1.06, px * 0.96, px, 1.0]]))
    db.close()
    check(n == 1, ("a wick through the level counts as a cross", n))
    c.post("/api/alerts/notifications/read", json=dict(all=True), headers=H)
    check(c.get("/api/alerts/notifications").json()["unread"] == 0, "read")
    tpl = c.get("/api/strategy/library").json()["templates"][0]
    st = c.post("/api/strategy/saved", json=dict(name="Pullback", spec=tpl), headers=H).json()
    r = c.post("/api/alerts", json=dict(kind="strategy", symbol="BTCUSDT", tf="1h", strategy_id=st["id"]), headers=H)
    check(r.status_code == 200, r.text)
    bar = ts - 2 * 3600
    sig = dict(symbol="BTC/USDT", tf="1h", signal="long", price=100.0, decimals=2, entry=100.0, stop=95.0, target=110.0)
    db = _db()
    check(al.check_strategies(db, now=now, live=lambda *a: dict(sig, time=bar)) == 0, "first look only arms it")
    check(al.check_strategies(db, now=now + timedelta(minutes=10), live=lambda *a: dict(sig, time=bar)) == 0, "same bar")
    check(al.check_strategies(db, now=now + timedelta(hours=3), live=lambda *a: dict(sig, time=bar + 3600)) == 1, "fires")
    db.close()
    nt = c.get("/api/alerts/notifications").json()
    check("Pullback: Long signal" in nt["items"][0]["title"] and "95.00" in nt["items"][0]["body"], nt["items"][0])
    _set_user("alerts@example.com", trial_ends_at=utcnow() - timedelta(days=1))
    lst = c.get("/api/alerts").json()
    check(lst["active"] == 1, ("both price alerts fired once and stopped", [(a["kind"], a["status"], a["fired"]) for a in lst["items"]]))
    check(c.patch(f"/api/alerts/{above}", json=dict(status="active"), headers=H).status_code == 200, "re-arm")
    r = c.patch(f"/api/alerts/{cross}", json=dict(status="active"), headers=H)
    check(r.status_code == 429 and r.json()["detail"]["code"] == "limit", ("free: 2 active max", r.text))
    check(c.delete(f"/api/alerts/{above}", headers=H).status_code == 200, "delete")
    check(c.patch(f"/api/alerts/{cross}", json=dict(status="active"), headers=H).status_code == 200, "room again")


def t_push(c):
    """Phone alerts are off until the VAPID keys are set. Then a device subscribes, an alert reaches every device, a
    device the push service reports as gone is dropped, and unsubscribing turns a device off. The push is faked here."""
    from app.config import settings
    from app.models import User
    from app.services import alerts as al
    from app.services import push as pu
    signup(c, "phone@example.com")
    ok_ep = "https://push.example/device-ok-" + "x" * 12
    gone_ep = "https://push.example/device-gone-" + "x" * 12
    keys_body = dict(p256dh="p" * 20, auth="a" * 10)
    check(c.get("/api/push").json()["available"] is False, "phone alerts are off until the VAPID keys are set")
    check(c.post("/api/push/subscribe", json=dict(endpoint=ok_ep, keys=keys_body), headers=H).status_code == 503,
          "subscribing is refused while phone alerts are off")
    saved = (settings.vapid_public_key, settings.vapid_private_key, settings.vapid_subject)
    real_send, sent = pu._send_one, []

    def fake_send(sub, payload):
        sent.append((sub.endpoint, payload))
        return ("gone", None) if "gone" in sub.endpoint else ("sent", None)

    try:
        settings.vapid_public_key, settings.vapid_private_key = "BPUBTEST", "PRIVTEST"
        settings.vapid_subject = "mailto:test@example.com"
        pu._send_one = fake_send
        check(c.get("/api/push").json()["available"] is True, "on once the keys are set")
        check(c.post("/api/push/subscribe", json=dict(endpoint="http://push.example/" + "x" * 20, keys=keys_body),
                     headers=H).status_code == 422, "push addresses must be https")
        check(c.post("/api/push/subscribe", json=dict(endpoint=ok_ep, keys=keys_body), headers=H).json()["devices"] == 1,
              "first device")
        check(c.post("/api/push/subscribe", json=dict(endpoint=gone_ep, keys=keys_body), headers=H).json()["devices"] == 2,
              "second device")
        check(c.post("/api/push/subscribe", json=dict(endpoint=ok_ep, keys=dict(p256dh="q" * 20, auth="b" * 10)),
                     headers=H).json()["devices"] == 2, "the same device again is not a new one")
        db = _db()
        u = db.query(User).filter(User.email == "phone@example.com").one()
        al.notify(db, u, "BTCUSDT rose to 100", "Your level was hit.", "/terminal?s=BTCUSDT&tf=1h")
        db.commit()
        db.close()
        check(sorted(e for e, _ in sent) == sorted([ok_ep, gone_ep]), ("both devices were tried", sent))
        check(sent[0][1]["title"] == "BTCUSDT rose to 100" and sent[0][1]["url"] == "/terminal?s=BTCUSDT&tf=1h", sent[0])
        check(c.get("/api/push").json()["devices"] == 1, "the device the push service dropped was removed")
        test_result = c.post("/api/push/test", headers=H).json()
        check(test_result["sent"] == 1 and test_result["removed"] == 0, ("the test reaches the one device left", test_result))
        check(c.post("/api/push/unsubscribe", json=dict(endpoint=ok_ep), headers=H).status_code == 200, "unsubscribe")
        check(c.get("/api/push").json()["devices"] == 0, "no devices left")
    finally:
        settings.vapid_public_key, settings.vapid_private_key, settings.vapid_subject = saved
        pu._send_one = real_send


def t_replay(c):
    """A replay stops the chart at the chosen moment, analyses it from candles that had closed by then, and scores the
    call once it is revealed. Headlines are left out, and a moment in the future is refused."""
    import pandas as pd
    from app.models import AnalysisLog, utcnow
    signup(c, "replay@example.com")
    at_iso = (utcnow() - timedelta(days=3)).replace(minute=0, second=0, microsecond=0).isoformat() + "Z"
    at_ts = int(pd.Timestamp(at_iso).timestamp())
    cs = c.get("/api/market/candles", params=dict(symbol="BTCUSDT", tf="1h", bars=200, at=at_iso)).json()
    check(cs["candles"] and all(row[0] + 3600 <= at_ts for row in cs["candles"]), "no candle that closes after the moment")
    check(cs["replay_at"].startswith(at_iso[:13]), ("the chart says where it stopped", cs.get("replay_at")))
    ahead = c.get("/api/market/candles", params=dict(symbol="BTCUSDT", tf="1h", bars=200, at=at_iso, ahead=48)).json()
    check(max(row[0] for row in ahead["candles"]) > at_ts, "revealed candles come after the moment")
    future = (utcnow() + timedelta(days=1)).isoformat() + "Z"
    check(c.post("/api/replay/analyze", json=dict(symbol="BTCUSDT", tf="1h", at=future), headers=H).status_code == 422,
          "a moment in the future is refused")
    r = c.post("/api/replay/analyze", json=dict(symbol="BTCUSDT", tf="1h", at=at_iso), headers=H)
    check(r.status_code == 200, r.text)
    rep = r.json()
    check(rep["news"]["risk"] == "unknown" and rep["replay_id"], "a replay leaves out today's headlines")
    px = cs["candles"][-1][4]
    check(c.post("/api/replay/reveal", json=dict(replay_id=rep["replay_id"], side="long", entry=px), headers=H).status_code == 422,
          "a call needs entry, stop and target")
    r = c.post("/api/replay/reveal", json=dict(replay_id=rep["replay_id"], side="long", entry=px, sl=px * 0.9, tp=px * 1.2),
               headers=H)
    check(r.status_code == 200, r.text)
    out = r.json()
    check(out["final"] in (True, False) and out["user"] and out["user"]["status"], out)
    db = _db()
    n = db.query(AnalysisLog).filter(AnalysisLog.kind == "replay").count()
    db.close()
    check(n >= 1, "the replay is kept for the learning export, dated to its moment")


def t_terms_and_site(c):
    """Sign-up needs the Terms ticked; the public site endpoint gives the contact details and the Terms version."""
    from app.security import signup_limiter
    signup_limiter.hits.clear()
    r = c.post("/api/auth/signup", json=dict(email="terms@example.com", password="Trade-2026x", first_name="A",
                                             last_name="B", experience="beginner"), headers=H)
    check(r.status_code == 422 and "Terms" in r.text, r.text)
    r = signup(c, "terms-ok@example.com")
    check(r.status_code == 201, r.text)
    s = c.get("/api/site").json()
    check(s["terms_version"] and s["trial_days"] == 30 and s["product"] == "StreixAnalyst", s)
    check(all(v for v in s["contact"].values()), "only filled-in contact details are shown")


def t_learning_export(c):
    r = c.post("/api/auth/login", json=dict(email="owner@streixcorp.com", password="Admin-Pass-2026!"), headers=H)
    check(r.status_code == 200, r.text)
    d = c.get("/api/admin/learning").json()
    check(d["calls"]["resolved"] >= 2 and d["practice"]["total"] >= 2, d)
    r = c.get("/api/admin/learning/export?dataset=calls")
    lines = [json.loads(x) for x in r.text.splitlines() if x]
    check(r.status_code == 200 and lines and all(x["outcome"] in ("tp", "sl", "time") for x in lines), r.text[:200])
    r = c.get("/api/admin/learning/export?dataset=practice&min_score=0")
    check(r.status_code == 200 and len(r.text.splitlines()) >= 2 and "drawings" in r.text, r.text[:200])
    check(c.get("/api/admin/learning").json()["last_export"]["detail"]["rows"] >= 2, "audited")
    signup(c, "nosy@example.com")
    check(c.get("/api/admin/learning/export").status_code == 403, "admins only")


def t_stage2(c):
    """Support messages, donations (confirmed with Paystack before they count) and the Terms gate for accounts made
    before an update, plus learning consent."""
    from sqlalchemy import select
    from app.db import SessionLocal
    from app.models import User
    from app.security import signup_limiter
    signup_limiter.hits.clear()
    r = c.post("/api/support", json=dict(name="Ada", email="ada@example.com", category="payments",
                                        subject="Paid but no access", message="I paid by bank transfer on Monday."),
               headers=H)
    check(r.status_code == 200 and r.json()["ok"] and r.json()["id"], r.text)
    ticket_id = r.json()["id"]
    check(c.post("/api/support", json=dict(email="ada@example.com", subject="hi", message="short"),
                 headers=H).status_code == 422, "short messages are refused")
    r = c.post("/api/support", json=dict(email="bot@example.com", subject="Buy now", message="spam spam spam spam",
                                        website="http://x"), headers=H)
    check(r.status_code == 200 and r.json()["id"] is None, "the honeypot stores nothing")
    check(c.post("/api/support", json=dict(email="not-an-email", subject="Hello there", message="A real message."),
                 headers=H).status_code == 422, "a bad reply address is refused")
    r = c.post("/api/auth/login", json=dict(email="owner@streixcorp.com", password="Admin-Pass-2026!"), headers=H)
    check(r.status_code == 200, r.text)
    inbox = c.get("/api/admin/support").json()
    check(inbox["open"] >= 1 and any(t["id"] == ticket_id for t in inbox["tickets"]), inbox)
    r = c.post(f"/api/admin/support/{ticket_id}/status", json=dict(status="closed"), headers=H)
    check(r.status_code == 200, r.text)
    check(all(t["id"] != ticket_id for t in c.get("/api/admin/support").json()["tickets"]), "closed ticket leaves the open list")
    check(c.get("/api/admin/support?status=closed").json()["tickets"][0]["id"] == ticket_id, "closed list")

    check(c.get("/api/donate/config").json()["min"] == 500, "donation minimum is ₦500")
    check(c.post("/api/donate", json=dict(amount=100, email="ada@example.com"), headers=H).status_code == 422,
          "donations below the minimum are refused")
    r = c.post("/api/donate", json=dict(amount=2500, email="ada@example.com", message="Keep it up"), headers=H)
    check(r.status_code == 200 and r.json()["reference"].startswith("DON"), r.text)
    ref = r.json()["reference"]
    check(c.get(f"/api/donate/verify/{ref}").json()["ok"] is False, "an unpaid donation is not thanked")
    PS.tx[ref]["status"] = "success"
    v = c.get(f"/api/donate/verify/{ref}").json()
    check(v["ok"] is True and v["amount"] == 2500, v)
    check(c.get(f"/api/donate/verify/{ref}").json()["ok"] is True, "verifying again gives the same answer")
    check(c.get("/api/donate/verify/NOTADONATION").status_code == 404, "only donation references are checked")
    ref2 = c.post("/api/donate", json=dict(amount=1000, email="ada@example.com"), headers=H).json()["reference"]
    PS.tx[ref2]["status"] = "success"
    body = json.dumps({"event": "charge.success", "data": {"reference": ref2, "channel": "card"}}).encode()
    r = c.post("/api/billing/paystack/webhook", content=body, headers={"x-paystack-signature": PS.sign(body)})
    check(r.status_code == 200 and r.json()["outcome"] == "success", r.text)

    signup(c, "gate@example.com")
    db = SessionLocal()
    try:
        u = db.execute(select(User).where(User.email == "gate@example.com")).scalar_one()
        u.terms_version = None                      # as if the account was made before the current Terms
        db.commit()
    finally:
        db.close()
    me = c.get("/api/auth/me").json()["user"]
    check(me["terms_ok"] is False and me["terms_version"] is None, me)
    check(c.post("/api/auth/accept-terms", json=dict(accept_terms=False), headers=H).status_code == 422,
          "the gate can't be passed without a tick")
    r = c.post("/api/auth/accept-terms", json=dict(accept_terms=True, learn=True), headers=H)
    check(r.status_code == 200 and r.json()["user"]["terms_ok"] and r.json()["user"]["learn_consent"], r.text)
    r = c.patch("/api/auth/me", json=dict(learn_consent=False), headers=H)
    check(r.status_code == 200 and r.json()["user"]["learn_consent"] is False, r.text)


def t_brain_version(_c):
    """A brain saved with another scikit-learn version is refused, not loaded half-working."""
    import sklearn

    class Brain:
        def __init__(self, v):
            self.b = {"sklearn": v}
    check(engine.check_build_version(Brain(sklearn.__version__)) == sklearn.__version__, "the same version loads")
    check(engine.check_build_version(Brain(None)) is None, "older brains without a recorded version still load")
    try:
        engine.check_build_version(Brain("0.0.1"))
    except RuntimeError as e:
        check("0.0.1" in str(e) and "requirements.txt" in str(e), str(e))
    else:
        raise AssertionError("a different scikit-learn version must be refused")


def t_direction_view(_c):
    """The bull/bear bar: range from the model's own share, lean from the calibration, and no numbers without a calibrated brain."""
    import numpy as np
    gm = engine.gm
    rng = np.random.default_rng(0)
    P = rng.dirichlet([1.0, 1.0, 1.0], 4000)
    y = np.array([rng.choice(3, p=p) for p in P])          # outcomes drawn from P, so P is calibrated by construction
    cal = gm.fit_direction_cal(P[:2000], y[:2000])
    card = {"prior": [0.34, 0.34, 0.32], "auc_neither": 0.67, "auc_up_vs_down": 0.51}
    v = gm.direction_view(cal, [0.2, 0.3, 0.5], card)
    lean = v["lean"]
    check(v["calibrated"] and abs(lean["up"] + lean["down"] + lean["sideways"] - 1) < 1e-9, v)
    check(abs(v["range"]["p"] - 0.5) < 1e-9 and v["range"]["base"] == 0.32 and v["range"]["skill_auc"] == 0.67,
          "range is the model's own sideways share (0.5 here), not the calibrated one")
    check(v["lean"]["skill_auc"] == 0.51, "the lean view carries its own up-versus-down skill")
    check(gm.direction_view(None, [0.2, 0.3, 0.5], card) == {"calibrated": False}, "older brains show no bar numbers")
    check(gm.FallbackBrain().direction_bar(None)["calibrated"] is False, "no trained brain: no bar numbers")


def t_email_verification(_c):
    """Once email is set up, a new account confirms its email before it can act. Reading the account and the chart
    stays open; the link from the email confirms the account and unlocks the actions."""
    from app.config import settings as cfg
    from app.services import mailer
    sent = []
    real_send, real_host = mailer.send, cfg.smtp_host
    mailer.send = lambda to, subject, text, html=None: sent.append((to, text)) or True
    cfg.smtp_host = "smtp.test"
    try:
        c = client()
        r = signup(c, "verify.me@example.com")
        check(r.status_code == 201 and r.json()["user"]["email_verified"] is False, "a new account starts unconfirmed")
        check(sent and sent[-1][0] == "verify.me@example.com", "the confirmation email goes to the account's address")
        link = next(w for w in sent[-1][1].split() if "/verify?token=" in w)
        token = link.split("token=", 1)[1]

        r = c.post("/api/user/watchlist", json=dict(symbol="EURUSD"), headers=H)
        check(r.status_code == 403 and r.json()["detail"]["code"] == "email_unverified", ("action refused", r.status_code))
        check(c.get("/api/user/watchlist").status_code == 200, "reading the watchlist stays open")
        check(c.get("/api/auth/me").json()["user"]["email_verified"] is False, "the account reports it is unconfirmed")

        check(c.post("/api/auth/verify-email", json=dict(token="not-the-token"), headers=H).status_code == 400,
              "a wrong link does not confirm")
        r = c.post("/api/auth/verify-email", json=dict(token=token), headers=H)
        check(r.status_code == 200 and r.json()["user"]["email_verified"] is True, "the link confirms the account")
        check(c.post("/api/user/watchlist", json=dict(symbol="EURUSD"), headers=H).status_code == 200,
              "actions are open after confirming")
        check(c.post("/api/auth/verify-email", json=dict(token=token), headers=H).status_code == 400,
              "a used link cannot be used again")
        check(c.post("/api/auth/resend-verification", headers=H).json()["message"].startswith("Your email is already"),
              "resend says it is already confirmed")
    finally:
        mailer.send, cfg.smtp_host = real_send, real_host


def t_psychology(_c):
    """The notes about a person's calls come from their own earlier calls: chasing the entry, calling again straight
    after a loss, and the feeling they named. Nothing is said until there are enough calls to say it."""
    from datetime import datetime
    from types import SimpleNamespace
    from app.services import psychology as ps

    def row(i, hh, mm, side, entry, status=None, r=None, emotion="calm", aentry=100.0, asl=98.0):
        res = dict(final=True, user=dict(status=status, r=r)) if status else {}
        d = dict(side=side, entry=entry, sl=entry - 2 if side == "long" else entry + 2, tp=entry + 4 if side == "long" else entry - 4,
                 emotion=emotion, note=None, decided_at=f"2026-10-01T{hh:02d}:{mm:02d}:00Z")
        return SimpleNamespace(id=i, created_at=datetime(2026, 10, 1, 9), symbol="BTCUSDT", tf="1h", side="long",
                               entry=aentry, sl=asl, tp=aentry + 4, grade="B", outcome=None, outcome_r=None,
                               plan_type="limit", summary=json.dumps(dict(decision=d, result=res)))
    rows = [row(1, 8, 0, "long", 100.0, "tp", 2.0),
            row(2, 9, 0, "long", 101.0, "sl", -1.0, emotion="fomo"),       # chased: filled 0.5R past the analyst
            row(3, 9, 10, "long", 100.4, "sl", -1.0, emotion="revenge"),   # straight after a loss, 10 minutes later
            row(4, 11, 0, "long", 100.0, "tp", 2.0, emotion="calm"),
            row(5, 12, 0, "long", 100.0, None, None, emotion="unsure")]
    ds = ps.features(ps.decision_rows(rows))
    check([d["id"] for d in ds] == [1, 2, 3, 4, 5], "decisions come back in the order they were made")
    check(ds[1]["chased"] is True and ds[1]["slip_r"] == 0.5 and ds[0]["chased"] is False, ds[1])
    check(ds[2]["quick_after_loss"] is True and ds[2]["streak_before"] == 1, ds[2])
    check(ds[0]["quick_after_loss"] is False and ds[0]["streak_before"] == 0, "the first call has no history")
    check(ds[3]["streak_before"] == 2 and ds[4]["streak_before"] == 0 and ds[4]["settled"] is False,
          "two losses in a row are counted, the win after them resets the streak, and an unsettled call adds nothing")
    check(ps.tips(ds) == [], "no tendencies until there are enough settled calls")
    many = []
    for i in range(1, 13):
        many.append(row(100 + i, 8, i, "long", 101.0 if i % 2 else 100.0, "sl" if i % 3 == 0 else "tp",
                        -1.0 if i % 3 == 0 else 2.0, emotion="fomo" if i % 4 == 0 else "calm"))
    tips_now = ps.tips(ps.features(ps.decision_rows(many)))
    check(any("chased the entry" in t for t in tips_now), tips_now)
    cur = ds[2]
    text = " | ".join(ps.coach(cur, ds[:2]))
    check("past the analyst's entry" not in text and "straight after a loss" in text, text)
    check(ps.coach(ds[1], ds[:1]) and "past the analyst's entry" in ps.coach(ds[1], ds[:1])[0], ps.coach(ds[1], ds[:1]))


def t_replay_decisions(c):
    """A call is written down the moment it is made, with the feeling; it cannot change afterwards; the coach answers
    from the person's history; the export carries the call and the feeling, and never the note text."""
    import pandas as pd
    from app.models import AnalysisLog, utcnow
    signup(c, "decider@example.com")
    at_iso = (utcnow() - timedelta(days=3)).replace(minute=0, second=0, microsecond=0).isoformat() + "Z"
    cs = c.get("/api/market/candles", params=dict(symbol="BTCUSDT", tf="1h", bars=200, at=at_iso)).json()
    rep = c.post("/api/replay/analyze", json=dict(symbol="BTCUSDT", tf="1h", at=at_iso), headers=H).json()
    rid = rep["replay_id"]
    px = cs["candles"][-1][4]
    call = dict(replay_id=rid, side="long", entry=px, sl=px * 0.9, tp=px * 1.2)
    check(c.post("/api/replay/reveal", json=dict(call, emotion="panic"), headers=H).status_code == 422, "an unknown feeling is refused")
    r = c.post("/api/replay/reveal", json=dict(call, emotion="fomo", note="I can't miss this"), headers=H)
    check(r.status_code == 200 and r.json()["decision"]["emotion"] == "fomo", r.text[:300])
    check(c.post("/api/replay/reveal", json=dict(call, entry=px * 0.99, emotion="calm"), headers=H).status_code == 409,
          "a call cannot be changed once it is made")
    r = c.post("/api/replay/reveal", json=dict(replay_id=rid), headers=H)
    check(r.status_code == 200 and r.json()["decision"]["side"] == "long" and "coach" in r.json(), r.text[:300])
    db = _db()
    s = json.loads(db.get(AnalysisLog, rid).summary)
    db.close()
    check(s["decision"]["note"] == "I can't miss this" and s["decision"]["decided_at"], "the call is stored when it is made")
    adm = client()
    adm.post("/api/auth/login", json=dict(email="owner@streixcorp.com", password="Admin-Pass-2026!"), headers=H)
    lines = [json.loads(x) for x in adm.get("/api/admin/learning/export?dataset=decisions").text.splitlines() if x]
    mine = [x for x in lines if x["id"] == rid]
    check(mine and mine[0]["emotion"] == "fomo" and mine[0]["has_note"] is True and "note" not in mine[0]
          and mine[0]["side"] == "long" and mine[0]["entry"] == px, ("export", mine))


def t_behaviour_model(_c):
    """The behaviour model ships only when it beats the baseline on calls it has not seen. The calls here are generated
    to exercise the code (a clear pattern, no pattern, too few calls); they are not real data and are never shipped."""
    import contextlib
    import io
    import json
    import os
    import random
    import tempfile
    from datetime import datetime, timedelta
    from app.services import behaviour as bm
    from app.services.psychology import EMOTIONS

    def make(n, seed, revenge_win=0.2, chase_penalty=0.15):
        rnd = random.Random(seed)
        out = []
        for i in range(n):
            feel = rnd.choice(list(EMOTIONS) + [None])
            chased = rnd.random() < 0.3
            p = revenge_win if feel == "revenge" else 0.5
            if chased:
                p -= chase_penalty
            win = rnd.random() < p
            out.append(dict(id=i + 1, decided_at=(datetime(2026, 1, 1) + timedelta(minutes=i)).isoformat() + "Z",
                            side="long", entry=100.0, sl=98.0, tp=104.0 if rnd.random() < 0.5 else 103.0,
                            emotion=feel, chased=chased, quick_after_loss=rnd.random() < 0.2,
                            streak_before=rnd.randint(0, 3), settled=True, r=2.0 if win else -1.0))
        return out

    strong = make(400, seed=7)
    m = bm.train(strong)
    check(m["ship"] is True, m["reason"])
    w = dict(zip(bm.FEATURES, m["weights"]))
    check(w["feel_revenge"] < 0 and w["chased"] < 0, w)
    check(m["card"]["improvement"] > 0 and m["card"]["train_calls"] + m["card"]["test_calls"] == 400, m["card"])
    rev = dict(strong[0], emotion="revenge", chased=False, quick_after_loss=False, streak_before=0)
    p_rev, p_calm = bm.predict(m, rev), bm.predict(m, dict(rev, emotion="calm"))
    check(p_rev is not None and 0 < p_rev < p_calm < 1, (p_rev, p_calm))
    check(bm.predict(m, dict(rev, entry=None)) is None, "a call with no levels cannot be scored")
    check(bm.predict(dict(m, features=["x"]), rev) is None, "a model from another version is not used")

    flat = make(400, seed=3, revenge_win=0.5, chase_penalty=0.0)
    check(bm.train(flat)["ship"] is False, "calls with no pattern in them must not ship a model")

    few = bm.train(make(150, seed=7))
    check(few["ship"] is False and few["weights"] is None and "200" in few["reason"], few)
    check(bm.predict(few, rev) is None, "with no shipped model nothing is scored")
    open_calls = [dict(d, settled=False, r=None) for d in strong[:50]]
    check(bm.train(strong[:150] + open_calls)["settled"] == 150, "calls still open are left out of the fit")

    with tempfile.TemporaryDirectory() as tmp:
        src, out_path = os.path.join(tmp, "decisions.jsonl"), os.path.join(tmp, "behaviour.json")
        with open(src, "w", encoding="utf-8") as f:
            for d in strong:
                f.write(json.dumps(d) + "\n")
        with contextlib.redirect_stdout(io.StringIO()):
            bm.main([src, "--out", out_path])
        again = bm.load(out_path)
    check(again["ship"] is True and bm.predict(again, rev) == p_rev,
          "the command line reads a JSON Lines export, and a saved model scores the same after reading it back")


def main():
    t0 = time.time()
    with client() as c:
        for _ in range(100):                      # brain loads in a thread at start-up
            if engine.BRAIN["status"] != "loading":
                break
            time.sleep(0.1)
        tests = [t_health, t_signup_rules, t_signup_and_me, t_login, t_watchlist, t_search, t_candles, t_divergence, t_analysis,
                 t_review, t_ai_offline, t_ai_claude, t_brain_status]
        for t in tests:
            run(t.__name__, t, c)
        c2 = client()
        run("t_free_limits", t_free_limits, c2)
        c3 = client()
        for t in (t_paystack, t_opay, t_dva):
            run(t.__name__, t, c3)
        run("t_manual_and_admin", t_manual_and_admin, client())
        run("t_password_change", t_password_change, None)
        run("t_brain_version", t_brain_version, None)
        run("t_direction_view", t_direction_view, None)
        run("t_email_verification", t_email_verification, client())
        run("t_psychology", t_psychology, None)
        run("t_replay_decisions", t_replay_decisions, client())
        run("t_behaviour_model", t_behaviour_model, None)
        run("t_gemini", t_gemini, client())
        run("t_sweeps", t_sweeps, None)
        run("t_selflearn", t_selflearn, None)
        run("t_admin_accounts", t_admin_accounts, client())
        run("t_security", t_security, client())
        for t in (t_terms_and_site, t_stage2, t_practice, t_strategy, t_scalp_template, t_tracker_rules, t_track_record, t_alerts, t_push, t_replay,
                  t_learning_export):
            run(t.__name__, t, client())
    bad = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(bad)}/{len(RESULTS)} passed in {time.time() - t0:.0f}s")
    shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

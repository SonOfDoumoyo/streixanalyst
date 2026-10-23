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
    GURU_BUNDLED_BRAIN="0",                          # the brain committed in backend/models is for the real server
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
    check(r.json()["trial_days"] == 30 and r.json()["google"] is False, r.text)
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
    check(e["tier"] == "trial" and e["trial_days_left"] == 30 and "strategy" in e["features"] and "replay" in e["features"],
          e)
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
    want = c.get("/api/billing/plans").json()["quotes"]["org"]["1"]["naira"] * 6       # $ per seat × 6 seats
    check(len(ref) == 8 and ref.startswith("SA") and d["account"]["number"] == "2385227704" and d["amount"] == want, d)
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
    check(me["entitlements"]["tier"] == "org" and me["org"]["role"] == "owner" and me["org"]["seats"] == 6, me["org"])  # per-seat price: the owner paid for 6 people
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


def t_email_brevo(_c):
    """Email over Brevo's HTTPS API (Render's free plan blocks SMTP): the admin test shows the provider's answer and a
    fix when it fails, and a new account's confirmation link goes out through Brevo."""
    from app.services import mailer
    sent = []

    def brevo(req):
        assert req.url.host == "api.brevo.com" and req.url.path == "/v3/smtp/email"
        if req.headers.get("api-key") == "bad":
            return httpx.Response(401, json=dict(code="unauthorized", message="Key not found"))
        sent.append(json.loads(req.content))
        return httpx.Response(201, json=dict(messageId="<1@smtp-relay.mailin.fr>"))
    mailer.set_client(httpx.Client(transport=httpx.MockTransport(brevo)))
    real = settings.brevo_api_key, settings.email_from
    settings.brevo_api_key, settings.email_from = "xkeysib-test", "StreixAnalyst <owner.streix@gmail.com>"
    try:
        check(mailer.provider() == "brevo" and mailer.configured(), mailer.provider())
        adm = client()
        check(adm.post("/api/auth/login", json=dict(email="owner@streixcorp.com", password="Admin-Pass-2026!"),
                       headers=H).status_code == 200, "admin login")
        r = adm.post("/api/admin/email/test", json={}, headers=H).json()
        check(r["ok"] and sent[-1]["to"] == [dict(email="owner@streixcorp.com")]
              and sent[-1]["sender"] == dict(name="StreixAnalyst", email="owner.streix@gmail.com"), (r, sent[-1:]))
        settings.brevo_api_key = "bad"
        r = adm.post("/api/admin/email/test", json=dict(to="me@example.com"), headers=H).json()
        check(not r["ok"] and "401" in r["error"] and "API key" in (r["hint"] or ""), r)
        st = adm.get("/api/admin/system").json()["email_status"]
        check(st["provider"] == "brevo" and st["failed"] >= 1 and st["last_hint"], st)
        settings.brevo_api_key = "xkeysib-test"
        n = len(sent)
        r = signup(client(), "brevo.user@example.com")
        for _ in range(100):
            if len(sent) > n:
                break
            time.sleep(0.05)
        check(r.status_code == 201 and r.json()["user"]["email_verified"] is False, r.text)
        check(len(sent) > n and sent[-1]["to"][0]["email"] == "brevo.user@example.com"
              and '/verify?token=' in sent[-1]["htmlContent"] and "<a href=" in sent[-1]["htmlContent"], sent[-1:])
        check("network is unreachable" not in (mailer.hint_for(OSError(101, "Network is unreachable")) or "x")
              and "free plan" in mailer.hint_for(OSError(101, "Network is unreachable")), "SMTP-blocked hint")
        check("App Password" in mailer.hint_for(Exception("(535, b'5.7.8 Username and Password not accepted')")), "Gmail hint")
    finally:
        settings.brevo_api_key, settings.email_from = real
        mailer.set_client(None)


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


def t_strategies(c):
    """The strategy catalog, the person's choice (asked for until made), and analysing with only that choice."""
    signup(c, "strats@example.com")
    cat = c.get("/api/strategies").json()
    ids = {x["id"] for x in cat["strategies"]}
    check(len(cat["strategies"]) >= 40 and {"ict_sweep_mss", "supertrend", "scalp_ema_vwap", "ft_trend"} <= ids, ids)
    check({g["id"] for g in cat["groups"]} >= {"smc", "scalp", "fixed_time"}, cat["groups"])
    me = c.get("/api/auth/me").json()["user"]
    check(me["needs_strategies"] is True and me["strategies"] == [], me)
    check(c.put("/api/strategies/mine", json=dict(ids=["nope"]), headers=H).status_code == 422, "unknown ids refused")
    r = c.put("/api/strategies/mine", json=dict(ids=["supertrend", "ict_sweep_mss", "ft_trend", "nope"]), headers=H)
    check(r.status_code == 200 and r.json()["ids"] == ["ict_sweep_mss", "supertrend", "ft_trend"], r.text)
    me = c.get("/api/auth/me").json()["user"]
    check(me["needs_strategies"] is False and me["strategies"] == ["ict_sweep_mss", "supertrend", "ft_trend"], me)
    a = c.post("/api/analysis/run", json=dict(symbol="BTCUSDT", tf="15m"), headers=H).json()
    sb = a["strategies"]
    check(sb["mode"] == "chosen" and [x["id"] for x in sb["items"]] == ["ict_sweep_mss", "supertrend", "ft_trend"], sb)
    check(all("record" in x and "wait_for" in x for x in sb["items"]), sb["items"])
    for p_ in a["plans"]:
        # the chosen strategies' plans, or (when they have none) the analyst's own, marked as the fallback
        check(p_.get("strategy") in ("ict_sweep_mss", "supertrend") or (a["entry_source"] != "strategies" and p_.get("fallback")),
              (p_.get("strategy"), a["entry_source"]))
    v = a["verdict"]
    check(v.get("confidence") and v["confidence"]["level"] in ("none", "low", "moderate", "good") and v.get("tf_note"), v)
    check("certain" not in v["headline"].lower() or "not a certainty" in v["headline"].lower(), v["headline"])
    check(a["mtf"]["rows"] and any(r_.get("current") for r_ in a["mtf"]["rows"]), a["mtf"])
    check(a["fixed_time"] and a["fixed_time"]["breakeven"] > 0.5, a["fixed_time"])
    check(a["liquidity"] and a["liquidity"]["depth_atr"] > 0, a["liquidity"])
    check(set(a["layers_scope"]) >= {"plan", "liquidity", "structure"} and "candles" not in a["layers_scope"], a["layers_scope"])
    drawn = [d for d in a["drawings"] if d["layer"] not in ("price",)]
    check(all(d.get("why") for d in drawn), [d["layer"] + d["kind"] for d in drawn if not d.get("why")][:5])
    if a["plan"]:
        lines = [d for d in a["drawings"] if d["layer"] == "plan" and d["kind"] == "line"]
        check(lines and all(d.get("copy") for d in lines), lines[:2])
        check(a["how_to_enter"] and "Stop loss" in " ".join(a["how_to_enter"]), a["how_to_enter"])
    # a request can override the saved choice; an unknown id alone falls back to the saved choice
    a2 = c.post("/api/analysis/run", json=dict(symbol="BTCUSDT", tf="15m", strategies=["rsi_strategy"]), headers=H).json()
    check([x["id"] for x in a2["strategies"]["items"]] == ["rsi_strategy"], a2["strategies"])
    # what if I enter from here (the latest candle)
    price = a["price"]
    r = c.post("/api/analysis/whatif", json=dict(symbol="BTCUSDT", tf="15m", price=price), headers=H)
    check(r.status_code == 200, r.text[:300])
    w = r.json()
    check({x["side"] for x in w["sides"]} == {"long", "short"} and w["text"], w)
    for x in w["sides"]:
        d = 1 if x["side"] == "long" else -1
        check(d * (x["entry"] - x["sl"]) > 0 and all(d * (t - x["entry"]) > 0 for t in x["tps"]), x)
    r = c.post("/api/analysis/whatif", json=dict(symbol="BTCUSDT", tf="15m", price=price * 5), headers=H)
    check(r.status_code == 422 and "latest candle" in r.json()["detail"], r.text)
    # how every strategy has done on a market
    ov = c.get("/api/strategies/overlay?symbol=BTCUSDT&tf=1h&id=supertrend").json()
    check(ov["record"] and any(i["kind"] == "path" for i in ov["items"]) and all("t1" in i or "points" in i for i in ov["items"]),
          {k: ov[k] for k in ov if k != "items"})
    check(c.get("/api/strategies/overlay?symbol=BTCUSDT&tf=1h&id=nope").status_code == 422, "unknown strategy")
    f = c.get("/api/strategies/fit?symbol=EURUSD&tf=15m").json()
    check(f["rows"] and f["candles"] > 300 and "note" in f, {k: f[k] for k in f if k != "rows"})
    check(all("trades" in r_ or "error" in r_ for r_ in f["rows"]), f["rows"][:3])


def t_strategy_engine(_c):
    """The liquidity guard moves stops past nearby pools (never closer), and split strategies mean no trade."""
    import strategies as st
    import playbook as pb
    import structure_engine as se
    df = se.make_demo_data(n=1200, freq="15min")
    df.index = df.index.tz_localize("UTC") if df.index.tz is None else df.index
    dfe, A = se.analyze(df)
    ctx = st.Ctx(dfe, "15m", A)
    i = ctx.n - 1
    lows = ctx.pools(i, -1)
    price = float(ctx.c[-1])
    below = [q for q in lows if q < price - 0.3 * ctx.atr[i]]
    if below:
        pool = max(below)
        stop = pool - 0.02 * ctx.atr[i]                  # a few ticks under the low: where stop hunts finish
        new, hit = st.guard_stop(ctx, i, 1, price, stop)
        check(hit is not None and new < stop - 0.1 * ctx.atr[i], (stop, new, hit))
        far = pool - 3 * ctx.atr[i]
        check(st.guard_stop(ctx, i, 1, price, far)[0] <= far, "a stop already far away never moves closer")
    for sid in [s["id"] for s in st.CATALOG]:
        tr = st.backtest(ctx, sid, 1e-4, 0.3e-4)
        for t in tr:
            if not t.get("open") and "reason" in t:
                d = 1 if t["side"] == "long" else -1
                check(d * (t["entry"] - t["stop"]) > 0 and d * (t["target"] - t["entry"]) > 0, (sid, t))
    rec = st.record([dict(open=False, r=0.85), dict(open=False, r=-1.0)], fixed_time=True)
    check(abs(rec["breakeven"] - 1 / 1.85) < 1e-9 and rec["win_rate"] == 0.5, rec)
    X = dict(chosen=["supertrend", "rsi_strategy"], price=100.0, atr=1.0, ladder=("1h", "4h"), htf={},
             records={"supertrend": dict(score=0.0), "rsi_strategy": dict(score=0.0)})
    plans = [dict(strategy="supertrend", dir=1, type="market", entry=100.0, signal_age=0),
             dict(strategy="rsi_strategy", dir=-1, type="market", entry=100.0, signal_age=0)]
    cf = pb.conflict(plans, X)
    check(cf["split"] is True and "disagree" in cf["note"], cf)
    X["records"]["supertrend"]["score"] = 0.9
    cf = pb.conflict(plans, X)
    check(cf["split"] is False and cf["side"] == 1, cf)
    v = pb.soften(dict(action="BUY LIMIT", trade=True, headline="x", grade="A"), None, dict(X, tf="1h", f=None),
                  pb.confidence(None, X), dict(split=True, note="Your strategies disagree"))
    check(v["action"].startswith("NO TRADE") or v["trade"] is False, v)


def t_heads(c):
    """Notebook 10's heads: trained on synthetic markets, then used by the analyst (liquidity odds, learned stop depth,
    per-signal strategy odds, history in the picker), and absent heads change nothing."""
    import synth
    import guru_analyst as ga
    import guru_model as gm
    import liquidity_head as lh
    import strategy_head as sh
    agg = dict(open="first", high="max", low="min", close="last", volume="sum")
    series = []
    for name, sym, cls, sub in (("EUR/USD", "EURUSD", "fx", "fx_major"), ("BTC/USD", "BTCUSDT", "crypto", "crypto_major"),
                                ("XAU/USD", "XAUUSD", "metal", "gold")):
        df = synth.base15(name).resample("1h").agg(agg).dropna().tail(4500).astype(float)
        series.append(dict(symbol=sym, tf="1h", asset_class=cls, sub=sub, df=df))
    L = lh.build(series, budget=15000, log=lambda *a: None)
    check({"y_sweep", "y_rev", "depth", "test"} <= set(L.columns) and L["d_atr"].between(0, lh.MAX_D).all(), L.shape)
    hl = lh.train(L, log=lambda *a: None)
    S = sh.build(series, budget=30000, log=lambda *a: None)
    check(S["sid"].nunique() >= 30 and S["win"].isin([0, 1, True, False]).all(), S["sid"].nunique())
    split = int(4500 * 0.7)
    check((S.loc[~S["test"], "exit_i"] < split).all() and (S.loc[S["test"], "bar"] >= split).all(),
          "purge: no training trade runs into the test period")
    hs = sh.train(S, log=lambda *a: None)
    check(len(hs["evidence_market"]) and set(hs["use"]) == {"odds"}, hs["use"])
    # exercise every path whatever the gates said on this tiny synthetic set
    hl["use"] = dict(sweep=True, reverse="reverse" in hl["models"], depth="depth" in hl["models"])
    hs["use"] = dict(odds=True)

    class B(gm.FallbackBrain):
        liq, strat = hl, hs

    ids = ["ict_sweep_mss", "ote_pullback", "sr_bounce", "supertrend", "ft_trend"]
    res = ga.jsonable(ga.analyze("EURUSD", "1h", brain=B(), strategies=ids))
    liq = res["liquidity"]
    check(liq["learned"] and liq["pools"] and all(0 <= p["p_sweep"] <= 1 for p in liq["pools"]), liq)
    check("Most likely taken first" in liq["text"] or "No pool near price" in liq["text"], liq["text"])
    heads = [p["head"] for p in res["plans"] if p.get("head")]
    check(all(0 <= h["p_win"] <= 1 and 0 < h["needed"] < 1 for h in heads), heads)
    hist = [x["history"] for x in res["strategies"]["items"] if x.get("history")]
    check(hist and all(h["trades"] > 0 for h in hist), res["strategies"]["items"][:2])
    # no heads: nothing learned is claimed
    plain = ga.jsonable(ga.analyze("EURUSD", "1h", brain=gm.FallbackBrain(), strategies=ids))
    check(not plain["liquidity"]["learned"] and not any(p.get("head") for p in plain["plans"]), plain["liquidity"])
    # the picker's history endpoint
    signup(c, "hist@example.com")
    old = engine.BRAIN["brain"]
    try:
        r = c.get("/api/strategies/history?symbol=EURUSD&tf=1h").json()
        check(r["available"] is False, r)
        engine.BRAIN["brain"] = B()
        r = c.get("/api/strategies/history?symbol=EURUSD&tf=1h").json()
        check(r["available"] and len(r["rows"]) >= 20 and r["rows"][0]["scope"] in ("market", "kind"), r)
        r2 = c.get("/api/strategies/history?symbol=GBPUSD&tf=1h").json()
        check(r2["available"] and all(x["scope"] == "kind" for x in r2["rows"]), r2["rows"][:2])
        check(engine.heads_info(B())["strategies"]["use"]["odds"] is True, "admin sees the heads")
    finally:
        engine.BRAIN["brain"] = old


def t_my_analyses(c):
    signup(c, "mine@example.com")
    c.put("/api/strategies/mine", json=dict(ids=["ict_sweep_mss", "ob_retest"]), headers=H)
    a = c.post("/api/analysis/run", json=dict(symbol="SOLUSDT", tf="1h"), headers=H).json()
    p, atr = a["price"], a["atr"]
    draw = [dict(id="d1", type="hline", points=[dict(t=a["candles"][-5][0], p=p - 2 * atr)], style=dict(text="my support")),
            dict(id="d2", type="rect", points=[dict(t=a["candles"][-30][0], p=p - 3 * atr), dict(t=a["candles"][-2][0], p=p - 2.5 * atr)],
                 style={})]
    body = dict(symbol="SOLUSDT", tf="1h", title="My SOL idea", source="ai", source_analysis_id=a["analysis_id"],
                drawings=draw, plan=dict(side="long", entry=p, sl=p - 1.5 * atr, tps=[p + 3 * atr]),
                ai=dict(action=a["verdict"]["action"]))
    r = c.post("/api/my-analyses", json=body, headers=H)
    check(r.status_code == 201 and r.json()["drawings_count"] == 2 and r.json()["plan"]["side"] == "long", r.text[:300])
    aid = r.json()["id"]
    bad = dict(body, plan=dict(side="long", entry=p, sl=p + atr, tps=[p + 2 * atr]))
    check(c.post("/api/my-analyses", json=bad, headers=H).status_code == 422, "stop on the wrong side")
    r = c.patch(f"/api/my-analyses/{aid}", json=dict(title="Renamed", notes="wait for London"), headers=H)
    check(r.json()["title"] == "Renamed" and r.json()["notes"] == "wait for London", r.text[:200])
    items = c.get("/api/my-analyses").json()["items"]
    check(len(items) == 1 and items[0]["id"] == aid, items)
    r = c.post(f"/api/my-analyses/{aid}/grade", headers=H)
    check(r.status_code == 200, r.text[:400])
    g = r.json()["grade"]
    check(g["review"]["ok"] and g["score"] is not None and g["summary"] and g["liquidity"], g)
    check(len(g["levels"]) == 2 and g["ai"]["action"], g["levels"])
    check(c.get(f"/api/my-analyses/{aid}").json()["grade"]["score"] == g["score"], "grade saved")
    other = client()
    signup(other, "notmine@example.com")
    check(other.get(f"/api/my-analyses/{aid}").status_code == 404, "someone else's analysis is private")
    check(c.delete(f"/api/my-analyses/{aid}", headers=H).json()["ok"], "deleted")
    check(c.get("/api/my-analyses").json()["items"] == [], "gone")


def t_class_live(c):
    from app.db import SessionLocal
    from app.models import Organization, User
    from datetime import timedelta
    from app.models import utcnow
    teacher, student, outsider = client(), client(), client()
    signup(teacher, "teacher@school.com")
    signup(student, "student@school.com")
    signup(outsider, "outsider@else.com")
    with SessionLocal() as db:
        org = Organization(name="Streix Academy", seats=10, invite_code="ACAD123", plan_expires_at=utcnow() + timedelta(days=30))
        db.add(org)
        db.flush()
        for email, role in (("teacher@school.com", "teacher"), ("student@school.com", "member")):
            u = db.query(User).filter(User.email == email).one()
            u.org_id, u.org_role = org.id, role
        db.commit()
    state = dict(title="London open", symbol="EURUSD", tf="15m", drawings=[dict(id="x", type="hline", points=[dict(t=1, p=1.1)])],
                 analysis=dict(verdict=dict(action="Possible BUY"), sizing=dict(units=5), account=50000), note="watch the sweep")
    check(student.put("/api/class/live", json=state, headers=H).status_code == 403, "students can't go live")
    r = teacher.put("/api/class/live", json=state, headers=H)
    check(r.status_code == 200 and r.json()["live"], r.text)
    tid = r.json()["teacher_id"]
    lst = student.get("/api/class/live").json()["items"]
    check(len(lst) == 1 and lst[0]["symbol"] == "EURUSD" and lst[0]["title"] == "London open", lst)
    w = student.get(f"/api/class/live/{tid}").json()
    check(w["live"] and w["state"]["drawings"] and "account" not in w["state"]["analysis"] and
          "sizing" not in w["state"]["analysis"], w["state"])
    check(outsider.get(f"/api/class/live/{tid}").status_code == 403, "other organizations can't watch")
    check(outsider.get("/api/class/live").json()["items"] == [], "no org: nothing to watch")
    teacher.delete("/api/class/live", headers=H)
    check(student.get("/api/class/live").json()["items"] == [], "stopped")
    check(student.get(f"/api/class/live/{tid}").json()["state"] is None, "no state after stopping")


def t_ideas(c):
    a, b = client(), client()
    signup(a, "idea-a@example.com")
    signup(b, "idea-b@example.com")
    r = a.post("/api/ideas", json=dict(symbol="xauusd", tf="1h", side="long", title="Gold sweep of Asia low",
                                       body="Waiting for London to take the Asian low.", drawings=[], plan=dict(entry=1, sl=0.9)),
               headers=H)
    check(r.status_code == 201 and r.json()["symbol"] == "XAUUSD", r.text)
    iid = r.json()["id"]
    feed = b.get("/api/ideas").json()["items"]
    check(feed and feed[0]["id"] == iid and feed[0]["author"]["name"], feed)
    check(b.post(f"/api/ideas/{iid}/like", headers=H).json() == dict(id=iid, likes=1, liked=True), "liked")
    check(b.get("/api/ideas?scope=top").json()["items"][0]["liked"] is True, "liked shows")
    check(b.post(f"/api/ideas/{iid}/like", headers=H).json()["likes"] == 0, "unliked")
    check(b.delete(f"/api/ideas/{iid}", headers=H).status_code == 403, "can't delete others' ideas")
    check(a.get("/api/ideas?scope=mine").json()["items"][0]["id"] == iid, "mine")
    check(a.delete(f"/api/ideas/{iid}", headers=H).json()["ok"], "deleted")


def t_replay_gate(c):
    """Replay is a Pro feature that every new account has during its 30-day trial."""
    from app.db import SessionLocal
    from app.models import User, utcnow
    from datetime import timedelta
    signup(c, "replay-free@example.com")
    at = (utcnow() - timedelta(days=3)).strftime("%Y-%m-%dT%H:00:00Z")
    check(c.get(f"/api/market/candles?symbol=BTCUSDT&tf=1h&bars=200&at={at}").status_code == 200, "trial: replay open")
    with SessionLocal() as db:
        u = db.query(User).filter(User.email == "replay-free@example.com").one()
        u.trial_ends_at = utcnow() - timedelta(days=1)
        db.commit()
    r = c.get(f"/api/market/candles?symbol=BTCUSDT&tf=1h&bars=200&at={at}")
    check(r.status_code == 402 and r.json()["detail"]["feature"] == "replay", r.text)
    r = c.post("/api/replay/analyze", json=dict(symbol="BTCUSDT", tf="1h", at=at), headers=H)
    check(r.status_code == 402, r.text[:200])
    check(c.get("/api/market/candles?symbol=BTCUSDT&tf=1h&bars=200").status_code == 200, "live charts stay free")
    # chart-only intervals
    d = c.get("/api/market/candles?symbol=BTCUSDT&tf=3m&bars=120").json()
    check(d["tf"] == "3m" and d["tf_seconds"] == 180 and len(d["candles"]) > 50, {k: d[k] for k in d if k != "candles"})
    ts = [x[0] for x in d["candles"]]
    check(all(b_ - a_ >= 180 for a_, b_ in zip(ts, ts[1:])) and all(t % 180 == 0 for t in ts), ts[:5])
    lt = c.get("/api/market/latest?symbol=BTCUSDT&tf=2h").json()
    check(lt["tf"] == "2h" and lt["candles"], lt)


def t_hud(c):
    """The reasons on the chart (guru/hud.py): numbered flags with a place on the chart, a failing row in the list for
    each, the news on the clock, the scenario path, and a sensible block when there is no plan at all."""
    import guru_analyst as ga
    import hud as hm
    signup(c, "hud@example.com")
    seen_news = False
    for sym, tf in (("EURUSD", "15m"), ("BTCUSDT", "1h"), ("ETHUSDT", "4h"), ("SOLUSDT", "15m")):
        a = c.post("/api/analysis/run", json=dict(symbol=sym, tf=tf), headers=H).json()
        h = a["hud"]
        check("error" not in h and h["state"] in ("best", "go", "dont") and h["title"] and h["summary"], h)
        check(h["state"] != "go" or a["verdict"]["trade"], (h["state"], a["verdict"]))
        # there is always an entry with a stop and targets, and the verdict leads with it
        p = a["plan"]
        check(p and p["entry"] and p["sl"] and p["tps"] and h["state"] != "dont", (a["verdict"], a["entry_source"]))
        check(a["verdict"]["trade"] or a["verdict"]["action"].startswith("Best entry"), a["verdict"])
        # every timeframe: a graded best setup or the reason there is none
        rows = a["mtf"]["rows"]
        check(rows and all("scan" in r for r in rows), [r.get("tf") for r in rows])
        for r in rows:
            b = r["scan"]["best"]
            check((b is None and r["scan"]["why"]) or (b["grade"] in "ABCD" and (b["dir"] * (b["entry"] - b["sl"]) > 0)
                                                        and b["dir"] * (b["tp"] - b["entry"]) > 0), r["scan"])
        if a["mtf"]["best"]:
            check(a["mtf"]["best"]["tf"] in [r["tf"] for r in rows], a["mtf"]["best"])
        flags = [f for f in h["flags"] if f["n"]]
        check([f["n"] for f in flags] == list(range(1, len(flags) + 1)) and len(flags) <= hm.MAX_FLAGS, flags)
        for f in h["flags"]:
            check(f["tone"] in ("wait", "bad", "good", "info") and f["title"] and f["text"], f)
            if f["kind"] == "level":
                check(isinstance(f["price"], float), f)
            if f["kind"] == "time":
                check(isinstance(f["t"], int), f)
            if f.get("t") is not None:
                check(abs(f["t"] - h["last_t"]) < 400 * h["step"] + 2 * 86400, (f, h["last_t"]))
        for f in flags:
            check(any(r["key"] == f["key"] and not r["ok"] for r in h["checks"]), (f["key"], h["checks"]))
        check(h["met"] == sum(r["ok"] for r in h["checks"]) and h["total"] == len(h["checks"]), h)
        check(all(s["n"] in {f["n"] for f in flags} for s in h["steps"]), h["steps"])
        if h["path"]:
            check(h["path"][0]["t"] == h["last_t"] and all(b["t"] > a_["t"] for a_, b in zip(h["path"], h["path"][1:])), h["path"])
            check(any(q["mark"] == "entry" for q in h["path"]), h["path"])
        news = [f for f in h["flags"] if f["key"] == "news"]
        if a["news"]["risk"] == "high":
            seen_news = True
            check(len(news) == 1 and news[0]["tone"] == "bad" and "CPI" in news[0]["title"], news)
            again = hm.with_news(json.loads(json.dumps(h)), a["news"])
            check(sum(f["key"] == "news" for f in again["flags"]) == 1, "news added once")
    check(seen_news, "the fake calendar has a high-impact release")
    # chosen strategies with no setup: the best entry still comes, from the analyst's own setups, said plainly
    for sym in ("BTCUSDT", "ETHUSDT", "SOLUSDT"):
        a = c.post("/api/analysis/run", json=dict(symbol=sym, tf="1h", strategies=["ict_sweep_mss"]), headers=H).json()
        check(a["plan"] and a["entry_source"] in ("strategies", "analyst", "market"), a["entry_source"])
        if a["entry_source"] != "strategies":
            check("None of your strategies" in (a["fallback_note"] or "") or a["entry_source"] == "market", a["fallback_note"])
            check(a["hud"]["note"] == a["fallback_note"], a["hud"].get("note"))
            mine = [m for r in a["mtf"]["rows"] for m in r["scan"]["mine"]]
            check(mine and all(m["id"] == "ict_sweep_mss" and m["text"] for m in mine), mine)
    # win-rate targets: TP1 moves closer (where most similar setups got first), the liquidity target stays
    liq = c.post("/api/analysis/run", json=dict(symbol="EURUSD", tf="15m"), headers=H).json()["plan"]
    win = c.post("/api/analysis/run", json=dict(symbol="EURUSD", tf="15m", target_mode="winrate"), headers=H).json()
    check(win["target_mode"] == "winrate" and win["plan"]["rr"][0] <= liq["rr"][0] + 1e-9, (win["plan"]["rr"], liq["rr"]))
    if win["plan"]["rr"][0] < liq["rr"][0] - 1e-6:
        check("win-rate target" in win["plan"]["tp_labels"][0] and win["plan"]["p_tp"][0] > liq["p_tp"][0], win["plan"])
    check(c.post("/api/analysis/run", json=dict(symbol="EURUSD", tf="15m", target_mode="nope"), headers=H).status_code == 422,
          "unknown target style")
    # no plan at all: Don't trade, with context flags and no path
    X = next(iter(ga._STATE["ctx"].values()))
    d = hm.build(X, None, dict(headline="No valid plan: wait for a break of structure."), None)
    check(d["state"] == "dont" and d["title"] == "Don't trade" and d["path"] is None and d["summary"].startswith("No valid"), d)
    d = hm.with_news(d, dict(events=[dict(title="CPI", country="USD", time="2026-10-22T15:30:00Z", impact="High",
                                          minutes_until=40)]))
    check([f["key"] for f in d["flags"]].count("news") == 1 and d["state"] == "dont", d["flags"])
    # a broken input never breaks the analysis
    check("error" in hm.build(dict(), dict(dir=1), {}, None), "build guards itself")


def t_watch(c):
    """Strategy watches: set one up, the real scanner reads a pair, a new setup is reported once by site notification,
    email and push, a repeat is not, limits hold, and the cron ping is locked."""
    from app.models import StrategyWatch, utcnow
    from app.services import mailer, watcher
    signup(c, "watch@example.com")
    ids = ["ict_sweep_mss", "ote_pullback", "ob_retest"]
    # the real scan runs on the offline candles and returns well-formed setups (or none)
    res = watcher.scan_pair("BTCUSDT", "15m", [s["id"] for s in st_catalog()])
    check(res["bar"] and res["decimals"] is not None and isinstance(res["signals"], list), res)
    for s in res["signals"]:
        check(s["id"] and s["bar"] and s["dir"] in (1, -1) and s["side"], s)
        if not s["fixed_time"]:
            check(s["dir"] * (s["entry"] - s["sl"]) > 0 and s["dir"] * (s["tp"] - s["entry"]) > 0 and s["rr"] > 0, s)
    # validation
    check(c.post("/api/watches", json=dict(symbol="BTCUSDT", tf="15m", strategies=["nope"]), headers=H).status_code == 422, "ids")
    check(c.post("/api/watches", json=dict(symbol="BTCUSDT", tf="2m", strategies=ids), headers=H).status_code == 422, "tf")
    # a fake scan makes the alert flow deterministic
    bar = [int(time.time()) - 4 * 3600]                       # the newest closed candle, a few hours ago
    live = dict(id="ict_sweep_mss", name="Liquidity sweep + structure shift", dir=1, side="long", kind="market", age=0,
                fixed_time=False, entry=100.0, sl=95.0, tp=112.5, rr=2.5, chase=False)

    def fake(sym, tf, want, sigs=None):
        sg = [dict(live, bar=bar[0])] if sigs is None else sigs
        return dict(symbol=sym, tf=tf, bar=bar[0], decimals=2, price=100.0, signals=[x for x in sg if x["id"] in want])

    old = watcher.scan_pair
    watcher.scan_pair = lambda sym, tf, want: fake(sym, tf, want)
    sent = []
    old_send = mailer.send
    mailer.send = lambda to, subject, text, html=None: sent.append((to, subject, text, html)) or True
    try:
        r = c.post("/api/watches", json=dict(symbol="btcusdt", tf="15m", strategies=ids, email=True, push=False), headers=H)
        check(r.status_code == 200, r.text)
        j = r.json()
        wid = j["watch"]["id"]
        check(j["watch"]["symbol"] == "BTCUSDT" and len(j["live"]) == 1 and j["live"][0]["side"] == "long", j)
        check(c.get("/api/alerts/notifications").json()["unread"] == 0, "what was live when created isn't announced")
        db = _db()
        now = utcnow()
        check(watcher.run_once(now=now + timedelta(minutes=1))["alerts"] == 0, "same candle: nothing new")
        bar[0] += 900                                         # a new candle closes with a fresh setup
        stats = watcher.run_once(now=now + timedelta(minutes=16))
        check(stats["alerts"] == 1 and stats["pairs"] == 1, stats)
        check(watcher.run_once(now=now + timedelta(minutes=17))["alerts"] == 0, "reported once")
        nt = c.get("/api/alerts/notifications").json()
        n0 = nt["items"][0]
        check(nt["unread"] == 1 and n0["kind"] == "watch" and "Buy setup on BTCUSDT 15m" in n0["title"], nt)
        check("Stop loss 95.00" in n0["body"] and "Take profit 112.50" in n0["body"] and "2.5×" in n0["body"], n0["body"])
        check(n0["link"] == "/terminal?s=BTCUSDT&tf=15m", n0["link"])
        check(len(sent) == 1 and sent[0][0] == "watch@example.com" and "Open the chart" in sent[0][3], sent)
        # a different candle, same strategy: reported again; a paused watch: silent
        bar[0] += 900
        check(watcher.run_once(now=now + timedelta(minutes=32))["alerts"] == 1, "next signal")
        check(c.patch(f"/api/watches/{wid}", json=dict(status="paused"), headers=H).json()["status"] == "paused", "pause")
        bar[0] += 900
        check(watcher.run_once(now=now + timedelta(minutes=48))["alerts"] == 0, "paused is silent")
        got = c.get("/api/watches").json()
        check(got["active"] == 0 and got["items"][0]["fired"] == 2 and got["items"][0]["names"], got)
        # email off: only the site notification
        c.patch(f"/api/watches/{wid}", json=dict(status="active", email=False), headers=H)
        bar[0] += 900
        before = len(sent)
        check(watcher.run_once(now=now + timedelta(minutes=64))["alerts"] == 1 and len(sent) == before, "no email when off")
        # only the chosen strategies count
        c.patch(f"/api/watches/{wid}", json=dict(strategies=["ote_pullback"]), headers=H)
        bar[0] += 900
        check(watcher.run_once(now=now + timedelta(minutes=80))["alerts"] == 0, "other strategies' setups don't alert")
        # a fixed-time call reads well too
        t, b = watcher.message(dict(name="FT trend", fixed_time=True, dir=-1, entry=1.2, expiry=3), "EURUSD", "5m", 4)
        check("DOWN" in t and "Expiry" in b, (t, b))
        # a pair that fails to load is reported on the watch, and the others carry on
        def boom(sym, tf, want):
            raise RuntimeError("exchange down")
        watcher.scan_pair = boom
        bar[0] += 900
        watcher.run_once(now=now + timedelta(minutes=96))
        db.expire_all()
        w = db.get(StrategyWatch, wid)
        check("exchange down" in (w.error or ""), w.error)
        db.close()
        # free plan: two watches at most
        _set_user("watch@example.com", trial_ends_at=utcnow() - timedelta(days=1))
        watcher.scan_pair = lambda sym, tf, want: fake(sym, tf, want, sigs=[])
        check(c.post("/api/watches", json=dict(symbol="ETHUSDT", tf="1h", strategies=ids), headers=H).status_code == 200, "2nd")
        r = c.post("/api/watches", json=dict(symbol="SOLUSDT", tf="1h", strategies=ids), headers=H)
        check(r.status_code == 429 and r.json()["detail"]["kind"] == "watches", r.text)
        check(c.delete(f"/api/watches/{wid}", headers=H).status_code == 200, "delete")
        check(c.post("/api/watches", json=dict(symbol="SOLUSDT", tf="1h", strategies=ids), headers=H).status_code == 200, "room")
    finally:
        watcher.scan_pair = old
        mailer.send = old_send
    # the cron ping is locked
    check(c.post("/api/watches/cron").status_code == 403, "no secret")
    settings.cron_secret = "s3cret-s3cret"
    try:
        check(c.post("/api/watches/cron", headers={"X-Cron-Secret": "wrong"}).status_code == 403, "wrong secret")
        r = c.post("/api/watches/cron", headers={"X-Cron-Secret": "s3cret-s3cret"})
        check(r.status_code == 200 and "alerts" in r.json(), r.text)
    finally:
        settings.cron_secret = None


def st_catalog():
    import strategies as st
    return [s for s in st.CATALOG if not s["fixed_time"]]


def t_brokers(c):
    """Connect a broker and send a plan to it: each broker's request is built the way its API wants, the safety caps and
    sanity checks hold, a double send is ignored, keys never come back, and a watch can auto-send within the caps."""
    import hashlib
    import hmac
    from urllib.parse import parse_qs
    from app.models import BrokerAccount, utcnow
    from app.services import brokers as bk
    from app.services import watcher

    calls = []

    def fake(req):
        host, path = req.url.host, req.url.path
        body = json.loads(req.content) if req.content else {}
        calls.append((req.method, host, path, dict(req.url.params), body, dict(req.headers)))
        j = lambda d, code=200: httpx.Response(code, json=d)       # noqa: E731
        if host == "mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai":
            if req.method == "POST":
                return j(dict(id="mt-acc-1", state="DEPLOYED"), 201)
            return j(dict(_id="mt-acc-1", region="london", state="DEPLOYED", connectionStatus="CONNECTED"))
        if host.startswith("mt-client-api-v1"):
            if path.endswith("/account-information"):
                return j(dict(name="Demo", login=123, balance=5000.0, currency="USD", platform="mt5", server="Broker-Demo"))
            if "/specification" in path:
                return j(dict(volumeStep=0.01, minVolume=0.01, maxVolume=50, digits=2))
            if path.endswith("/trade"):
                return j(dict(numericCode=10009, stringCode="TRADE_RETCODE_DONE", message="ok", orderId=str(len(calls))))
        if "oanda.com" in host:
            if path.endswith("/summary"):
                if req.headers.get("authorization") != "Bearer oanda-token":
                    return j(dict(errorMessage="bad token"), 401)
                return j(dict(account=dict(alias="Practice", balance="10000.00", currency="USD")))
            if path.endswith("/orders"):
                return j(dict(orderFillTransaction=dict(id=str(900 + len(calls)))), 201)
        if host == "api-testnet.bybit.com":
            if path == "/v5/account/wallet-balance":
                return j(dict(retCode=0, result=dict(list=[dict(totalEquity="2500.5")])))
            if path == "/v5/market/instruments-info":
                return j(dict(retCode=0, result=dict(list=[dict(lotSizeFilter=dict(qtyStep="0.001", minOrderQty="0.001"),
                                                                priceFilter=dict(tickSize="0.1"))])))
            if path == "/v5/order/create":
                return j(dict(retCode=0, result=dict(orderId=f"by-{len(calls)}")))
        if host == "testnet.binancefuture.com":
            if path.startswith("/fapi/v") and path.endswith("/balance"):
                return j([dict(asset="USDT", balance="1000.0")])
            if path == "/fapi/v1/exchangeInfo":
                return j(dict(symbols=[dict(symbol="BTCUSDT", filters=[
                    dict(filterType="LOT_SIZE", stepSize="0.001", minQty="0.001"),
                    dict(filterType="PRICE_FILTER", tickSize="0.1")])]))
            if path == "/fapi/v1/order":
                return j(dict(orderId=777, status="NEW"))
            if path == "/fapi/v1/algoOrder":
                if binance_fail[0]:
                    return j(dict(code=-4509, msg="algo rejected"), 400)
                return j(dict(algoId=888))
        return j(dict(message="not found"), 404)

    binance_fail = [False]
    bk.set_client(httpx.Client(transport=httpx.MockTransport(fake)))
    signup(c, "broker@example.com")
    ov = c.get("/api/brokers").json()
    check(ov["available"] == dict(mt=False, binance=True, bybit=True, oanda=True) and ov["accounts"] == [], ov)
    # MetaTrader needs the server's MetaApi token
    mt_creds = dict(login="123456", password="pw-secret", server="Broker-Demo", platform="mt5")
    r = c.post("/api/brokers", json=dict(kind="mt", live=False, credentials=mt_creds), headers=H)
    check(r.status_code == 422 and "aren't switched on" in r.text, r.text)
    # OANDA: a wrong token is refused, the right one connects, and the keys never come back
    bad = c.post("/api/brokers", json=dict(kind="oanda", credentials=dict(token="nope", account_id="101-001-1-001")), headers=H)
    check(bad.status_code == 422 and "refused the token" in bad.text, bad.text)
    r = c.post("/api/brokers", json=dict(kind="oanda", label="My practice", live=False, settings=dict(max_size=5000, auto_size=500),
                                         credentials=dict(token="oanda-token", account_id="101-001-1-001")), headers=H)
    check(r.status_code == 200 and r.json()["info"]["balance"] == 10000.0 and r.json()["live"] is False, r.text)
    oanda = r.json()["id"]
    check("oanda-token" not in r.text and "oanda-token" not in c.get("/api/brokers").text, "keys are not returned")
    db = _db()
    row = db.get(BrokerAccount, oanda)
    check("oanda-token" not in row.secrets and bk.unseal(row.secrets)["token"] == "oanda-token", "stored encrypted")
    db.close()
    plan = dict(broker_id=oanda, symbol="XAU/USD", side="long", kind="market", entry=4739.5, sl=4725.0, tps=[4768.0, 4790.0],
                size=1000, confirm=True)
    # nothing is sent until confirmed, and wrong-way stops or targets are refused before any request goes out
    n0 = len(calls)
    check(c.post("/api/brokers/send", json=dict(plan, confirm=False), headers=H).status_code == 422, "needs confirm")
    r = c.post("/api/brokers/send", json=dict(plan, sl=4750.0), headers=H)
    check(r.status_code == 422 and "stop loss must be below" in r.text, r.text)
    r = c.post("/api/brokers/send", json=dict(plan, tps=[4700.0]), headers=H)
    check(r.status_code == 422 and "above the entry" in r.text, r.text)
    r = c.post("/api/brokers/send", json=dict(plan, size=9000), headers=H)
    check(r.status_code == 422 and "above the 5000" in r.text, r.text)
    check(len(calls) == n0, "refused orders never reach the broker")
    # a good order: OANDA gets signed units, the stop and the first target
    r = c.post("/api/brokers/send", json=dict(plan, ref="tap-1"), headers=H)
    check(r.status_code == 200 and r.json()["ok"] and r.json()["live"] is False, r.text)
    o = [x for x in calls if x[2].endswith("/orders")][-1][4]["order"]
    check(o["instrument"] == "XAU_USD" and o["units"] == "1000" and o["type"] == "MARKET"
          and o["stopLossOnFill"]["price"] == "4725.000" and o["takeProfitOnFill"]["price"] == "4768.000", o)
    n1 = len(calls)
    r = c.post("/api/brokers/send", json=dict(plan, ref="tap-1"), headers=H)
    check(r.status_code == 200 and r.json()["duplicate"] and len(calls) == n1, ("a double tap sends once", r.text))
    # a sell with split targets: units are negative and split across the targets
    r = c.post("/api/brokers/send", json=dict(plan, side="short", kind="limit", entry=4750.0, sl=4770.0, tps=[4730.0, 4710.0],
                                              tp_mode="split", size=1001), headers=H)
    check(r.status_code == 200, r.text)
    sent = [x[4]["order"] for x in calls if x[2].endswith("/orders")][-2:]
    check([x["units"] for x in sent] == ["-501", "-500"] and sent[0]["type"] == "LIMIT" and sent[0]["price"] == "4750.000", sent)
    # the daily order cap
    check(c.patch(f"/api/brokers/{oanda}", json=dict(settings=dict(max_orders_day=3)), headers=H).status_code == 200, "cap")
    r = c.post("/api/brokers/send", json=dict(plan, ref="tap-3"), headers=H)
    check(r.status_code == 200, r.text)
    r = c.post("/api/brokers/send", json=dict(plan, ref="tap-4"), headers=H)
    check(r.status_code == 422 and "last 24 hours" in r.text, r.text)
    check(c.patch(f"/api/brokers/{oanda}", json=dict(settings=dict(max_orders_day=5)), headers=H).status_code == 200, "cap back")
    # MetaTrader through MetaApi: provisioning, region, split lots
    settings.metaapi_token = "metaapi-token"
    try:
        check(c.get("/api/brokers").json()["available"]["mt"] is True, "the MT option turns on with the token")
        r = c.post("/api/brokers", json=dict(kind="mt", live=True, settings=dict(symbol_suffix="m"), credentials=mt_creds), headers=H)
        check(r.status_code == 200 and r.json()["info"]["balance"] == 5000.0 and r.json()["live"], r.text)
        check("pw-secret" not in r.text, "the MT password isn't returned")
        db = _db()
        check("pw-secret" not in db.get(BrokerAccount, r.json()["id"]).secrets, "the MT password isn't stored")
        db.close()
        mt = r.json()["id"]
        prov = [x for x in calls if x[0] == "POST" and x[2] == "/users/current/accounts"][-1]
        check(prov[4]["login"] == "123456" and prov[4]["platform"] == "mt5" and prov[5].get("auth-token") == "metaapi-token", prov[4])
        r = c.post("/api/brokers/send", json=dict(plan, broker_id=mt, symbol="XAUUSD", side="short", kind="limit", entry=4750.0,
                                                  sl=4770.0, tps=[4730.0, 4710.0, 4690.0], tp_mode="split", size=0.3), headers=H)
        check(r.status_code == 200 and r.json()["live"], r.text)
        trades = [x for x in calls if x[2].endswith("/trade")][-3:]
        check(all(x[1] == "mt-client-api-v1.london.agiliumtrade.ai" for x in trades), "the account's region is used")
        check([x[4]["volume"] for x in trades] == [0.1, 0.1, 0.1] and [x[4]["takeProfit"] for x in trades] == [4730.0, 4710.0, 4690.0], trades)
        check(trades[0][4]["actionType"] == "ORDER_TYPE_SELL_LIMIT" and trades[0][4]["symbol"] == "XAUUSDm"
              and trades[0][4]["openPrice"] == 4750.0 and trades[0][4]["stopLoss"] == 4770.0, trades[0][4])
        r = c.post("/api/brokers/send", json=dict(plan, broker_id=mt, symbol="XAUUSD", size=1.5), headers=H)
        check(r.status_code == 422 and "above the 1" in r.text, ("MT lots default cap", r.text))
    finally:
        settings.metaapi_token = None
    # Bybit testnet: signed headers, the quantity and prices follow the instrument's steps
    r = c.post("/api/brokers", json=dict(kind="bybit", live=False, settings=dict(max_notional=5000),
                                         credentials=dict(key="by-key", secret="by-secret")), headers=H)
    check(r.status_code == 200 and r.json()["info"]["balance"] == 2500.5, r.text)
    by = r.json()["id"]
    r = c.post("/api/brokers/send", json=dict(plan, broker_id=by, symbol="BTC/USDT", side="long", kind="limit", entry=100000.04,
                                              sl=99000.0, tps=[102000.07], size=0.0456), headers=H)
    check(r.status_code == 200, r.text)
    x = [k for k in calls if k[2] == "/v5/order/create"][-1]
    raw = json.dumps(x[4], separators=(",", ":"))
    want = hmac.new(b"by-secret", (x[5]["x-bapi-timestamp"] + "by-key" + x[5]["x-bapi-recv-window"] + raw).encode(), hashlib.sha256).hexdigest()
    check(x[5]["x-bapi-sign"] == want and x[5]["x-bapi-api-key"] == "by-key", "V5 signature")
    check(x[4]["symbol"] == "BTCUSDT" and x[4]["side"] == "Buy" and x[4]["orderType"] == "Limit" and x[4]["qty"] == "0.045"
          and x[4]["price"] == "100000" and x[4]["stopLoss"] == "99000" and x[4]["takeProfit"] == "102000.1"
          and x[4]["tpslMode"] == "Full", x[4])
    r = c.post("/api/brokers/send", json=dict(plan, broker_id=by, symbol="BTC/USDT", entry=100000.0, sl=99000.0, tps=[102000.0],
                                              size=0.1), headers=H)
    check(r.status_code == 422 and "5,000" in r.text or "above the" in r.text, ("notional cap", r.text))
    # Binance testnet: entry, then a stop and a take profit that close the position; a failed stop undoes the entry
    r = c.post("/api/brokers", json=dict(kind="binance", live=False, settings=dict(max_notional=5000),
                                         credentials=dict(key="bn-key", secret="bn-secret")), headers=H)
    check(r.status_code == 200 and r.json()["info"]["balance"] == 1000.0, r.text)
    bn = r.json()["id"]
    bplan = dict(plan, broker_id=bn, symbol="BTC/USDT", side="short", kind="market", entry=100000.0, sl=101000.0,
                 tps=[98000.0, 96000.0], size=0.0123)
    r = c.post("/api/brokers/send", json=bplan, headers=H)
    check(r.status_code == 200 and "take profit 1" in r.json()["note"], r.text)
    seq = [(k[0], k[2], k[3]) for k in calls[-4:]]
    check([s[1] for s in seq] == ["/fapi/v1/exchangeInfo", "/fapi/v1/order", "/fapi/v1/algoOrder", "/fapi/v1/algoOrder"], seq)
    ent, sl_o, tp_o = seq[1][2], seq[2][2], seq[3][2]
    check(ent["side"] == "SELL" and ent["quantity"] == "0.012" and ent["type"] == "MARKET" and "signature" in ent, ent)
    q = [k[3] for k in calls[-4:]][1]
    check(sl_o["type"] == "STOP_MARKET" and sl_o["side"] == "BUY" and sl_o["triggerPrice"] == "101000"
          and sl_o["closePosition"] == "true" and tp_o["type"] == "TAKE_PROFIT_MARKET" and tp_o["triggerPrice"] == "98000", (sl_o, tp_o))
    binance_fail[0] = True
    n2 = len(calls)
    r = c.post("/api/brokers/send", json=bplan, headers=H)
    check(r.status_code == 422 and "algo rejected" in r.text and "nothing is left without a stop" in r.text, r.text)
    undo = [k for k in calls[n2:] if k[2] == "/fapi/v1/order"]
    check(len(undo) == 2 and undo[1][3].get("reduceOnly") == "true" and undo[1][3]["side"] == "BUY", ("the entry is closed again", undo))
    binance_fail[0] = False
    # the record
    orders = c.get("/api/brokers/orders").json()["items"]
    check(orders and {o["status"] for o in orders} == {"sent", "failed"} and all(o["symbol"] for o in orders), orders)
    # a watch sends by itself within the caps: it needs a size first, and the fresh setup is placed and said in the alert
    bar = [int(time.time()) - 4 * 3600]
    sig = dict(id="ict_sweep_mss", name="Liquidity sweep + structure shift", dir=1, side="long", kind="market", age=0,
               fixed_time=False, entry=4739.5, sl=4725.0, tp=4768.0, rr=2.0, chase=False)

    def scan(sym, tf, want):
        return dict(symbol="XAU/USD", tf=tf, bar=bar[0], decimals=2, price=4739.5,
                    signals=[dict(sig, bar=bar[0])] if "ict_sweep_mss" in want else [])

    old = watcher.scan_pair
    watcher.scan_pair = scan
    try:
        c.patch(f"/api/brokers/{oanda}", json=dict(settings=dict(auto_size=None)), headers=H)
        r = c.post("/api/watches", json=dict(symbol="XAUUSD", tf="15m", strategies=["ict_sweep_mss"], broker_id=oanda,
                                            auto_send=True), headers=H)
        check(r.status_code == 422 and "auto-send size" in r.text, r.text)
        c.patch(f"/api/brokers/{oanda}", json=dict(settings=dict(auto_size=500)), headers=H)
        n3 = len([k for k in calls if k[2].endswith("/orders")])
        r = c.post("/api/watches", json=dict(symbol="XAUUSD", tf="15m", strategies=["ict_sweep_mss"], broker_id=oanda,
                                            auto_send=True, email=False, push=False), headers=H)
        check(r.status_code == 200 and r.json()["watch"]["auto_send"] and r.json()["watch"]["broker_id"] == oanda, r.text)
        wid = r.json()["watch"]["id"]
        check(len([k for k in calls if k[2].endswith("/orders")]) == n3, "nothing is placed for a setup that was already live")
        bar[0] += 900
        check(watcher.run_once(now=utcnow() + timedelta(minutes=16))["alerts"] == 1, "alert")
        placed = [k for k in calls if k[2].endswith("/orders")]
        check(len(placed) == n3 + 1 and placed[-1][4]["order"]["units"] == "500" and placed[-1][4]["order"]["stopLossOnFill"]["price"] == "4725.000", placed[-1][4])
        nt = c.get("/api/alerts/notifications").json()["items"][0]
        check("Sent to My practice (demo)" in nt["body"], nt["body"])
        check(watcher.run_once(now=utcnow() + timedelta(minutes=17))["alerts"] == 0 and
              len([k for k in calls if k[2].endswith("/orders")]) == n3 + 1, "a setup is placed once")
        # a stale signal is never auto-placed; pausing a watch doesn't ask again; removing the broker switches auto-send off
        check(c.patch(f"/api/watches/{wid}", json=dict(status="paused"), headers=H).status_code == 200, "pause")
        check(c.delete(f"/api/brokers/{oanda}", headers=H).status_code == 200, "remove broker")
        w = c.get("/api/watches").json()["items"][0]
        check(w["broker_id"] is None and w["auto_send"] is False, w)
    finally:
        watcher.scan_pair = old
    # a broker is only for plans that pay: the free plan can look, not connect
    _set_user("broker@example.com", trial_ends_at=utcnow() - timedelta(days=1))
    r = c.post("/api/brokers", json=dict(kind="bybit", live=False, credentials=dict(key="a", secret="b")), headers=H)
    check(r.status_code == 402, r.text)


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
        run("t_email_brevo", t_email_brevo, None)
        run("t_psychology", t_psychology, None)
        run("t_replay_decisions", t_replay_decisions, client())
        run("t_behaviour_model", t_behaviour_model, None)
        run("t_gemini", t_gemini, client())
        run("t_sweeps", t_sweeps, None)
        run("t_selflearn", t_selflearn, None)
        run("t_admin_accounts", t_admin_accounts, client())
        run("t_security", t_security, client())
        for t in (t_terms_and_site, t_stage2, t_practice, t_strategy, t_scalp_template, t_tracker_rules, t_track_record, t_alerts, t_push, t_replay,
                  t_learning_export, t_strategies, t_strategy_engine, t_heads, t_hud, t_watch, t_brokers, t_my_analyses, t_class_live, t_ideas, t_replay_gate):
            run(t.__name__, t, client())
    bad = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(bad)}/{len(RESULTS)} passed in {time.time() - t0:.0f}s")
    shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

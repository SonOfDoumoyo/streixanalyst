"""Builds trading_ai_10_strategies_liquidity.ipynb: the brain's strategy head and liquidity head (model v1.5).

The engine files are copied from backend/guru at build time, so the notebook trains exactly what the server runs.
Rebuild it whenever those files change:  python notebooks/build_nb10.py notebooks/trading_ai_10_strategies_liquidity.ipynb"""
import ast
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR = os.environ.get("GURU_ENGINE_DIR", os.path.join(HERE, "..", "backend", "guru"))
ENGINE_FILES = ["structure_engine.py", "market_data.py", "guru_levels.py", "guru_model.py", "strategies.py",
                "liquidity_head.py", "strategy_head.py", "playbook.py", "guru_analyst.py"]
CELLS = []


def md(text):
    CELLS.append(("markdown", text))


def code(text):
    CELLS.append(("code", text))


md("""# Trading AI: Notebook 10, every strategy and liquidity (model v1.5)

This adds two parts to the brain the StreixAnalyst server loads. Both are learned from years of candles on 30 markets (forex, gold, silver, indices, oil and 10 crypto pairs), on every timeframe from 1 minute to 1 week.

**1. The strategy head.** Every strategy a person can pick in the app (smart money and ICT setups, price action, the indicator strategies such as Supertrend, MACD, RSI and Bollinger, scalping, and fixed-time calls: 45 in all) is run on every market and timeframe exactly the way the app runs it. That means entry on the next candle's open, the strategy's own stop moved past nearby liquidity, its target, the market's costs and slippage, and the stop counted first when one candle touches both. From those trades the brain learns:
- **The odds of each live signal**: the chance a signal like this ends in profit, from the market's context when it fires (structure, higher-timeframe trend, momentum, volatility, liquidity, session), the trade's shape, and how that strategy had been doing on that market just before.
- **What works where**: every strategy's results by market and timeframe, after costs. The strategy picker in the app shows them.

**2. The liquidity head.** For every pool of liquidity near price (untaken swing highs and lows, equal highs and lows, the previous day's high and low, and the Asian range), it learns:
- **Sweep**: the chance it's taken within the next 24 candles.
- **Reversal**: after a sweep, the chance price closes back inside and runs 1 ATR the other way (a stop hunt that turns, not a breakout).
- **Depth**: how far past the pool such hunts reach. The app puts stops beyond that point, so a normal hunt doesn't stop the trade out.

**Honest testing.** Every part is trained on the first 70% of each market's history and judged on the last 30%, which it never saw. Each part is compared with a simple baseline: the strategy's own historical rate, the distance alone, or the chart rule the app uses now. **The app only uses a part that beats its baseline there** (the `use` flags in section 6). The evidence tables are shown either way. None of this guarantees profit. It makes the analyst's numbers better informed and more honest.

*Research tool, not financial advice. Paper-trade first.*

**How to run**
1. Runtime → Run all. Allow Google Drive.
2. With `PRESET = "standard"` it takes about 45–75 minutes the first time (downloading and training). Later runs reuse the Drive cache.
3. If you uploaded a brain from Notebook 7 or 8 before, `REUSE_BRAIN = True` keeps its main models and adds the two heads, which saves about 30 minutes.
4. Download `guru_brain_v15.joblib` from your Drive (`trading_ai/guru_v15/`), then upload it in the app: Admin → System & model.""")

md("## 0. Settings and setup")

code('''# ---- Settings you can change ----
PRESET = "standard"              # "quick" (about 15 min, for a check) or "standard" (about 45-75 min)
REUSE_BRAIN = True               # keep the main models from your last brain (Notebook 8 or 7) when one is found
USE_DRIVE = True
SCALP_DATA = True                # also 5-minute and 1-minute history, for the scalping strategies
APP_VERSION = "1.5"              # recorded in the file for reference
''')

code('''import os
# Where things are saved (Google Drive if mounted, otherwise this Colab session only)
SAVE_DIR = "trading_ai"
if USE_DRIVE:
    try:
        from google.colab import drive
        drive.mount("/content/drive")
        SAVE_DIR = "/content/drive/MyDrive/trading_ai"
    except Exception as e:
        print("Drive not mounted, saving inside this session only:", e)

GURU_DIR = os.path.join(SAVE_DIR, "guru_v15")
CACHE_DIR = os.path.join(SAVE_DIR, "guru_cache")
BRAIN_PATH = os.path.join(GURU_DIR, "guru_brain_v15.joblib")
PREVIOUS = [os.path.join(SAVE_DIR, "guru_v14", "guru_brain_v14_scalp.joblib"),
            os.path.join(SAVE_DIR, "guru_v13", "guru_brain_v13.joblib")]
for d in (GURU_DIR, CACHE_DIR):
    os.makedirs(d, exist_ok=True)
print("Saving to", GURU_DIR)
''')

md("""## 0b. The engine code

The engine (the same files as `backend/guru` on the server, including the strategies and the two new heads) is written into this notebook by the cells below. Nothing needs to be downloaded from GitHub. Run these cells once.""")

for _name in ENGINE_FILES:
    with open(os.path.join(ENGINE_DIR, _name), encoding="utf-8") as _f:
        code("%%writefile " + _name + "\n" + _f.read())

code('''import os, sys, io, json, glob, time, subprocess, warnings
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
sys.path.insert(0, os.getcwd())         # the engine files written above live here
pd.set_option("display.width", 220)
pd.set_option("display.max_columns", 30)

subprocess.run([sys.executable, "-m", "pip", "-q", "install", "dukascopy-python==4.0.1",
                "yfinance>=0.2.40", "joblib>=1.3"], check=True)

import sklearn
REQUIRED_SKLEARN = "1.6.1"               # the server's pin (backend/requirements.txt); the server refuses any other version
if sklearn.__version__ != REQUIRED_SKLEARN:
    raise RuntimeError(f"This Colab has scikit-learn {sklearn.__version__}, but the server needs {REQUIRED_SKLEARN}. "
                       "In a new cell run !pip install -q scikit-learn==1.6.1, then Runtime > Restart session, then Run all again.")
import joblib
import market_data as md
import guru_model as gm
import guru_analyst as ga
import strategies as st
import strategy_head as sh
import liquidity_head as lh
md.set_cache_dir(CACHE_DIR)
print("scikit-learn", sklearn.__version__, "| numpy", np.__version__, "| pandas", pd.__version__)
print("Engine", gm.VERSION, "| strategies:", len(st.CATALOG), "| strategy head", sh.VERSION, "| liquidity head", lh.VERSION)
''')

md("""## 1. Market data

The same 30 markets as Notebooks 7 and 8: 15-minute, 1-hour, daily (4h and weekly are built from them), plus 5-minute and 1-minute history for the markets scalpers trade most (EURUSD, GBPUSD, USDJPY, gold, NAS100, US30, BTC, ETH, SOL). Each market comes from the first data feed that answers; for crypto, Dukascopy is the fallback. Everything is cached on Drive, so a second run is quick.""")

code('''MARKETS = {
    "quick": ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "US500", "NAS100", "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"],
    "standard": ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "EURJPY", "GBPJPY", "EURGBP",
                 "XAUUSD", "XAGUSD", "US500", "NAS100", "US30", "GER40", "UK100", "JP225", "USOIL", "UKOIL",
                 "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
                 "LINKUSDT", "LTCUSDT"],
}
SCALP_MARKETS = {"quick": ["EURUSD", "XAUUSD", "BTCUSDT"],
                 "standard": ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "NAS100", "US30", "BTCUSDT", "ETHUSDT", "SOLUSDT"]}
PRESETS = {
    "quick": dict(markets=MARKETS["quick"], years={"1h": 3, "15m": 1}, daily_from="2015-01-01",
                  scalp=SCALP_MARKETS["quick"], days_5m=60, days_1m=14, rows=200_000,
                  strategy_rows=250_000, liquidity_rows=150_000),
    "standard": dict(markets=MARKETS["standard"], years={"1h": 5, "15m": 2}, daily_from="2012-01-01",
                     scalp=SCALP_MARKETS["standard"], days_5m=180, days_1m=30, rows=450_000,
                     strategy_rows=900_000, liquidity_rows=600_000),
}
P = PRESETS[PRESET]


def load_history(sym, tf, years=None, start=None):
    """History for one market and timeframe. Crypto falls back to Dukascopy if no exchange feed answers."""
    tries = [sym]
    spec = md.parse_symbol(sym)
    if spec["asset_class"] == "crypto" and spec["base"] in md.DUKA_CRYPTO:
        tries.append(f"DUKASCOPY:{spec['base']}USD")
    for s in tries:
        try:
            return md.history(s, tf, years=years, start=start)
        except Exception as e:
            print(f"  warning {s} {tf}: {str(e)[:160]}")
    return None


DATA = {}
t0 = time.time()
for k, sym in enumerate(P["markets"]):
    print(f"[{k + 1}/{len(P['markets'])}] {sym}")
    for tf, yrs in P["years"].items():
        c = load_history(sym, tf, years=yrs)
        if c is not None:
            DATA[(sym, tf)] = c
            if tf == "1h":
                DATA[(sym, "4h")] = dict(c, tf="4h", df=md.resample(c["df"], "4h", "1h"))
    c = load_history(sym, "1D", start=P["daily_from"])
    if c is not None:
        DATA[(sym, "1D")] = c
        d = c["df"] if c["asset_class"] == "crypto" else md.trading_days(c["df"])
        DATA[(sym, "1W")] = dict(c, tf="1W", df=md.resample(d, "1W", "1D"))
    if SCALP_DATA and sym in P["scalp"]:
        for tf, days in (("5m", P["days_5m"]), ("1m", P["days_1m"])):
            c = load_history(sym, tf, years=days / 365.25)
            if c is not None:
                DATA[(sym, tf)] = c
COVERAGE = pd.DataFrame([dict(market=sym, tf=tf, source=c["source"], candles=len(c["df"]))
                         for (sym, tf), c in DATA.items()])
print(f"Loaded {len(DATA)} series ({COVERAGE['candles'].sum():,} candles) in {time.time() - t0:.0f}s")
display(COVERAGE.pivot_table(index="market", columns="tf", values="candles", aggfunc="sum")
        .reindex(columns=[t for t in md.TFS if t in set(COVERAGE["tf"])]).fillna(0).astype(int))
''')

md("""## 2. The main brain

The trade-odds, level and direction models the app already uses. With `REUSE_BRAIN = True` and a brain from Notebook 8 or 7 on your Drive, those models are kept as they are, and only the two new heads are trained. Otherwise they are trained here the same way as Notebook 7 (about 30 minutes more).""")

code('''BUNDLE = None
if REUSE_BRAIN:
    for path in PREVIOUS:
        if os.path.exists(path):
            BUNDLE = gm.load(path)
            print(f"Keeping the main models of {os.path.basename(path)} (trained {BUNDLE['created'][:16]})")
            break
if BUNDLE is not None and BUNDLE.get("sklearn") not in (None, sklearn.__version__):
    print(f"That brain was built with scikit-learn {BUNDLE.get('sklearn')}, not {sklearn.__version__}: retraining it.")
    BUNDLE = None
if BUNDLE is None:
    SERIES_MAIN = [dict(symbol=c["symbol"], tf=tf, asset_class=c["asset_class"], sub=c["sub"], df=c["df"])
                   for (sym, tf), c in DATA.items() if len(c["df"]) >= 400]
    if len(SERIES_MAIN) < 5:
        raise RuntimeError("Too few markets downloaded to train. Check the warnings above (internet or data source).")
    print(f"Training the main brain on {len(SERIES_MAIN)} series...")
    D = gm.build_dataset(SERIES_MAIN, budget=dict(rows=P["rows"]))
    BUNDLE = gm.train(D)
    del D
''')

md("""## 3. The strategy head

Every strategy, on every market and timeframe, run the app's way. The strategies that need an intraday chart are left out of daily and weekly charts. For each trade, the features at the signal candle are recorded with what happened next. A signal still running at the 70% mark of a market's history is left out of training, so no training trade overlaps the test period.

This is the longest part: roughly 15–35 minutes with the standard preset.""")

code('''SERIES = [dict(symbol=sym, tf=tf, asset_class=c["asset_class"], sub=c["sub"], df=c["df"])
          for (sym, tf), c in DATA.items() if len(c["df"]) >= 600]
print(f"{len(SERIES)} series for the heads")
t0 = time.time()
SD = sh.build(SERIES, budget=P["strategy_rows"])
print(f"{len(SD):,} strategy trades in {time.time() - t0:.0f}s")
STRATEGY_HEAD = sh.train(SD)
''')

code('''c = STRATEGY_HEAD["card"]
print("== Does the model pick better signals than taking them all? (test period, after costs)")
print(c["model"]["selection"].round(3).to_string(index=False))
print()
print(f"AUC {c['model']['auc_model']:.3f} vs the strategy's own rate {c['model']['auc_rate']:.3f} | "
      f"Brier skill {c['model']['skill_vs_rate']:+.3f} | the app uses the per-signal odds: {c['use']['odds']}")
print()
print("== Each strategy on the test period (sorted by average R after costs)")
display(c["per_strategy_test"].round(3))
''')

md("""### What works where

The strategies with the best average result after costs on each market and timeframe, over the whole history (at least 40 trades). The app shows these in the strategy picker. A t-stat below about 2 means the result could easily be luck.""")

code('''E = STRATEGY_HEAD["evidence_market"]
best = (E[E["trades"] >= 40].sort_values("avg_r", ascending=False).groupby(["symbol", "tf"]).head(3)
        .sort_values(["symbol", "tf", "avg_r"], ascending=[True, True, False]))
best = best.assign(name=best["sid"].map(lambda s: st.BY_ID[s]["name"]))
display(best[["symbol", "tf", "name", "trades", "win_rate", "avg_r", "t_stat"]].round(3).reset_index(drop=True))
print("\\nBy kind of market and timeframe group (all strategies):")
K = STRATEGY_HEAD["evidence_class"].assign(name=lambda x: x["sid"].map(lambda s: st.BY_ID[s]["name"]))
display(K.sort_values(["asset_class", "tf_group", "avg_r"], ascending=[True, True, False])
        .groupby(["asset_class", "tf_group"]).head(5)[["asset_class", "tf_group", "name", "trades", "win_rate", "avg_r", "t_stat"]]
        .round(3).reset_index(drop=True))
''')

md("""## 4. The liquidity head

For sampled candles of every market and timeframe: the nearest untaken pools above and below price (up to 3 each side, within 8 ATR), their features, and what happened next (swept or not within 24 candles; if swept, whether it closed back inside within 3 candles and ran 1 ATR the other way; how far past the pool the hunt reached).""")

code('''t0 = time.time()
LD = lh.build(SERIES, budget=P["liquidity_rows"])
print(f"{len(LD):,} pool rows in {time.time() - t0:.0f}s")
LIQUIDITY_HEAD = lh.train(LD)
''')

code('''c = LIQUIDITY_HEAD["card"]
print("== Sweep: will the pool be taken within 24 candles?")
print({k: (round(v, 4) if isinstance(v, float) else v) for k, v in c["sweep"].items() if not isinstance(v, pd.DataFrame)})
display(c["sweep"]["by_type"].round(3))
print("Calibration (predicted vs what happened):")
display(c["sweep"]["calibration"])
print("\\n== Reversal after a sweep")
print({k: (round(v, 4) if isinstance(v, float) else v) for k, v in c["reverse"].items() if not isinstance(v, pd.DataFrame)})
print("\\n== Depth of stop hunts (the stop buffer): coverage = share of hunts the buffer would have survived")
print({k: (round(v, 4) if isinstance(v, float) else v) for k, v in c["depth"].items()})
print("\\nThe app uses:", c["use"])
print("\\n== Experience table: how often pools are taken, reverse, and how deep hunts go (ATR)")
display(LIQUIDITY_HEAD["table"].round(3))
''')

md("""## 5. A live check

The new brain reads one market now, with a few strategies chosen, so you can see what the app will show: the pools with their odds, the stops placed past liquidity, and each strategy's history.""")

code('''BUNDLE["strategy_head"] = STRATEGY_HEAD
BUNDLE["liquidity_head"] = LIQUIDITY_HEAD
BRAIN = ga.use_brain(BUNDLE)
try:
    res = ga.jsonable(ga.analyze("EURUSD", "1h", strategies=["ict_sweep_mss", "ote_pullback", "sr_bounce", "supertrend"]))
    print(res["verdict"]["action"], "|", res["verdict"]["headline"])
    print(res["liquidity"]["text"])
    if res["liquidity"].get("pools"):
        display(pd.DataFrame(res["liquidity"]["pools"]).round(3))
    for x in res["strategies"]["items"]:
        print(x["name"], "| history:", x.get("history"), "| this signal:", x.get("head"))
    if res["plan"]:
        print("Plan:", res["plan"]["text"], "| liquidity guard:", res["plan"].get("liquidity_guard"))
except Exception as e:
    print("Live check skipped (no live data from this Colab right now):", type(e).__name__, str(e)[:200])
''')

md("## 6. Save and next step")

code('''BUNDLE["preset"] = PRESET
BUNDLE["app_version"] = APP_VERSION
BUNDLE["sklearn"] = sklearn.__version__          # the server must run this exact version
BUNDLE["notebook"] = "trading_ai_10 · strategies and liquidity"
gm.save(BUNDLE, BRAIN_PATH)
size = os.path.getsize(BRAIN_PATH) / 1e6
print(f"Saved {BRAIN_PATH} ({size:.1f} MB)")
print()
print("What the app will use from this brain:")
print("  strategy odds per signal:", STRATEGY_HEAD["use"]["odds"], "(strategy history in the picker: always)")
print("  liquidity sweep odds:", LIQUIDITY_HEAD["use"]["sweep"])
print("  reversal after a sweep:", LIQUIDITY_HEAD["use"]["reverse"])
print("  learned stop depth past pools:", LIQUIDITY_HEAD["use"]["depth"])
print("\\nSet the server's scikit-learn to exactly:", BUNDLE["sklearn"])
''')

md("""### Before you upload
1. Read sections 3 and 4. For the strategy head, the question is whether **top half / top quarter by model** beats **every signal** on the test period, with a t-stat that isn't near zero. For the liquidity head, the `use` flags say which parts beat their baseline on data they never saw.
2. Upload `guru_brain_v15.joblib`: sign in as the admin, open **Admin → System & model**, and choose the file. The page then lists which heads are on.
3. In the app, the strategy picker shows each strategy's history on the market being viewed, and analyses show the pools with their odds and the learned stop depth. A part whose `use` flag is off stays off.
4. Rerun this notebook every few months so the history stays current. Nothing changes in the app until you upload a new file.""")


def to_nb(cells):
    nb_cells = []
    for kind, text in cells:
        lines = text.splitlines(keepends=True)
        if kind == "markdown":
            nb_cells.append({"cell_type": "markdown", "metadata": {}, "source": lines})
        else:
            nb_cells.append({"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [],
                             "source": lines})
    return {"nbformat": 4, "nbformat_minor": 5,
            "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
                         "language_info": {"name": "python"}, "colab": {"provenance": []}},
            "cells": nb_cells}


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "trading_ai_10_strategies_liquidity.ipynb")
    for kind, text in CELLS:
        if kind == "code" and not text.startswith("%%writefile"):
            ast.parse(text)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(to_nb(CELLS), f, ensure_ascii=False, indent=1)
    print("wrote", out, "with", len(CELLS), "cells")

"""strategy_head.py: the analyst's experience of every strategy in strategies.py, learned from years of candles.

Every signal of every strategy (smart money and ICT setups, price action, the indicator strategies, scalping and
fixed-time calls) is run on every market and timeframe exactly the way the app runs it: entry at the next candle's
open, the strategy's own stop moved past nearby liquidity by the guard, its target, costs and slippage for that market,
the stop first when one candle touches both. From those trades it learns:

  * the model   P(the trade ends in profit) for a signal, from the market's context at the signal candle (structure,
                trend on the higher timeframes, momentum, volatility, liquidity, session), the trade's geometry, the
                strategy itself, and how that strategy had been doing on that market just before (known at the time)
  * evidence    every strategy's results by market type and timeframe, and per market: what tends to work where

Tested on the last 30% of every series (never seen in training), against each strategy's own historical rate. The
app uses the per-signal odds only if they beat that rate there (the `use` flag); the evidence tables are always shown.

Research tool, not financial advice."""
import math
import time
import warnings

import numpy as np
import pandas as pd

import guru_model as gm
import strategies as st
import structure_engine as se

VERSION = "1.0"
IDS = [s["id"] for s in st.CATALOG]
GROUP_IDS = [g[0] for g in st.GROUPS]
SID_CODE = {sid: k for k, sid in enumerate(IDS)}
GROUP_CODE = {g: k for k, g in enumerate(GROUP_IDS)}
RECENT = 30                     # the strategy's last 30 closed trades on the market (known at the signal) as context
GEO = ["b_atr", "a_atr", "log_rr", "guarded", "is_ft", "expiry"]
REC = ["recent_wr", "recent_r", "recent_n"]
CAT = ["sid_code", "group_code"]
COLS = gm.ALIGNED + GEO + REC + CAT
DAILY_UP = ("1D", "3D", "1W", "1M")


def _group_of(sid):
    return st.BY_ID[sid]["group"]


# ───────────────────────────── trades ─────────────────────────────
def strategy_trades(ctx, sid, cost, slip, cap=None, rng=None):
    """Every signal of one strategy on one frame, run the app's way (signals may overlap). cap: at most this many
    signals (spread over the whole frame) to keep huge frames quick."""
    s = st.BY_ID[sid]
    if s["intraday"] and ctx.tf in DAILY_UP:
        return []
    sg = st.signals(ctx, sid)
    lng, sht = sg["long"], sg["short"]
    idx = np.flatnonzero(lng | sht)
    idx = idx[idx < ctx.n - 2]
    if cap and len(idx) > cap:
        idx = np.sort((rng or np.random.default_rng(0)).choice(idx, cap, replace=False))
    depth = ctx.sweep_depth()
    out = []
    C = ctx.c
    for i in idx:
        d = 1 if lng[i] else -1
        a = ctx.atr[i]
        if not np.isfinite(a) or a <= 0:
            continue
        if s["fixed_time"]:
            N = s["expiry"]
            if i + N >= ctx.n:
                continue
            win = d * (C[i + N] - C[i]) > 0
            out.append(dict(bar=int(i), side=d, exit_i=int(i + N), r=float(st.FT_PAYOUT if win else -1.0),
                            win=bool(win), b_atr=0.0, a_atr=0.0, log_rr=0.0, guarded=0.0, is_ft=1.0,
                            expiry=float(N)))
            continue
        t = st.trade_at(ctx, sid, i, d, cost, slip, True, depth)
        if t is None or t["open"]:
            continue
        b = abs(t["entry"] - t["stop"]) / a
        aa = abs(t["target"] - t["entry"]) / a
        out.append(dict(bar=int(i), side=d, exit_i=int(t["exit_i"]), r=float(t["r"]), win=bool(t["r"] > 0),
                        b_atr=float(b), a_atr=float(aa), log_rr=float(math.log(max(aa, 1e-6) / max(b, 1e-6))),
                        guarded=float(t["guarded"]), is_ft=0.0, expiry=0.0))
    return out


def recent_stats(trades, at):
    """The strategy's last RECENT closed trades before candle `at` (by exit): win rate, average R and how many."""
    if not trades:
        return np.nan, np.nan, 0.0
    ex = np.array([t["exit_i"] for t in trades])
    order = np.argsort(ex, kind="stable")
    ex = ex[order]
    w = np.array([t["win"] for t in trades], dtype=float)[order]
    r = np.array([t["r"] for t in trades], dtype=float)[order]
    k = int(np.searchsorted(ex, at, side="left"))
    lo = max(0, k - RECENT)
    nn = k - lo
    if nn < 5:
        return np.nan, np.nan, float(nn)
    return float(w[lo:k].mean()), float(r[lo:k].mean()), float(nn)


def _recent_arrays(trades, bars):
    """recent_stats for many signal candles at once."""
    if not trades:
        z = np.full(len(bars), np.nan)
        return z, z.copy(), np.zeros(len(bars))
    ex = np.array([t["exit_i"] for t in trades])
    order = np.argsort(ex, kind="stable")
    ex = ex[order]
    cw = np.r_[0.0, np.cumsum(np.array([t["win"] for t in trades], dtype=float)[order])]
    cr = np.r_[0.0, np.cumsum(np.array([t["r"] for t in trades], dtype=float)[order])]
    k = np.searchsorted(ex, np.asarray(bars), side="left")
    lo = np.maximum(0, k - RECENT)
    nn = (k - lo).astype(float)
    with np.errstate(invalid="ignore", divide="ignore"):
        wr = np.where(nn >= 5, (cw[k] - cw[lo]) / nn, np.nan)
        rr = np.where(nn >= 5, (cr[k] - cr[lo]) / nn, np.nan)
    return wr, rr, nn


def series_rows(df, tf, asset_class, sub, symbol, rng, cap_per_strategy, test_frac=0.3, all_cap=4000):
    """Trades of every strategy on one market and timeframe, with the features at each signal candle."""
    df = df if "atr" in df.columns else se.add_atr(df[["open", "high", "low", "close", "volume"]].astype(float).copy())
    htf = gm.htf_frames_from(df, tf, asset_class)
    F, _ = gm.raw_features(df, tf, asset_class, htf=htf)
    ctx = st.Ctx(df, tf, None, asset_class)
    cost, slip = gm.cost_of(sub)
    n = ctx.n
    split = int(n * (1 - test_frac))
    sid_series = f"{symbol}|{tf}"
    frames = []
    for sid in IDS:
        try:
            tr = strategy_trades(ctx, sid, cost, slip, cap=all_cap, rng=rng)
        except Exception:                                # one broken strategy must not stop the rest
            continue
        if not tr:
            continue
        T = pd.DataFrame(tr)
        T["recent_wr"], T["recent_r"], T["recent_n"] = _recent_arrays(tr, T["bar"].to_numpy())
        T = T[(T["bar"] >= split) | (T["exit_i"] < split)]          # purge: no training trade runs into the test
        if len(T) > cap_per_strategy:
            T = T.sample(cap_per_strategy, random_state=int(rng.integers(0, 2 ** 31 - 1))).sort_values("bar")
        T["sid"] = sid
        frames.append(T)
    if not frames:
        return None
    R = pd.concat(frames, ignore_index=True)
    al = gm.align(F.iloc[R["bar"].to_numpy()], R["side"].to_numpy()).reset_index(drop=True)
    R = pd.concat([R.reset_index(drop=True), al], axis=1)
    R["sid_code"] = R["sid"].map(SID_CODE).astype(float)
    R["group_code"] = R["sid"].map(lambda x: GROUP_CODE[_group_of(x)]).astype(float)
    R["test"] = R["bar"] >= split
    R["series"], R["symbol"], R["tf"], R["asset_class"] = sid_series, symbol, tf, asset_class
    R["tf_group"] = gm.TF_GROUP[tf]
    R["t"] = df.index[R["bar"].to_numpy()]
    return R


def build(series, budget=600_000, seed=2, log=print):
    """series: list of dict(symbol, tf, asset_class, sub, df). Returns one DataFrame of strategy trades."""
    rng = np.random.default_rng(seed)
    per_series = max(1000, int(budget / max(1, len(series))))
    cap = max(60, int(per_series / max(1, len(IDS) * 0.6)))
    out, t0 = [], time.time()
    for k, sr in enumerate(series):
        try:
            R = series_rows(sr["df"], sr["tf"], sr["asset_class"], sr["sub"], sr["symbol"], rng, cap)
        except Exception as e:
            log(f"  warning {sr['symbol']}|{sr['tf']}: {type(e).__name__}: {e}")
            continue
        if R is not None:
            out.append(R)
        log(f"  [{k + 1}/{len(series)}] {sr['symbol'] + '|' + sr['tf']:22s} {0 if R is None else len(R):>7,} trades "
            f"from {0 if R is None else R['sid'].nunique()} strategies ({time.time() - t0:.0f}s)")
    if not out:
        raise RuntimeError("No strategy trades: too little data.")
    D = pd.concat(out, ignore_index=True)
    return D.astype({c: np.float32 for c in COLS if D[c].dtype == np.float64})


# ───────────────────────────── model ─────────────────────────────
def _clf():
    from sklearn.ensemble import HistGradientBoostingClassifier
    return HistGradientBoostingClassifier(max_iter=400, learning_rate=0.06, max_leaf_nodes=31, min_samples_leaf=300,
                                          l2_regularization=1.0, early_stopping=True, validation_fraction=0.1,
                                          n_iter_no_change=20, random_state=0,
                                          categorical_features=[COLS.index(c) for c in CAT])


def _fit(X, y):
    m = _clf()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        m.fit(X[COLS].to_numpy(dtype=np.float32), np.asarray(y).astype(int))
    m.feature_names_ = list(COLS)
    return m


def _pp(m, X):
    return m.predict_proba(X[m.feature_names_].to_numpy(dtype=np.float32))[:, 1]


def payoff(D):
    """Average winning and losing R for each strategy (what a win and a loss are worth)."""
    out = {}
    for sid, g in D.groupby("sid"):
        w, l_ = g.loc[g["r"] > 0, "r"], g.loc[g["r"] <= 0, "r"]
        out[sid] = dict(win_r=float(w.mean()) if len(w) else 1.0, loss_r=float(-l_.mean()) if len(l_) else 1.0)
    return out


def ev_of(p, sid, pay):
    q = pay.get(sid, dict(win_r=1.0, loss_r=1.0))
    return p * q["win_r"] - (1 - p) * q["loss_r"]


def _t(x):
    x = np.asarray(x, dtype=float)
    if len(x) < 3 or x.std(ddof=1) == 0:
        return np.nan
    return float(x.mean() / x.std(ddof=1) * np.sqrt(len(x)))


def _blocks(D):
    return D["series"].astype(str).to_numpy() + "|" + (D["bar"].to_numpy() // 200).astype(str)


def evidence(D, keys):
    rows = []
    blk = _blocks(D)
    D = D.assign(_blk=blk)
    for k, g in D.groupby(keys):
        rows.append(dict(zip(keys, k if isinstance(k, tuple) else (k,)), trades=len(g), win_rate=float(g["win"].mean()),
                         avg_r=float(g["r"].mean()), total_r=float(g["r"].sum()),
                         t_stat=gm.block_t(g["r"], g["_blk"]) if len(g) > 30 else np.nan))
    return pd.DataFrame(rows)


def train(D, log=print):
    """Walk-forward test, the `use` gate, evidence tables, then the final model on everything."""
    t0 = time.time()
    D = D.assign(win=D["win"].astype(bool))
    tr, te = ~D["test"].to_numpy(), D["test"].to_numpy()
    Dtr, Dte = D[tr], D[te]
    card = dict(rows=dict(all=len(D), train=int(tr.sum()), test=int(te.sum()), strategies=int(D["sid"].nunique()),
                          series=int(D["series"].nunique())))
    log(f"Strategies: {len(D):,} trades of {card['rows']['strategies']} strategies on {card['rows']['series']} series "
        f"({te.sum():,} for testing)")
    m = _fit(Dtr, Dtr["win"])
    pay = payoff(Dtr)
    rate = Dtr.groupby(["sid", "tf_group"])["win"].mean()
    rate_sid = Dtr.groupby("sid")["win"].mean()
    p = _pp(m, Dte)
    y = Dte["win"].to_numpy(dtype=float)
    base = np.array([rate.get((s_, g_), rate_sid.get(s_, Dtr["win"].mean())) for s_, g_ in
                     zip(Dte["sid"], Dte["tf_group"])])
    ev = np.array([ev_of(pi, s_, pay) for pi, s_ in zip(p, Dte["sid"])])
    r = Dte["r"].to_numpy(dtype=float)
    blk = _blocks(Dte)
    sel = []
    q50, q75 = np.quantile(ev, 0.5), np.quantile(ev, 0.75)
    for name, mask in (("every signal", np.ones(len(Dte), bool)), ("model EV > 0", ev > 0),
                       ("top half by model", ev >= q50), ("top quarter by model", ev >= q75)):
        sel.append(dict(selection=name, trades=int(mask.sum()), win_rate=float(y[mask].mean()) if mask.any() else np.nan,
                        avg_net_R=float(r[mask].mean()) if mask.any() else np.nan,
                        t_stat=gm.block_t(r[mask], blk[mask]) if mask.sum() > 30 else np.nan))
    card["model"] = dict(auc_model=gm._auc(p, y), auc_rate=gm._auc(base, y), brier_model=gm._brier(p, y),
                         brier_rate=gm._brier(base, y), calibration=gm.calibration(p, y), selection=pd.DataFrame(sel))
    card["model"]["skill_vs_rate"] = 1 - card["model"]["brier_model"] / card["model"]["brier_rate"]
    per = []
    Dte_ = Dte.assign(p=p, ev=ev, _blk=blk)
    for sid, g in Dte_.groupby("sid"):
        top = g["ev"] >= g["ev"].median()
        per.append(dict(strategy=sid, name=st.BY_ID[sid]["name"], group=_group_of(sid), trades=len(g),
                        win_rate=float(g["win"].mean()), avg_r=float(g["r"].mean()),
                        t_stat=gm.block_t(g["r"], g["_blk"]) if len(g) > 30 else np.nan,
                        auc=gm._auc(g["p"], g["win"].astype(float)) if g["win"].nunique() > 1 else np.nan,
                        top_half_avg_r=float(g.loc[top, "r"].mean()) if top.any() else np.nan))
    card["per_strategy_test"] = pd.DataFrame(per).sort_values("avg_r", ascending=False).reset_index(drop=True)
    use = bool(card["model"]["auc_model"] > max(0.52, card["model"]["auc_rate"]) and card["model"]["skill_vs_rate"] > 0)
    card["use"] = dict(odds=use)
    log(f"  AUC {card['model']['auc_model']:.3f} (strategy rate alone {card['model']['auc_rate']:.3f}), Brier skill "
        f"{card['model']['skill_vs_rate']:+.3f} | the app will {'use' if use else 'NOT use'} the per-signal odds")
    # evidence on all data: what works where
    ev_class = evidence(D, ["sid", "asset_class", "tf_group"])
    ev_market = evidence(D, ["sid", "symbol", "tf"])
    m_all = _fit(D, D["win"])
    card["seconds"] = round(time.time() - t0, 1)
    return dict(version=VERSION, created=str(pd.Timestamp.now(tz="UTC")), model=m_all, cols=COLS, ids=IDS,
                card=card, use=dict(odds=use), payoff=payoff(D), evidence_class=ev_class, evidence_market=ev_market)


# ───────────────────────────── live ─────────────────────────────
def _live_recent(ctx, sid, cost, slip):
    def f():
        tr = strategy_trades(ctx, sid, cost, slip, cap=1500)
        return recent_stats(tr, ctx.n)
    return ctx.get(("head_recent", sid, round(cost, 8)), f)


def score(head, ctx, row, sid, d, entry, sl, tp, cost=0.0, slip=0.0):
    """The head's view of one live signal: P(profit), the expected R from it, and the win rate it needs.
    None when there is no head, the strategy is unknown to it, or its odds aren't used."""
    if not head or sid not in SID_CODE or not head.get("use", {}).get("odds"):
        return None
    s = st.BY_ID[sid]
    i = ctx.n - 1
    a = float(ctx.atr[i])
    if not np.isfinite(a) or a <= 0:
        return None
    if s["fixed_time"]:
        geo = dict(b_atr=0.0, a_atr=0.0, log_rr=0.0, guarded=0.0, is_ft=1.0, expiry=float(s["expiry"]))
    else:
        b, aa = abs(entry - sl) / a, abs(tp - entry) / a
        if b <= 0 or aa <= 0:
            return None
        geo = dict(b_atr=b, a_atr=aa, log_rr=math.log(aa / b), guarded=0.0, is_ft=0.0, expiry=0.0)
    wr, rr, nn = _live_recent(ctx, sid, cost, slip)
    X = gm.align_row(row, [float(d)]).assign(**geo, recent_wr=wr, recent_r=rr, recent_n=nn,
                                              sid_code=float(SID_CODE[sid]),
                                              group_code=float(GROUP_CODE[s["group"]]))
    p = float(_pp(head["model"], X)[0])
    pay = head["payoff"].get(sid, dict(win_r=1.0, loss_r=1.0))
    need = pay["loss_r"] / (pay["win_r"] + pay["loss_r"]) if (pay["win_r"] + pay["loss_r"]) > 0 else 0.5
    return dict(p_win=p, ev=float(ev_of(p, sid, head["payoff"])), needed=float(need))


def evidence_for(head, sid, asset_class, tf):
    """The strategy's history on this kind of market and timeframe group (all data), or None."""
    if not head:
        return None
    E = head.get("evidence_class")
    if E is None or not len(E):
        return None
    g = E[(E["sid"] == sid) & (E["asset_class"] == asset_class) & (E["tf_group"] == gm.TF_GROUP.get(tf, ""))]
    if not len(g):
        return None
    r = g.iloc[0]
    return dict(trades=int(r["trades"]), win_rate=float(r["win_rate"]), avg_r=float(r["avg_r"]),
                t_stat=None if pd.isna(r["t_stat"]) else float(r["t_stat"]))


def best_for(head, symbol=None, tf=None, k=5, min_trades=40):
    """Strategies that did best on this market and timeframe in the training history (after costs)."""
    if not head:
        return []
    E = head.get("evidence_market")
    if E is None or not len(E):
        return []
    g = E[(E["symbol"] == symbol) & (E["tf"] == tf) & (E["trades"] >= min_trades)]
    g = g.sort_values("avg_r", ascending=False).head(k)
    return [dict(id=r["sid"], name=st.BY_ID[r["sid"]]["name"] if r["sid"] in st.BY_ID else r["sid"],
                 trades=int(r["trades"]), win_rate=float(r["win_rate"]), avg_r=float(r["avg_r"]),
                 t_stat=None if pd.isna(r["t_stat"]) else float(r["t_stat"])) for _, r in g.iterrows()]

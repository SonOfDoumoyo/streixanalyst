"""liquidity_head.py: the analyst's experience of liquidity, learned from years of candles on many markets.

Stops sit just past obvious highs and lows, and price often runs those stops before it moves. This head learns, for
every pool of liquidity near price, three things that decide where a trade goes in and where its stop goes:

  * sweep     P(price trades through the pool within the next 24 candles)
  * reverse   given it does: P(the sweep closes back inside within 3 candles and then runs 1 ATR the other way
              before closing beyond the pool again), i.e. a stop hunt that turns, not a breakout
  * depth     how far past the pool such a hunt reaches (the 80th percentile, in ATR), for this pool, on this market,
              in this context: a stop placed beyond that is past where hunts usually finish

Pools are the ones a trader marks: untaken swing highs and lows (equal highs/lows flagged), the previous New York
day's high and low (intraday charts) and the Asian range high and low (1h and below). Everything is point-in-time:
a pool is only used once it was known, and only while no candle had traded through it.

Each model is checked on the last 30% of every series (never seen in training) against a simple baseline: the
distance alone for sweeps, the historical rate for reversals, and the chart's own 80th percentile (what the app used
before) for depth. The app uses a model only if it beats its baseline there (the `use` flags).

Research tool, not financial advice."""
import math
import time
import warnings

import numpy as np
import pandas as pd

import guru_model as gm
import market_data as md
import strategies as st
import structure_engine as se

VERSION = "1.0"
H = 24                  # candles ahead: is the pool taken within this many?
BACK = 3                # a hunt closes back inside within this many candles of first trading through
MOVE = 1.0              # ATR: a reversal runs this far back the other way before a close beyond the pool again
MAX_D = 8.0             # pools further than this (ATR) are left out
PER_SIDE = 3            # nearest pools per side
LOOK = 150              # swings older than this many candles are left out (the app's guard uses the same)
DEPTH_Q = 0.8           # the depth quantile the stop buffer is built from
TYPES = ("swing", "pdhl", "asia")

POOL_COLS = ["d_atr", "log_age", "is_equal", "n_equal", "n_tests", "rank", "opp_d_atr", "typ_pdhl", "typ_asia"]
COLS = POOL_COLS + gm.ALIGNED
BASE_COLS = ["d_atr", "tf_log"] + gm.CLASS_COLS


# ───────────────────────────── pools (point-in-time) ─────────────────────────────
def session_levels(ctx, tf):
    """For every candle: the previous New York day's high and low (charts below 1D) and the Asian range high and low
    (1h and below), the candle each became known, and whether price had already traded through it since."""
    n = ctx.n
    nan = np.full(n, np.nan)
    out = dict(pdh=nan.copy(), pdl=nan.copy(), asia_hi=nan.copy(), asia_lo=nan.copy(), day_start=np.zeros(n, int))
    if md.TF_MIN[tf] >= 1440:
        return out
    day = ctx.ny_day
    new = np.r_[True, day[1:] != day[:-1]]
    starts = np.flatnonzero(new)
    ds = np.repeat(starts, np.diff(np.r_[starts, n]))
    out["day_start"] = ds
    # previous day's high / low, known from the first candle of the next day
    dh = pd.Series(ctx.h).groupby(day).transform("max").to_numpy()
    dl = pd.Series(ctx.l).groupby(day).transform("min").to_numpy()
    prev_h, prev_l = np.full(n, np.nan), np.full(n, np.nan)
    for k in range(1, len(starts)):
        a, b = starts[k], (starts[k + 1] if k + 1 < len(starts) else n)
        prev_h[a:b], prev_l[a:b] = dh[starts[k - 1]], dl[starts[k - 1]]
    out["pdh"], out["pdl"] = prev_h, prev_l
    if md.TF_MIN[tf] <= 60:
        out["asia_hi"], out["asia_lo"] = ctx.asia()
    out["day_hi"] = pd.Series(ctx.h).groupby(day).cummax().to_numpy()      # running high / low since the day began
    out["day_lo"] = pd.Series(ctx.l).groupby(day).cummin().to_numpy()
    return out


def pools_at(ctx, S, i, price, a):
    """The untaken pools around candle i: list of dicts (price, side +1 above / -1 below, type, known_from, ...)."""
    T = ctx.pool_table()
    out = []
    if len(T["side"]):
        m = (T["conf"] <= i) & (T["idx"] >= max(0, i - LOOK)) & (T["taken"] > i)
        for k in np.flatnonzero(m):
            q, sd = float(T["price"][k]), int(T["side"][k])
            if sd * (q - price) <= 0:
                continue
            out.append(dict(price=q, side=sd, type="swing", known=int(T["idx"][k])))
    if S.get("day_hi") is not None:
        ds = int(S["day_start"][i])
        for key, sd, typ in (("pdh", 1, "pdhl"), ("pdl", -1, "pdhl"), ("asia_hi", 1, "asia"), ("asia_lo", -1, "asia")):
            q = S[key][i]
            if not np.isfinite(q) or sd * (q - price) <= 0:
                continue
            ran = S["day_hi"][i] if sd == 1 else S["day_lo"][i]
            if sd * (ran - q) > 0:                       # already traded through today
                continue
            out.append(dict(price=float(q), side=sd, type=typ, known=ds))
    return out


def _features(ctx, pools, i, price, a):
    """The pool features for the nearest PER_SIDE pools on each side (within MAX_D ATR)."""
    rows = []
    near = {1: [], -1: []}
    for p in pools:
        p["d_atr"] = p["side"] * (p["price"] - price) / a
        if 0 < p["d_atr"] <= MAX_D:
            near[p["side"]].append(p)
    best = {sd: min((p["d_atr"] for p in near[sd]), default=MAX_D + 2) for sd in (1, -1)}
    swings = {sd: np.array([p["price"] for p in near[sd] if p["type"] == "swing"]) for sd in (1, -1)}
    for sd in (1, -1):
        lst = sorted(near[sd], key=lambda p: p["d_atr"])[:PER_SIDE]
        for rank, p in enumerate(lst):
            sw = swings[sd]
            n_eq = int((np.abs(sw - p["price"]) <= 0.15 * a).sum()) - (1 if p["type"] == "swing" else 0) if len(sw) else 0
            lo = max(p["known"] + 1, i - LOOK)
            seg = ctx.h[lo:i + 1] if sd == 1 else ctx.l[lo:i + 1]
            tests = int((sd * (seg - p["price"]) >= -0.15 * a).sum()) if len(seg) else 0
            rows.append(dict(p, d_atr=float(p["d_atr"]), log_age=math.log1p(max(0, i - p["known"])),
                             is_equal=float(n_eq > 0), n_equal=float(n_eq), n_tests=float(tests), rank=float(rank),
                             opp_d_atr=float(min(best[-sd], MAX_D + 2)), typ_pdhl=float(p["type"] == "pdhl"),
                             typ_asia=float(p["type"] == "asia")))
    return rows


def _outcome(ctx, i, q, sd, a):
    """What happened to a pool after candle i: swept within H candles, then a reversal or not, and the hunt's depth."""
    n = ctx.n
    h, l, c = ctx.h, ctx.l, ctx.c
    seg = h[i + 1:i + 1 + H] if sd == 1 else l[i + 1:i + 1 + H]
    hit = np.flatnonzero(seg > q) if sd == 1 else np.flatnonzero(seg < q)
    if not len(hit):
        return 0, np.nan, np.nan
    j = i + 1 + int(hit[0])
    back = None
    for k in range(j, min(n, j + BACK)):
        if sd * (c[k] - q) <= 0:
            back = k
            break
    if back is None:
        return 1, 0.0, np.nan                            # a breakout: it held beyond the pool
    ext = (h[j:back + 1].max() - q) if sd == 1 else (q - l[j:back + 1].min())
    depth = float(ext / a)
    goal = q - sd * MOVE * a
    rev = 0.0
    for k in range(back + 1, min(n, back + 1 + H)):
        if (sd == 1 and l[k] <= goal) or (sd == -1 and h[k] >= goal):
            rev = 1.0
            break
        if sd * (c[k] - q) > 0:                          # closed beyond the pool again: the hunt became a breakout
            break
    return 1, rev, depth


# ───────────────────────────── training data ─────────────────────────────
def series_rows(df, tf, asset_class, sid, rng, cap, test_frac=0.3):
    """Pool rows (features + labels) for one market and timeframe."""
    df = df if "atr" in df.columns else se.add_atr(df[["open", "high", "low", "close", "volume"]].astype(float).copy())
    htf = gm.htf_frames_from(df, tf, asset_class)
    F, _ = gm.raw_features(df, tf, asset_class, htf=htf)
    ctx = st.Ctx(df, tf, None, asset_class)
    S = session_levels(ctx, tf)
    n = ctx.n
    lo, hi = min(gm.WARMUP, max(150, n // 5)), n - H - BACK - 2
    if hi - lo < 200:
        return None
    split = int(n * (1 - test_frac))
    stride = max(1, int(math.ceil((hi - lo) * 4 / max(cap, 1))))
    bars = np.arange(lo + int(rng.integers(0, stride)), hi, stride)
    bars = bars[(bars >= split) | (bars < split - H - BACK - H)]          # purge: no label crosses the split
    rows = []
    for i in bars:
        a = ctx.atr[i]
        if not np.isfinite(a) or a <= 0:
            continue
        price = float(ctx.c[i])
        for p in _features(ctx, pools_at(ctx, S, i, price, a), i, price, a):
            y, rev, depth = _outcome(ctx, i, p["price"], p["side"], a)
            rows.append(dict({k: p[k] for k in POOL_COLS}, side=p["side"], type=p["type"], bar=int(i), y_sweep=y,
                             y_rev=rev, depth=depth))
    if not rows:
        return None
    R = pd.DataFrame(rows)
    al = gm.align(F.iloc[R["bar"].to_numpy()], R["side"].to_numpy()).reset_index(drop=True)
    R = pd.concat([R.reset_index(drop=True), al], axis=1)
    R["test"] = R["bar"] >= split
    R["sid"], R["tf"], R["asset_class"] = sid, tf, asset_class
    R["tf_group"] = gm.TF_GROUP[tf]
    return R


def build(series, budget=300_000, seed=1, log=print):
    """series: list of dict(symbol, tf, asset_class, df). Returns one DataFrame of pool rows."""
    rng = np.random.default_rng(seed)
    cap = max(500, int(budget / max(1, len(series))))
    out, t0 = [], time.time()
    for k, sr in enumerate(series):
        sid = f"{sr['symbol']}|{sr['tf']}"
        try:
            R = series_rows(sr["df"], sr["tf"], sr["asset_class"], sid, rng, cap)
        except Exception as e:                                   # one bad series must not stop training
            log(f"  warning {sid}: {type(e).__name__}: {e}")
            continue
        if R is not None:
            out.append(R)
        log(f"  [{k + 1}/{len(series)}] {sid:22s} {0 if R is None else len(R):>7,} pool rows ({time.time() - t0:.0f}s)")
    if not out:
        raise RuntimeError("No liquidity rows: too little data.")
    D = pd.concat(out, ignore_index=True)
    return D.astype({c: np.float32 for c in COLS if D[c].dtype == np.float64})


# ───────────────────────────── models ─────────────────────────────
def _clf(cols, mono=None):
    from sklearn.ensemble import HistGradientBoostingClassifier
    return HistGradientBoostingClassifier(max_iter=300, learning_rate=0.08, max_leaf_nodes=31, min_samples_leaf=300,
                                          l2_regularization=1.0, early_stopping=True, validation_fraction=0.1,
                                          n_iter_no_change=15, random_state=0,
                                          monotonic_cst=[int((mono or {}).get(c, 0)) for c in cols])


def _reg(q):
    from sklearn.ensemble import HistGradientBoostingRegressor
    return HistGradientBoostingRegressor(loss="quantile", quantile=q, max_iter=250, learning_rate=0.06,
                                         max_leaf_nodes=31, min_samples_leaf=200, l2_regularization=1.0,
                                         early_stopping=True, validation_fraction=0.1, n_iter_no_change=15,
                                         random_state=0)


def _fit(model, X, y, cols):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        model.fit(X[cols].to_numpy(dtype=np.float32), np.asarray(y))
    model.feature_names_ = list(cols)
    return model


def _pp(m, X):
    return m.predict_proba(X[m.feature_names_].to_numpy(dtype=np.float32))[:, 1]


def _pr(m, X):
    return m.predict(X[m.feature_names_].to_numpy(dtype=np.float32))


def _chart_depth(d):
    """The app's old rule, per series: the 80th percentile of past hunts' depth (0.35 ATR with fewer than 8)."""
    d = d.dropna()
    return 0.35 if len(d) < 8 else float(np.clip(np.percentile(d, 80), 0.12, 1.5))


def train(D, log=print):
    """Walk-forward test (first 70% of every series trains, last 30% tests), the `use` gates, then final models."""
    t0 = time.time()
    tr, te = ~D["test"].to_numpy(), D["test"].to_numpy()
    Dtr, Dte = D[tr], D[te]
    card = dict(rows=dict(all=len(D), train=int(tr.sum()), test=int(te.sum()),
                          swept=int((D["y_sweep"] == 1).sum()), hunts=int(D["depth"].notna().sum()),
                          series=int(D["sid"].nunique())))
    log(f"Liquidity: {len(D):,} pool rows from {card['rows']['series']} series ({te.sum():,} for testing)")
    # sweep
    m_sw = _fit(_clf(COLS, {"d_atr": -1}), Dtr, Dtr["y_sweep"].astype(int), COLS)
    m_b = _fit(_clf(BASE_COLS, {"d_atr": -1}), Dtr, Dtr["y_sweep"].astype(int), BASE_COLS)
    y = Dte["y_sweep"].to_numpy(dtype=float)
    p, pb_ = _pp(m_sw, Dte), _pp(m_b, Dte)
    sweep = dict(rate_test=float(y.mean()), brier_model=gm._brier(p, y), brier_distance_only=gm._brier(pb_, y),
                 auc_model=gm._auc(p, y), auc_distance_only=gm._auc(pb_, y), calibration=gm.calibration(p, y))
    sweep["skill_vs_distance"] = 1 - sweep["brier_model"] / sweep["brier_distance_only"]
    by = []
    for typ, g in Dte.assign(p=p, pb=pb_).groupby("type"):
        yy = g["y_sweep"].astype(float)
        by.append(dict(type=typ, rows=len(g), rate=float(yy.mean()), auc=gm._auc(g["p"], yy),
                       skill_vs_distance=1 - gm._brier(g["p"], yy) / gm._brier(g["pb"], yy)))
    sweep["by_type"] = pd.DataFrame(by)
    card["sweep"] = sweep
    # reversal after a sweep
    S_tr, S_te = Dtr[Dtr["y_sweep"] == 1], Dte[Dte["y_sweep"] == 1]
    rev = dict(rows_train=len(S_tr), rows_test=len(S_te))
    m_rv = None
    if len(S_tr) >= 500 and len(S_te) >= 200:
        m_rv = _fit(_clf(COLS), S_tr, S_tr["y_rev"].astype(int), COLS)
        rate = S_tr.groupby(["type", "tf_group"])["y_rev"].mean()
        yr = S_te["y_rev"].to_numpy(dtype=float)
        pr = _pp(m_rv, S_te)
        base = np.array([rate.get((a_, b_), S_tr["y_rev"].mean()) for a_, b_ in zip(S_te["type"], S_te["tf_group"])])
        rev.update(rate_test=float(yr.mean()), brier_model=gm._brier(pr, yr), brier_rate=gm._brier(base, yr),
                   auc_model=gm._auc(pr, yr), calibration=gm.calibration(pr, yr))
        rev["skill_vs_rate"] = 1 - rev["brier_model"] / rev["brier_rate"]
        top = pr >= np.quantile(pr, 0.75)
        rev["top_quarter_rate"] = float(yr[top].mean())
    card["reverse"] = rev
    # depth of hunts (the stop buffer)
    H_tr, H_te = S_tr[S_tr["depth"].notna()], S_te[S_te["depth"].notna()]
    dep = dict(rows_train=len(H_tr), rows_test=len(H_te), quantile=DEPTH_Q)
    m_dp, shift = None, 0.0
    if len(H_tr) >= 500 and len(H_te) >= 200:
        # fit on the earlier 80% of the training hunts, then shift the line so 80% of the later 20% fall under it
        # (a calibrated buffer); then judge it on the test period against the chart rule
        late = (H_tr.groupby("sid")["bar"].rank(pct=True) > 0.8).to_numpy()
        m_cal = _fit(_reg(DEPTH_Q), H_tr[~late], H_tr["depth"][~late].astype(float), COLS)
        res = H_tr["depth"][late].to_numpy(dtype=float) - _pr(m_cal, H_tr[late])
        shift = float(np.quantile(res, DEPTH_Q)) if late.sum() >= 50 else 0.0
        m_dp = _fit(_reg(DEPTH_Q), H_tr, H_tr["depth"].astype(float), COLS)
        pd_ = np.clip(_pr(m_dp, H_te) + shift, 0.12, 1.5)
        chart = H_tr.groupby("sid")["depth"].apply(_chart_depth)
        cb = np.array([chart.get(s_, 0.35) for s_ in H_te["sid"]])
        yd = H_te["depth"].to_numpy(dtype=float)
        dep.update(coverage_model=float((yd <= pd_).mean()), width_model=float(pd_.mean()),
                   coverage_chart_rule=float((yd <= cb).mean()), width_chart_rule=float(cb.mean()),
                   median_depth=float(np.median(yd)), shift=shift)
    card["depth"] = dep
    # which parts the app should use: only what beat its baseline on data it never saw
    use = dict(
        sweep=bool(sweep["skill_vs_distance"] > 0.005 and sweep["auc_model"] > sweep["auc_distance_only"]),
        reverse=bool(m_rv is not None and rev.get("skill_vs_rate", 0) > 0.0 and rev.get("auc_model", 0) > 0.53),
        depth=bool(m_dp is not None and (
            abs(dep["coverage_model"] - DEPTH_Q) <= 0.03 and dep["width_model"] < dep["width_chart_rule"]
            or dep["coverage_model"] >= dep["coverage_chart_rule"] + 0.03
            and dep["width_model"] <= dep["width_chart_rule"] * 1.1)))
    card["use"] = use
    log(f"  sweep AUC {sweep['auc_model']:.3f} (distance only {sweep['auc_distance_only']:.3f}), skill "
        f"{sweep['skill_vs_distance']:+.3f} | reversal AUC {rev.get('auc_model', float('nan')):.3f} | depth coverage "
        f"{dep.get('coverage_model', float('nan')):.2f} at {dep.get('width_model', float('nan')):.2f} ATR vs chart rule "
        f"{dep.get('coverage_chart_rule', float('nan')):.2f} at {dep.get('width_chart_rule', float('nan')):.2f} ATR")
    log(f"  the app will use: {', '.join(k for k, v in use.items() if v) or 'none of the models (tables only)'}")
    # experience table, all data
    Sw = D[D["y_sweep"] == 1]
    tab = (D.groupby(["asset_class", "tf_group", "type"]).agg(pools=("y_sweep", "size"), p_sweep=("y_sweep", "mean"))
           .reset_index())
    if len(Sw):
        t2 = Sw.groupby(["asset_class", "tf_group", "type"]).agg(
            sweeps=("y_rev", "size"), p_reverse=("y_rev", "mean"),
            depth_q50=("depth", lambda x: float(np.nanquantile(x, 0.5)) if x.notna().any() else np.nan),
            depth_q80=("depth", lambda x: float(np.nanquantile(x, 0.8)) if x.notna().any() else np.nan),
            depth_q90=("depth", lambda x: float(np.nanquantile(x, 0.9)) if x.notna().any() else np.nan)).reset_index()
        tab = tab.merge(t2, on=["asset_class", "tf_group", "type"], how="left")
    # final models on everything
    models = dict(sweep=_fit(_clf(COLS, {"d_atr": -1}), D, D["y_sweep"].astype(int), COLS))
    Sall = D[D["y_sweep"] == 1]
    if m_rv is not None:
        models["reverse"] = _fit(_clf(COLS), Sall, Sall["y_rev"].astype(int), COLS)
    Hall = Sall[Sall["depth"].notna()]
    if m_dp is not None:
        models["depth"] = _fit(_reg(DEPTH_Q), Hall, Hall["depth"].astype(float), COLS)
    card["seconds"] = round(time.time() - t0, 1)
    return dict(version=VERSION, created=str(pd.Timestamp.now(tz="UTC")), models=models, cols=COLS, card=card,
                use=use, table=tab, depth_shift=shift,
                params=dict(H=H, BACK=BACK, MOVE=MOVE, MAX_D=MAX_D, LOOK=LOOK, DEPTH_Q=DEPTH_Q))


# ───────────────────────────── live ─────────────────────────────
def assess(head, ctx, row, tf, price=None):
    """The pools around the newest candle with the head's numbers. Returns a list of dicts sorted by distance:
    price, side (+1 above / -1 below), type, d_atr, p_sweep, p_reverse, depth_atr (each None when the head isn't
    used for it). None when there is no head."""
    if not head:
        return None
    i = ctx.n - 1
    a = float(ctx.atr[i])
    if not np.isfinite(a) or a <= 0:
        return None
    price = float(ctx.c[i] if price is None else price)
    S = session_levels(ctx, tf)
    rows = _features(ctx, pools_at(ctx, S, i, price, a), i, price, a)
    if not rows:
        return []
    R = pd.DataFrame(rows)
    al = gm.align_row(row, R["side"].to_numpy(dtype=float))
    X = pd.concat([R[POOL_COLS].reset_index(drop=True), al], axis=1)
    use, m = head.get("use", {}), head["models"]
    p_sw = _pp(m["sweep"], X) if use.get("sweep") and "sweep" in m else None
    p_rv = _pp(m["reverse"], X) if use.get("reverse") and "reverse" in m else None
    dp = np.clip(_pr(m["depth"], X) + head.get("depth_shift", 0.0), 0.12, 1.5) \
        if use.get("depth") and "depth" in m else None
    out = []
    for k, r in enumerate(rows):
        out.append(dict(price=float(r["price"]), side=int(r["side"]), type=r["type"], d_atr=float(r["d_atr"]),
                        equal=bool(r["is_equal"]), tests=int(r["n_tests"]),
                        p_sweep=None if p_sw is None else float(p_sw[k]),
                        p_reverse=None if p_rv is None else float(p_rv[k]),
                        depth_atr=None if dp is None else float(dp[k])))
    out.sort(key=lambda r: r["d_atr"])
    return out


def type_word(r):
    return {"pdhl": ("previous day high" if r["side"] == 1 else "previous day low"),
            "asia": ("Asian range high" if r["side"] == 1 else "Asian range low")}.get(
        r["type"], ("equal highs" if r["side"] == 1 else "equal lows") if r.get("equal") else
        ("swing high" if r["side"] == 1 else "swing low"))

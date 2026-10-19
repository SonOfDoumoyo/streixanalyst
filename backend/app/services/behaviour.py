"""The behaviour model: how a person's calls turn out, given the feeling they named and how they made the call.

Trained on the decisions export (admin: /admin/learning/export?dataset=decisions, a JSON Lines file). It is a logistic
regression written in numpy and saved as JSON, so loading a model never runs code. The joblib brain for the market
model is different: joblib can run code, so only files you trained yourself should ever be loaded.

A model only ships when it beats a baseline on calls it has not seen: the last 30% of the settled calls, in the order
they were made. Until it ships, `predict` returns None and nothing is shown to anyone.

Run it on an export:
    python -m app.services.behaviour streix-decisions.jsonl --out models/behaviour.json
"""
import argparse
import json
import math
from datetime import datetime, timezone

import numpy as np

from .psychology import EMOTIONS

VERSION = 1
MIN_CALLS = 200       # settled calls needed before a model is fitted and checked
MIN_TEST = 60         # the most recent calls held back for the check, never fewer
TEST_SHARE = 0.3      # ...or this share of all settled calls, whichever is more
MIN_GROUP = 20        # held-out calls for one feeling before its line is reported
BEAT = 0.99           # the model's log loss must be below this share of the baseline's to ship
L2 = 1.0              # penalty on the weights (not the intercept), so small samples do not swing
CAP_STREAK = 5        # losing streaks count up to this many
FEATURES = (["intercept", "chased", "quick_after_loss", "streak", "log_rr"]
            + [f"feel_{k}" for k in EMOTIONS])          # no feeling named is the baseline (all zeros)


def _scorable(d):
    """The call's levels and direction are known, so its planned reward:risk can be worked out."""
    try:
        entry, sl, tp = float(d["entry"]), float(d["sl"]), float(d["tp"])
    except (KeyError, TypeError, ValueError):
        return False
    return d.get("side") in ("long", "short") and entry > 0 and abs(entry - sl) > 0 and abs(tp - entry) > 0


def _usable(d):
    """A settled call that can be scored. Calls still open, or with no levels, are left out of the fit."""
    return _scorable(d) and d.get("settled") is True and isinstance(d.get("r"), (int, float))


def _win(d):
    return 1.0 if d["r"] > 0 else 0.0


def _x(d):
    """One call as numbers. Only what was true before the call was made: the fill, the losing streak going in, the
    planned reward:risk and the feeling named."""
    rr = abs(float(d["tp"]) - float(d["entry"])) / abs(float(d["entry"]) - float(d["sl"]))
    feel = d.get("emotion")
    return ([1.0,
             1.0 if d.get("chased") else 0.0,
             1.0 if d.get("quick_after_loss") else 0.0,
             min(int(d.get("streak_before") or 0), CAP_STREAK) / CAP_STREAK,
             math.log(rr)]
            + [1.0 if feel == k else 0.0 for k in EMOTIONS])


def _sig(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35.0, 35.0)))


def _ll(p, y):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def _fit(X, y):
    """Newton's method for L2-penalised logistic regression. The intercept is not penalised."""
    k = X.shape[1]
    pen = np.eye(k) * L2
    pen[0, 0] = 0.0
    w = np.zeros(k)
    for _ in range(100):
        p = _sig(X @ w)
        g = X.T @ (p - y) + pen @ w
        H = (X * (p * (1 - p))[:, None]).T @ X + pen + 1e-9 * np.eye(k)
        step = np.linalg.solve(H, g)
        w = w - step
        if np.max(np.abs(step)) < 1e-9:
            break
    return w


def train(decisions):
    """Fit and check the model on a list of decision dicts (the export's rows). Returns a JSON-safe dict. The model's
    `ship` flag is False unless it beats the baseline on the held-back calls."""
    rows = sorted((d for d in decisions if _usable(d)), key=lambda d: (d.get("decided_at") or "", d.get("id") or 0))
    n = len(rows)
    base = dict(version=VERSION, created=datetime.now(timezone.utc).isoformat(), features=FEATURES, settled=n)
    if n < MIN_CALLS:
        return dict(base, ship=False, weights=None,
                    reason=f"{n} settled calls so far. {MIN_CALLS} are needed before the model is fitted and checked.")
    cut = n - max(MIN_TEST, round(n * TEST_SHARE))
    tr, te = rows[:cut], rows[cut:]
    Xtr, ytr = np.array([_x(d) for d in tr]), np.array([_win(d) for d in tr])
    Xte, yte = np.array([_x(d) for d in te]), np.array([_win(d) for d in te])
    w = _fit(Xtr, ytr)
    p_te = _sig(Xte @ w)
    ll_model = _ll(p_te, yte)
    ll_base = _ll(np.full(len(yte), ytr.mean()), yte)
    ship = ll_model < BEAT * ll_base
    by_feeling = []
    for k in list(EMOTIONS) + ["none"]:
        idx = [i for i, d in enumerate(te) if (d.get("emotion") if d.get("emotion") in EMOTIONS else "none") == k]
        if len(idx) >= MIN_GROUP:
            by_feeling.append(dict(feeling=k, calls=len(idx), win_rate=round(float(yte[idx].mean()), 3),
                                   predicted=round(float(p_te[idx].mean()), 3)))
    reason = ("The model beat the baseline on the held-back calls, so it is in use."
              if ship else "The model did not beat the baseline on the held-back calls, so it is not used.")
    return dict(base, ship=bool(ship), reason=reason,
                weights=[round(float(v), 6) for v in w],
                card=dict(train_calls=len(tr), test_calls=len(te), baseline_win_rate=round(float(ytr.mean()), 3),
                          log_loss_model=round(ll_model, 5), log_loss_baseline=round(ll_base, 5),
                          improvement=round(1 - ll_model / ll_base, 4),
                          odds={f: round(float(math.exp(v)), 3) for f, v in zip(FEATURES, w)},
                          by_feeling=by_feeling))


def predict(model, d):
    """Chance this call wins, from a model that shipped. None when there is no shipped model, the model was made by a
    different version, or the call has no levels to score."""
    if not model or not model.get("ship") or model.get("features") != FEATURES or not _scorable(d):
        return None
    return float(_sig(np.array(_x(d)) @ np.array(model["weights"])))


def save(model, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(model, f, indent=2)


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _read_export(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def main(argv=None):
    ap = argparse.ArgumentParser(description="Train the behaviour model from a decisions export (JSON Lines).")
    ap.add_argument("export", help="the file from /admin/learning/export?dataset=decisions")
    ap.add_argument("--out", required=True, help="where to save the model, e.g. models/behaviour.json")
    a = ap.parse_args(argv)
    model = train(_read_export(a.export))
    save(model, a.out)
    print(f"{model['settled']} settled calls. {model['reason']}")
    if model.get("card"):
        c = model["card"]
        print(f"held-back calls: {c['test_calls']}, log loss {c['log_loss_model']} vs baseline {c['log_loss_baseline']}"
              f" ({c['improvement']:+.1%})")
    print(f"saved to {a.out}")


if __name__ == "__main__":
    main()

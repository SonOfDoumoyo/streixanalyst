"""The person's saved choices that the server needs too (the web app keeps them in the settings blob).

Entry, stop loss and take profit: off by default. The person turns them on for one pair at a time (settings.analysis
.levelsPairs) or for every pair (settings.analysis.levelsAll). With them off, the analyst gives its reading only."""
import re

from .models import jload


def pair_key(symbol):
    """One spelling per pair: 'OANDA:EUR/USD', 'eurusd' and 'EURUSD' are the same pair."""
    s = str(symbol or "").upper().strip().split(":")[-1]
    return re.sub(r"[^A-Z0-9.!_]", "", s)


def analysis_settings(user):
    blob = jload(getattr(user, "settings_json", None), {}) or {}
    a = blob.get("analysis") if isinstance(blob, dict) else None
    return a if isinstance(a, dict) else {}


def levels_on(user, symbol):
    """Does this person want entry, stop and targets on this pair?"""
    if user is None:
        return False
    a = analysis_settings(user)
    if a.get("levelsAll") is True:
        return True
    pairs = a.get("levelsPairs") or []
    if not isinstance(pairs, list):
        return False
    key = pair_key(symbol)
    return any(pair_key(p) == key for p in pairs if isinstance(p, str))

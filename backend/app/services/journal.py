"""The analyst's journal: every call it made, once settled, written as one line of JSON to a file kept for retraining.

The database already holds every analysis (analysis_logs). This file is the training copy: each settled call with its
levels, the analysis it came from, its result, and how it travelled (the worst and best it went, and whether a stopped
call was swept: stop taken, then the move happened). Live calls and replay calls both go in, so a replay you run and
check becomes a lesson too.

Only calls from accounts that agreed to "learn from my charts" are written, the same rule as the admin exports.
The file lives at DATA_DIR/learning/journal.jsonl; the admin console downloads it (Learning → Journal)."""
import json
import logging
import threading

from ..config import settings
from ..models import User, iso, jload

log = logging.getLogger("streix.journal")
_lock = threading.Lock()


def path():
    return settings.data_dir / "learning" / "journal.jsonl"


def row_record(r):
    """One settled call as a training record (no account details: the user is not named)."""
    return dict(id=r.id, kind=r.kind, created_at=iso(r.created_at), symbol=r.symbol, tf=r.tf, side=r.side,
                type=r.plan_type, called=r.called, grade=r.grade, entry=r.entry, sl=r.sl, tp=r.tp, p_tp=r.p_tp,
                outcome=r.outcome, r=r.outcome_r, filled_at=iso(r.filled_at), outcome_at=iso(r.outcome_at),
                exit=r.exit_price, mae_r=r.mae_r, mfe_r=r.mfe_r, swept=r.swept, sweep_depth_r=r.sweep_depth_r,
                analysis=jload(r.summary, None))


def record(db, r):
    """Append one settled call, if its account agreed to be learned from. Never raises: the journal is a copy."""
    try:
        if r.user_id is None:
            return False
        u = db.get(User, r.user_id)
        if not u or not u.learn_consent:
            return False
        line = json.dumps(row_record(r), default=str, separators=(",", ":"))
        p = path()
        with _lock:
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        return True
    except Exception:
        log.exception("journal write failed")
        return False


def stats():
    p = path()
    if not p.exists():
        return dict(lines=0, bytes=0)
    with _lock:
        with open(p, "rb") as f:
            lines = sum(1 for _ in f)
    return dict(lines=lines, bytes=p.stat().st_size)

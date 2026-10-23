"""Database tables. All times are naive UTC (see utcnow)."""
import json
from datetime import datetime, timezone

from sqlalchemy import (Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso(dt):
    return None if dt is None else dt.replace(microsecond=0).isoformat() + "Z"


def jload(s, default=None):
    if not s:
        return default
    try:
        return json.loads(s)
    except (TypeError, ValueError):
        return default


def jdump(v):
    return json.dumps(v, separators=(",", ":"), default=str)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    first_name: Mapped[str] = mapped_column(String(80), default="")
    last_name: Mapped[str] = mapped_column(String(80), default="")
    experience: Mapped[str | None] = mapped_column(String(20), nullable=True)   # beginner | intermediate | advanced
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    role: Mapped[str] = mapped_column(String(20), default="user")              # user | admin
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    trial_ends_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    plan: Mapped[str] = mapped_column(String(20), default="free")             # free | pro
    plan_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True)
    org_role: Mapped[str | None] = mapped_column(String(20), nullable=True)   # owner | teacher | member
    settings_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    streak_days: Mapped[int] = mapped_column(Integer, default=0)
    streak_last: Mapped[str | None] = mapped_column(String(10), nullable=True)
    reset_token_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    reset_token_expires: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    verify_token_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)      # email confirmation
    verify_token_expires: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    terms_accepted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)   # when they ticked the Terms
    terms_version: Mapped[str | None] = mapped_column(String(20), nullable=True)           # which Terms they accepted
    learn_consent: Mapped[bool] = mapped_column(Boolean, default=False)                   # may we learn from their charts?
    suspended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)       # set by an admin (is_active off)
    suspended_reason: Mapped[str | None] = mapped_column(String(200), nullable=True)
    strategies: Mapped[str | None] = mapped_column(Text, nullable=True)                 # JSON list of strategy ids
    strategies_set_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # None: ask on next sign-in

    org = relationship("Organization", foreign_keys=[org_id], lazy="joined")

    @property
    def name(self):
        return (f"{self.first_name} {self.last_name}").strip() or self.email.split("@")[0]


class OAuthAccount(Base):
    __tablename__ = "oauth_accounts"
    __table_args__ = (UniqueConstraint("provider", "subject"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(20))
    subject: Mapped[str] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Organization(Base):
    __tablename__ = "organizations"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    owner_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    seats: Mapped[int] = mapped_column(Integer, default=5)
    plan_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    invite_code: Mapped[str] = mapped_column(String(24), unique=True, index=True)
    brand_color: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Payment(Base):
    __tablename__ = "payments"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    reference: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    provider: Mapped[str] = mapped_column(String(20))       # paystack | paystack_dva | opay | manual
    method: Mapped[str | None] = mapped_column(String(30), nullable=True)
    plan: Mapped[str] = mapped_column(String(20))           # pro | org
    months: Mapped[int] = mapped_column(Integer, default=1)
    seats: Mapped[int] = mapped_column(Integer, default=1)
    amount_kobo: Mapped[int] = mapped_column(Integer)       # amount due, in kobo (₦1 = 100 kobo)
    paid_kobo: Mapped[int | None] = mapped_column(Integer, nullable=True)
    currency: Mapped[str] = mapped_column(String(8), default="NGN")
    # pending → success | failed | abandoned ; manual: awaiting_transfer → review → success | rejected
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    applied: Mapped[bool] = mapped_column(Boolean, default=False)
    provider_ref: Mapped[str | None] = mapped_column(String(128), nullable=True)
    account_label: Mapped[str | None] = mapped_column(String(160), nullable=True)
    payer_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    proof_path: Mapped[str | None] = mapped_column(String(300), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    verified_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    crypto_network: Mapped[str | None] = mapped_column(String(12), nullable=True)           # trc20 | bep20 | erc20
    crypto_amount: Mapped[str | None] = mapped_column(String(24), nullable=True)            # the exact USDT amount due
    crypto_address: Mapped[str | None] = mapped_column(String(120), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)            # crypto window closes

    user = relationship("User", lazy="joined")


class VirtualAccount(Base):
    __tablename__ = "virtual_accounts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    customer_code: Mapped[str] = mapped_column(String(64), index=True)
    account_number: Mapped[str | None] = mapped_column(String(20), index=True, nullable=True)
    account_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    bank_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")   # pending | active | failed
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class UsageCounter(Base):
    __tablename__ = "usage_counters"
    __table_args__ = (UniqueConstraint("user_id", "day", "kind"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    day: Mapped[str] = mapped_column(String(10))
    kind: Mapped[str] = mapped_column(String(20))
    count: Mapped[int] = mapped_column(Integer, default=0)


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    thread_id: Mapped[str] = mapped_column(String(40), index=True)
    role: Mapped[str] = mapped_column(String(12))           # user | assistant
    content: Mapped[str] = mapped_column(Text)
    meta: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class SavedDrawing(Base):
    __tablename__ = "saved_drawings"
    __table_args__ = (UniqueConstraint("user_id", "symbol"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    symbol: Mapped[str] = mapped_column(String(64))
    data: Mapped[str] = mapped_column(Text, default="[]")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class SavedAnalysis(Base):
    """The last analysis run on one chart (symbol and timeframe). It stays on that chart until the user cleans it."""
    __tablename__ = "saved_analyses"
    __table_args__ = (UniqueConstraint("user_id", "symbol", "tf"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    symbol: Mapped[str] = mapped_column(String(64))
    tf: Mapped[str] = mapped_column(String(16))
    data: Mapped[str] = mapped_column(Text, default="{}")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class WatchItem(Base):
    __tablename__ = "watchlist"
    __table_args__ = (UniqueConstraint("user_id", "symbol"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    symbol: Mapped[str] = mapped_column(String(64))
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class AppSetting(Base):
    __tablename__ = "app_settings"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class AnalysisLog(Base):
    """Every analysis the app gives (the raw material for the verified-learning pipeline)."""
    __tablename__ = "analysis_logs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True, nullable=True)
    kind: Mapped[str] = mapped_column(String(20), default="analysis")   # analysis | review
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    tf: Mapped[str] = mapped_column(String(4))
    price: Mapped[float] = mapped_column(Float)
    action: Mapped[str | None] = mapped_column(String(40), nullable=True)
    grade: Mapped[str | None] = mapped_column(String(4), nullable=True)
    side: Mapped[str | None] = mapped_column(String(8), nullable=True)
    entry: Mapped[float | None] = mapped_column(Float, nullable=True)
    sl: Mapped[float | None] = mapped_column(Float, nullable=True)
    tp: Mapped[float | None] = mapped_column(Float, nullable=True)
    p_tp: Mapped[float | None] = mapped_column(Float, nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    # verified outcome (services/tracker.py): pending → open → tp | sl | time, or expired | missed | dup | void
    outcome: Mapped[str | None] = mapped_column(String(12), nullable=True, index=True)
    outcome_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    outcome_r: Mapped[float | None] = mapped_column(Float, nullable=True)
    plan_type: Mapped[str | None] = mapped_column(String(8), nullable=True)      # market | limit | stop
    called: Mapped[bool | None] = mapped_column(Boolean, nullable=True)          # the verdict said trade it
    filled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    exit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    dup_of: Mapped[int | None] = mapped_column(Integer, nullable=True)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # how the trade travelled (services/excursion.py), in multiples of the planned risk: the worst it went against the
    # entry (mae_r) and the best it went for it (mfe_r) while open; for a stopped trade, whether price went on to the
    # target afterwards (swept: the stop was taken, then the move happened) and how far past the stop it went first
    mae_r: Mapped[float | None] = mapped_column(Float, nullable=True)
    mfe_r: Mapped[float | None] = mapped_column(Float, nullable=True)
    swept: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    sweep_depth_r: Mapped[float | None] = mapped_column(Float, nullable=True)
    post_final: Mapped[bool] = mapped_column(Boolean, default=False)          # the after-stop watch is finished
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class AdminAction(Base):
    __tablename__ = "admin_actions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    admin_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    action: Mapped[str] = mapped_column(String(60))
    target: Mapped[str | None] = mapped_column(String(120), nullable=True)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class PracticeAttempt(Base):
    """A draw & score attempt: the user's analysis graded against the analyst (and later against what happened)."""
    __tablename__ = "practice_attempts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    tf: Mapped[str] = mapped_column(String(4))
    price: Mapped[float] = mapped_column(Float)
    bias: Mapped[str | None] = mapped_column(String(10), nullable=True)
    score: Mapped[int] = mapped_column(Integer)
    grade: Mapped[str] = mapped_column(String(20))
    breakdown: Mapped[str | None] = mapped_column(Text, nullable=True)
    drawings: Mapped[str | None] = mapped_column(Text, nullable=True)
    trade: Mapped[str | None] = mapped_column(Text, nullable=True)
    challenge: Mapped[str | None] = mapped_column(String(20), nullable=True)   # e.g. daily-2026-10-13
    outcome: Mapped[str | None] = mapped_column(String(12), nullable=True)
    outcome_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class SavedStrategy(Base):
    __tablename__ = "strategies"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(60))
    spec: Mapped[str] = mapped_column(Text)
    last_symbol: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_tf: Mapped[str | None] = mapped_column(String(4), nullable=True)
    last_stats: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Alert(Base):
    """A price alert (above / below / crossing a level) or a strategy alert (a saved strategy fires on a closed
    candle). Checked by the background loop; fires a Notification (and an email when asked)."""
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(12), default="price")          # price | strategy
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    tf: Mapped[str | None] = mapped_column(String(4), nullable=True)
    op: Mapped[str | None] = mapped_column(String(8), nullable=True)        # above | below | cross
    price: Mapped[float | None] = mapped_column(Float, nullable=True)
    strategy_id: Mapped[int | None] = mapped_column(ForeignKey("strategies.id", ondelete="CASCADE"), nullable=True)
    note: Mapped[str | None] = mapped_column(String(120), nullable=True)
    status: Mapped[str] = mapped_column(String(12), default="active", index=True)   # active | paused | triggered
    repeat: Mapped[bool] = mapped_column(Boolean, default=False)
    email: Mapped[bool] = mapped_column(Boolean, default=False)
    last_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_bar: Mapped[int | None] = mapped_column(Integer, nullable=True)     # strategy alerts: last candle checked
    fired: Mapped[int] = mapped_column(Integer, default=0)
    triggered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class StrategyWatch(Base):
    """"Watch this pair for these strategies": the background scanner looks at the pair's newest closed candles and,
    when one of the chosen strategies fires, writes a Notification (the bell), and sends an email and a phone/browser
    push when asked. `seen` remembers the signals already reported, so each one is sent once."""
    __tablename__ = "strategy_watches"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    tf: Mapped[str] = mapped_column(String(4), default="15m")
    strategies: Mapped[str] = mapped_column(Text, default="[]")             # JSON list of catalog ids
    status: Mapped[str] = mapped_column(String(12), default="active", index=True)    # active | paused
    email: Mapped[bool] = mapped_column(Boolean, default=True)
    push: Mapped[bool] = mapped_column(Boolean, default=True)                # phone / browser push to the user's devices
    broker_id: Mapped[int | None] = mapped_column(Integer, nullable=True)    # connected broker account to send setups to
    auto_send: Mapped[bool] = mapped_column(Boolean, default=False)          # place the order by itself when it fires
    seen: Mapped[str] = mapped_column(Text, default="{}")                    # JSON {"<id>:<candle epoch>:<dir>": epoch}
    last_bar: Mapped[int | None] = mapped_column(Integer, nullable=True)     # newest closed candle scanned
    fired: Mapped[int] = mapped_column(Integer, default=0)
    last_fired_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_text: Mapped[str | None] = mapped_column(String(200), nullable=True)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class BrokerAccount(Base):
    """A broker the person connected, so a plan can be sent to it. The keys are stored encrypted (services/brokers.py);
    they are never sent back to the browser."""
    __tablename__ = "broker_accounts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(12))                            # mt | binance | bybit | oanda
    label: Mapped[str] = mapped_column(String(60), default="")
    live: Mapped[bool] = mapped_column(Boolean, default=False)               # real money (False: demo / testnet / practice)
    secrets: Mapped[str] = mapped_column(Text, default="")                   # encrypted JSON
    settings: Mapped[str] = mapped_column(Text, default="{}")                # JSON: caps, auto-send size, suffix, region
    info: Mapped[str] = mapped_column(Text, default="{}")                    # JSON: last balance / account name
    status: Mapped[str] = mapped_column(String(12), default="ok")            # ok | pending | error
    error: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class BrokerOrder(Base):
    """Every order sent (or refused) to a broker, by hand or by a watch: the person's own record."""
    __tablename__ = "broker_orders"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    account_id: Mapped[int | None] = mapped_column(ForeignKey("broker_accounts.id", ondelete="SET NULL"), nullable=True,
                                                   index=True)
    symbol: Mapped[str] = mapped_column(String(64))
    side: Mapped[str] = mapped_column(String(6))
    kind: Mapped[str] = mapped_column(String(8), default="market")
    entry: Mapped[float] = mapped_column(Float)
    sl: Mapped[float] = mapped_column(Float)
    tps: Mapped[str] = mapped_column(Text, default="[]")
    size: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(10), default="sent")          # sent | failed
    external: Mapped[str] = mapped_column(Text, default="[]")                # the broker's order / position ids
    error: Mapped[str | None] = mapped_column(String(400), nullable=True)
    source: Mapped[str] = mapped_column(String(8), default="manual")         # manual | watch
    ref: Mapped[str | None] = mapped_column(String(120), unique=True, nullable=True)   # stops a double send
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20), default="alert")
    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    link: Mapped[str | None] = mapped_column(String(300), nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class PushSubscription(Base):
    """A device that switched on phone alerts (Web push). One row per browser or phone."""
    __tablename__ = "push_subscriptions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    endpoint: Mapped[str] = mapped_column(String(600), unique=True)
    p256dh: Mapped[str] = mapped_column(String(200))
    auth: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Donation(Base):
    """A voluntary donation through Paystack. Amounts are kobo, like payments. A donation unlocks nothing."""
    __tablename__ = "donations"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    reference: Mapped[str] = mapped_column(String(64), unique=True, index=True)     # starts with DON
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    email: Mapped[str] = mapped_column(String(255), default="")
    message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    amount_kobo: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(12), default="pending")             # pending | success | failed
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SupportTicket(Base):
    """A message from the Support page. Always kept here; also emailed to the company once email is set up."""
    __tablename__ = "support_tickets"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    email: Mapped[str] = mapped_column(String(255), default="")
    category: Mapped[str] = mapped_column(String(20), default="other")
    subject: Mapped[str] = mapped_column(String(160))
    message: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(12), default="open", index=True)     # open | closed
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class UserAnalysis(Base):
    """An analysis the person made their own: often an AI analysis they edited. It keeps every drawing (the AI's and
    theirs) and their trade plan, and the AI's grade of it once they ask for one."""
    __tablename__ = "user_analyses"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    symbol: Mapped[str] = mapped_column(String(64))
    tf: Mapped[str] = mapped_column(String(8))
    title: Mapped[str] = mapped_column(String(120), default="")
    source: Mapped[str] = mapped_column(String(16), default="ai")          # ai (edited from the analyst) | own | replay
    source_analysis_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    replay_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    data: Mapped[str] = mapped_column(Text, default="{}")                   # drawings, plan, notes, the AI's original call
    grade: Mapped[str | None] = mapped_column(Text, nullable=True)          # the AI's grade (JSON)
    graded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class ClassLive(Base):
    """A teacher's live chart, shown to their organization's students while it is exposed."""
    __tablename__ = "class_live"
    teacher_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    org_id: Mapped[int] = mapped_column(Integer, index=True)
    title: Mapped[str] = mapped_column(String(120), default="")
    state: Mapped[str] = mapped_column(Text, default="{}")                  # symbol, tf, replay, drawings, analysis ...
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Idea(Base):
    """A published trade idea: a chart, a direction and the reasoning, shared with everyone."""
    __tablename__ = "ideas"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    tf: Mapped[str] = mapped_column(String(8))
    side: Mapped[str | None] = mapped_column(String(8), nullable=True)      # long | short | None (education)
    title: Mapped[str] = mapped_column(String(140))
    body: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[str] = mapped_column(Text, default="{}")                   # drawings, plan, price when published
    likes: Mapped[int] = mapped_column(Integer, default=0)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class IdeaLike(Base):
    __tablename__ = "idea_likes"
    __table_args__ = (UniqueConstraint("idea_id", "user_id"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    idea_id: Mapped[int] = mapped_column(ForeignKey("ideas.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

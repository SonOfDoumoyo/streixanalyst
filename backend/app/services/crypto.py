"""USDT payments on-chain, confirmed automatically.

Each crypto payment gets its own amount: the USD price plus a few cents, so two open payments never share an amount.
The company wallet (CRYPTO_WALLET_ADDRESS) is then checked on a block explorer. A payment is marked paid when a
confirmed USDT transfer of exactly that amount reaches the wallet after the payment was created. Each transaction
can pay for one payment only (its hash is recorded). Payments not paid within WINDOW_MINUTES expire."""
import logging
import random
from datetime import timedelta, timezone
from decimal import Decimal

import httpx
from fastapi import HTTPException
from sqlalchemy import select

from ..config import settings
from ..models import Payment, utcnow
from . import billing

log = logging.getLogger("streix.crypto")

WINDOW_MINUTES = 60
SLACK_SECONDS = 300          # allow a little clock drift between us and the chain

NETWORKS = {
    "trc20": dict(label="USDT on TRON (TRC20)", decimals=6, contract="TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"),
    "bep20": dict(label="USDT on BNB Smart Chain (BEP20)", decimals=18,
                  contract="0x55d398326f99059fF775485246999027B3197955", chain_id=56),
    "erc20": dict(label="USDT on Ethereum (ERC20)", decimals=6,
                  contract="0xdAC17F958D2ee523a2206206994597C13D831ec7", chain_id=1),
}


def enabled_network():
    n = (settings.crypto_network or "trc20").lower()
    return n if n in NETWORKS else "trc20"


def label(net):
    return NETWORKS[net]["label"]


def _units(amount, decimals):
    return int(Decimal(amount) * (Decimal(10) ** decimals))


def _utc_ts(dt):
    return int(dt.replace(tzinfo=timezone.utc).timestamp())


def new_intent(db, pay, usd):
    """Give `pay` a unique USDT amount on the configured network, open for WINDOW_MINUTES."""
    net = enabled_network()
    base = Decimal(str(usd)).quantize(Decimal("0.01"))
    taken = set(db.execute(select(Payment.crypto_amount).where(
        Payment.provider == "crypto", Payment.crypto_network == net, Payment.applied.is_(False),
        Payment.created_at > utcnow() - timedelta(hours=24))).scalars())
    for cents in random.sample(range(1, 100), 99):
        amount = f"{base + Decimal(cents) / 100:.2f}"
        if amount not in taken:
            break
    else:
        raise HTTPException(503, "Too many crypto payments are open right now. Please try again in a few minutes.")
    pay.currency = "USDT"
    pay.crypto_network = net
    pay.crypto_amount = amount
    pay.crypto_address = settings.crypto_wallet_address
    pay.expires_at = utcnow() + timedelta(minutes=WINDOW_MINUTES)
    db.commit()
    return pay


def _transfers(net, since):
    """Confirmed USDT transfers into the company wallet since `since` (unix seconds): [(txid, units, unix_time)].
    Returns None when the explorer can't be reached, so nothing is decided on a failed check."""
    addr = settings.crypto_wallet_address
    key = settings.crypto_explorer_api_key
    cfg = NETWORKS[net]
    try:
        if net == "trc20":
            r = httpx.get(f"https://api.trongrid.io/v1/accounts/{addr}/transactions/trc20",
                          params=dict(only_to="true", only_confirmed="true", limit=200,
                                      min_timestamp=since * 1000, contract_address=cfg["contract"]),
                          headers={"TRON-PRO-API-KEY": key} if key else {}, timeout=20)
            r.raise_for_status()
            return [(t["transaction_id"], int(t["value"]), int(t["block_timestamp"]) // 1000)
                    for t in r.json().get("data", []) if t.get("to") == addr]
        r = httpx.get("https://api.etherscan.io/v2/api",
                      params=dict(chainid=cfg["chain_id"], module="account", action="tokentx",
                                  contractaddress=cfg["contract"], address=addr, page=1, offset=200, sort="desc",
                                  apikey=key or ""), timeout=20)
        r.raise_for_status()
        j = r.json()
        rows = j.get("result") if isinstance(j.get("result"), list) else []
        if j.get("status") != "1" and not rows and "No transactions" not in str(j.get("message", "")):
            raise ValueError(str(j.get("result") or j.get("message")))
        return [(t["hash"], int(t["value"]), int(t["timeStamp"])) for t in rows
                if (t.get("to") or "").lower() == addr.lower()]
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
        log.warning("crypto check on %s failed: %s", net, e)
        return None


def _match(db, pays, net):
    """Apply each open payment (all on network `net`) that has a matching, unused transfer. Returns how many."""
    if not pays:
        return 0
    txs = _transfers(net, min(_utc_ts(p.created_at) for p in pays) - SLACK_SECONDS)
    if txs is None:
        return 0
    used = set(db.execute(select(Payment.provider_ref).where(
        Payment.provider == "crypto", Payment.provider_ref.is_not(None))).scalars())
    applied = 0
    for pay in pays:
        want = _units(pay.crypto_amount, NETWORKS[net]["decimals"])
        earliest = _utc_ts(pay.created_at) - SLACK_SECONDS
        hit = next((t for t in txs if t[1] == want and t[2] >= earliest and t[0] not in used), None)
        if hit:
            used.add(hit[0])
            billing.apply_payment(db, pay, paid_kobo=pay.amount_kobo, provider_ref=hit[0],
                                  raw=dict(txid=hit[0], amount=pay.crypto_amount, network=net), method="crypto")
            applied += 1
    return applied


def _expire(db, pays):
    now = utcnow()
    for p in pays:
        if p.status == "pending" and not p.applied and p.expires_at and p.expires_at < now:
            p.status = "expired"
    db.commit()


def verify_one(db, pay):
    """Checked while the person is on the checkout page."""
    if pay.applied:
        return dict(ok=True, status="success")
    if pay.status == "pending":
        _match(db, [pay], pay.crypto_network or enabled_network())
        db.refresh(pay)
        if not pay.applied:
            _expire(db, [pay])
    if pay.applied:
        return dict(ok=True, status="success")
    if pay.status == "expired":
        return dict(ok=False, status="expired", message="This payment window has closed. Start a new crypto payment.")
    return dict(ok=False, status=pay.status,
                message="We haven't seen your transfer yet. It can take a few minutes to confirm on the blockchain.")


def sweep(db):
    """Background check, every 30 seconds: one explorer call per network that has open payments."""
    pays = db.execute(select(Payment).where(Payment.provider == "crypto", Payment.status == "pending",
                                             Payment.applied.is_(False),
                                             Payment.crypto_amount.is_not(None))).scalars().all()
    if not pays:
        return
    now = utcnow()
    for net in {p.crypto_network for p in pays if p.crypto_network}:
        group = [p for p in pays if p.crypto_network == net and p.expires_at and p.expires_at >= now]
        n = _match(db, group, net)
        if n:
            log.info("crypto: applied %d payment(s) on %s", n, net)
    _expire(db, pays)

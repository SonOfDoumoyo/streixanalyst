# Connect a broker

**Send to broker** (on the analysis card) sends a plan's entry, stop loss and take profit to the person's own broker
account, so it shows there. **TradingView** gives a Pine Script that draws the plan on a TradingView chart. Connect
accounts from the account menu → **Connect a broker**. Needs the Pro plan or the trial.

| Broker | How it connects | What the server needs |
| --- | --- | --- |
| MetaTrader 4 / 5 | the person's MT login, trading password and broker server, through [MetaApi](https://metaapi.cloud) | `METAAPI_TOKEN` (a paid MetaApi plan). The MetaTrader option appears for everyone as soon as it is set. The password goes to MetaApi and is not stored here |
| OANDA | API token + account number (practice or live) | nothing |
| Bybit | API key + secret, USDT perpetual futures (testnet or live) | nothing |
| Binance Futures | API key + secret, USDT-M futures (testnet or live) | nothing |

cTrader is not included: its API is a different protocol (it needs an approved Spotware app and a separate OAuth flow).

## Safety
* Keys are encrypted in the database (`BROKER_KEY`, else derived from `SECRET_KEY`) and never sent back to the browser.
  Tell people to make keys that can trade but **cannot withdraw**.
* Nothing is sent until the person presses Send and confirms. Live accounts are marked LIVE and need a tick.
* Every order is checked before it leaves: the stop is on the right side of the entry, the targets are on the right side,
  the size is within the account's own limit (largest order; USDT value for crypto) and no more than N orders a day
  (default 5). Every order, sent or refused, is recorded.
* **Auto-send** (a watch's "Place the order by itself") places each new setup with the account's fixed auto-send size,
  inside the same limits. It never sends a stale signal, a price that already ran past a limit entry, or a fixed-time call.
  Live accounts need an extra tick. Deleting the broker or clearing its auto-send size switches auto-send off.
* Binance: the stop and take profit are placed as conditional orders after the entry. If they fail, the entry is
  cancelled (or closed) so nothing is left without a stop. Binance takes one take profit here (TP1).

## Before real money
Connect a demo / practice / testnet account first and send a few orders. The broker calls were written from each
broker's documentation and tested against simulated brokers, not live ones: check each broker on its demo account first.

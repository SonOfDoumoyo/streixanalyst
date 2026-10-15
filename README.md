# StreixAnalyst

**The AI analyst that reads the chart with you.** A Streixcorp product.

A TradingView-style charting app for every market (crypto on Binance, Bybit, OKX, KuCoin, MEXC, Gate and Coinbase —
spot and perpetuals — plus forex, gold, oil, indices and US stocks) with an **Analyse** button. The button runs the
Guru analyst from notebook 6 and draws on the chart:

- structure and liquidity;
- order blocks and fair value gaps;
- key levels, with their odds;
- a full trade plan: entry, stop, targets, size, leverage and liquidation.

It also checks the economic calendar and headlines. **StreixAI** explains everything at the user's level.

```
streixanalyst/
├── backend/        FastAPI API — accounts, plans, market data, analysis, news, StreixAI, billing, admin
│   ├── app/        the API
│   ├── guru/       the notebook-6 modules (market_data, guru_model, guru_analyst, …) — unchanged copies
│   ├── models/     put guru_brain.joblib here (or upload it from Admin → System & model)
│   └── tests/      offline end-to-end tests (fake exchanges, Paystack, OPay, Anthropic)
├── web/            Next.js 16 app — landing, sign-in, terminal (custom canvas chart), draw & score, strategy lab,
│                   track record, alerts, billing, settings, admin, TV mode
└── render.yaml     one-click Render blueprint for the API + PostgreSQL in Frankfurt
```

## What's in this version (phases 1 and 2)

| Area | What works |
|---|---|
| Accounts | **Sign-up:** email + password with first name, last name and trading experience (beginner / intermediate / advanced).<br>**Social sign-in:** Google and LinkedIn; first-time social users pick their experience on an onboarding screen.<br>**Admin:** your login comes from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.<br>**Passwords:** reset by email (needs SMTP) or by the admin. |
| Plans | **30-day trial** with everything unlocked.<br>**Free:** charts, all drawing tools, 5 analyses, 10 StreixAI messages and 2 reviews a day.<br>**Pro:** 150 analyses and 200 messages a day, both report styles, and every feature as it ships.<br>**Organization:** per seat, with invite codes and teacher/student roles.<br>Prices and limits are editable in Admin. |
| Charts | **Data:** any symbol, timeframes 1m to 1M, live updates, and more history loaded as you scroll back.<br>**Chart types:** candles, hollow candles, Heikin Ashi, bars, line and area.<br>**Indicators:** EMA 20/50/200, Bollinger, VWAP and an RSI pane.<br>**Look:** custom candle colours (body, wick, border) and chart backgrounds.<br>**Controls:** pan, zoom, pinch and axis scaling; keyboard shortcuts. |
| Drawing | **Tools:** trend line, ray, extended line, arrow, horizontal line/ray, vertical line, rectangle/zone, parallel channel, Fibonacci, long/short position, measure and text.<br>**Styling:** colours, widths, solid/dashed/dotted lines, extend, lock, clone, undo/redo and magnet.<br>**Saving:** drawings are saved per symbol to your account. |
| Analysis | **Drawing:** an animated overlay, with detail levels (Essentials / Normal / All) and per-layer toggles.<br>**Panel:** verdict and grade, plan card with odds vs break-even, EV after costs, sizing / leverage / liquidation, checklist, news, bigger picture, key levels, your own levels graded, an alternative plan, full simple and pro reports, and an honest model card.<br>**Review:** "Review my trade" (also from a long/short drawing). |
| News | ForexFactory weekly calendar plus CoinDesk, Cointelegraph, Decrypt, FXStreet and Yahoo headlines. A high-impact release close to your timeframe puts a warning on the verdict. |
| StreixAI | **Models:** streams from Claude (`ANTHROPIC_API_KEY`) or any OpenAI-compatible API.<br>**Context:** uses your latest analysis of the chart.<br>**Level:** adapts to beginner / intermediate / advanced.<br>**Without a key:** built-in trading knowledge base; it can also explain your analysis (why the stop is there, the targets, leverage).<br>**History:** conversations are saved. |
| Payments | **Paystack:** card, bank, USSD and bank transfer.<br>**Personal account numbers:** Paystack dedicated virtual accounts.<br>**OPay:** OPay Checkout.<br>**Direct transfer:** to your OPay **9160309499** / UBA **2385227704** (NIMI DOUMOYO MEREMUBIO), with receipt upload and admin approval.<br>Every method is verified before a plan unlocks (see *Payment safety*). |
| Admin | Stats and revenue, payments queue (receipts, approve/reject, re-check), users (+Pro days, +trial days, reset password, disable, make admin), prices/limits/accounts/announcement, model upload & status, data-source status, audit log. |
| Devices | **Phones:** bottom tabs and slide-up panels.<br>**Tablets:** slide-over panel.<br>**Desktop:** full terminal.<br>**TVs:** `/tv` presentation mode, with big type, ←/→ to change market, A to analyse, R to rotate the watchlist and F for full screen.<br>The app is installable as a PWA. |

**Phase 2 (new in this build):**

| Area | What works |
|---|---|
| Draw & score (`/practice`) | **Practice:** mark levels, zones and trendlines, optionally place a long/short, call the bias, and press *Score my analysis*. The analyst runs on the same chart while your work stays hidden.<br>**Score out of 100:** levels 40 (found vs. missed, and whether yours have real reactions), bias 20, trade 40 (graded by the trade reviewer).<br>**Corrections on the chart:** missed levels in orange, the ones you found in green, weak ones in red, plus an optional *reveal the analyst*.<br>**Coaching:** StreixAI coaches you on that exact attempt.<br>**Motivation:** a daily challenge (same chart for everyone), today's leaderboard, history and a personal best. |
| Strategy lab (`/strategy`) | **Describe it in words** ("buy when EMA 50 is above EMA 200 and RSI crosses back above 30, London session, stop 1.5 ATR, 2R"). The rules are read by StreixAI, or by the built-in parser without an API key.<br>**Or build it:** pick from 6 templates or 15 conditions (EMA trend/cross, price vs EMA, RSI, breakout, pullback, engulfing, BOS/CHoCH, liquidity sweep, structure, higher-timeframe trend, sessions, volume, Bollinger), with ATR / swing / percent stops and R / ATR / percent targets.<br>**Honest backtest:** up to 5,000 candles; entries at the next candle's open; stop-first when a candle touches both; real costs and slippage. You get trades, win rate, average R, profit factor, drawdown, t-stat, a plain verdict, an equity curve and a trade list.<br>**Live check:** whether each rule is true right now, with entry / stop / target when it fires.<br>**Saving:** up to 50 saved strategies. |
| Alerts (the bell) | **Price alerts:** rises to / falls to / crosses. They check 1-minute highs and lows, so a quick wick still counts.<br>**Plan alerts:** *Alert me* on a plan card sets alerts on its entry, stop and target.<br>**Strategy alerts:** checked on every closed candle of a saved strategy.<br>**Delivery:** in-app inbox, browser notifications and optional email (needs SMTP). Alerts are checked about every 30 seconds by the API's background loop.<br>**Limits:** free 2 active, Pro 50, Org 100. |
| Track record (`/track-record`, public) | **Every trade plan is followed on live prices**, on a finer timeframe (a 1h call on 5m candles). It uses the same fill, stop-first, expiry and cost rules the model was trained with.<br>**Integrity:** results are written once and never edited. Identical calls count once.<br>**Stats:** win rate, average and total R, fill rate, by grade, by timeframe, a cumulative curve and the latest calls.<br>**Filter check:** called trades are compared with the ideas the analyst rejected, so you can see whether its "no trade" filter helps.<br>**Your own record:** signed-in users can switch to *My analyses*. |
| Verified learning data | **Admin → Learning data:** exports resolved calls (each with its full analysis snapshot and measured result) and highly scored practice analyses as JSON Lines, for retraining in the notebook.<br>**No blind learning:** nothing retrains automatically, and a new brain goes live only when you upload it after checking its out-of-sample report. Exports are audited. |

**Next phases:**

- **Classroom and teach mode:** teacher dashboards, assignments and live presenting to a class.
- **The retraining cell in the notebook** that consumes the learning exports.
- **Mobile apps and desktop apps** (Mac / Windows).

The pricing page marks classroom, teach mode and organization branding as **soon** until they ship.

## Run it on your computer

**Backend** (Python 3.11+):

```bash
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # then edit: SECRET_KEY, ADMIN_EMAIL, ADMIN_PASSWORD, FRONTEND_URL=http://localhost:3000, ENV=development
uvicorn app.main:app --reload --port 8000
```

**Web** (Node 20.9+):

```bash
cd web
npm install
BACKEND_URL=http://localhost:8000 npm run dev            # Windows PowerShell: $env:BACKEND_URL="http://localhost:8000"; npm run dev
```

Open http://localhost:3000 and sign in with your admin email and password.

**Tests** (fully offline):

```bash
cd backend && python tests/test_api.py
```

## Put it online

The browser only ever talks to your website. Next.js forwards `/api/*` to the backend, so cookies, Google/LinkedIn
sign-in and payment callbacks all stay on one domain.

### 1. Backend on Render (Frankfurt)

Host the API in **Europe**. Binance and Bybit refuse servers in the US, and Frankfurt is close to Nigeria.

1. Push this folder to a GitHub repo.
2. On render.com, go to **New → Blueprint** and pick the repo. `render.yaml` creates the API (Docker, Frankfurt, a 5 GB disk at `/var/data`) and a PostgreSQL database.
3. Fill in the environment variables the blueprint asks for (see `backend/.env.example`):
   - `FRONTEND_URL` (your site, e.g. `https://streixanalyst.com`);
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD`;
   - `ANTHROPIC_API_KEY`;
   - `PAYSTACK_SECRET_KEY`;
   - `MANUAL_ACCOUNTS`.
4. Check that `https://<your-api>.onrender.com/api/health` answers `{"ok": true, …}`.

Any host that runs Docker works the same way (Railway, Fly.io in `fra`, a VPS…). Run **one** process; the app uses threads.

### 2. Website on Vercel

1. On vercel.com, go to **Add New → Project**, pick the repo and set **Root Directory** to `web`.
2. Add the environment variable `BACKEND_URL=https://<your-api>.onrender.com`, plus optionally `SITE_URL=https://streixanalyst.com`.
3. Deploy, then add your domain (e.g. `streixanalyst.com`) under **Settings → Domains**.
4. Make sure the backend's `FRONTEND_URL` is exactly that domain.

### 3. Load the trained brain

Notebook 7 (v1.3) saves `guru_brain_v13.joblib` in Google Drive at `trading_ai/guru_v13/`. Run it with `RETRAIN = True` so the brain includes the bull / bear bar calibration. You have two ways to load it:

- **Upload it:** sign in as admin, open **Admin → System & model** and upload it.
- **Copy it:** put it on the server at `GURU_BRAIN_PATH`, then press **Reload**.

> **scikit-learn must be the same version as Colab's.** Notebook 7 prints the exact version it used, and `backend/requirements.txt` pins `scikit-learn==1.6.1` for v1.3. If the versions differ, the server refuses the brain and the app keeps working with rough random-walk odds. See `START_HERE.md` for the full order of steps.

### 4. Payments

**Paystack** (card, bank, USSD, transfer):

1. Dashboard → **Settings → API Keys & Webhooks**: copy the secret key into `PAYSTACK_SECRET_KEY`.
2. Set the webhook URL to `https://streixanalyst.com/api/billing/paystack/webhook`.
3. Test with your test keys first (`sk_test_…`), then switch to live keys.

**Personal account numbers (Dedicated Virtual Accounts):**

1. Ask Paystack to enable DVA on your business (registered, live businesses).
2. Set `PAYSTACK_DVA_ENABLED=1`.

Users add their phone number and get their own account number. Transfers to it unlock the plan automatically.

**OPay Checkout:**

1. Get a merchant account at opaycheckout.com.
2. Set `OPAY_MERCHANT_ID`, `OPAY_PUBLIC_KEY` and `OPAY_SECRET_KEY`.
3. Use `OPAY_BASE_URL` for the host OPay gives you; their sandbox is `https://testapi.opaycheckout.com`.

Confirm the cashier fields with OPay during onboarding.

**Direct transfer to your OPay / UBA accounts:** this works with no setup.

1. The user picks an account and sends the exact amount, writing the reference (e.g. `SA7KQ2M9`) in the narration.
2. They upload the receipt.
3. You check that the money has arrived in your OPay/UBA app, then press **Approve** in **Admin → Payments**.

### 5. Sign in with Google and LinkedIn

**Google:**

1. Go to console.cloud.google.com → **APIs & Services → Credentials → Create OAuth client ID → Web application**.
2. Add the authorized redirect URI `https://streixanalyst.com/api/auth/oauth/google/callback`.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

**LinkedIn:**

1. Go to linkedin.com/developers → create an app → **Products: Sign In with LinkedIn using OpenID Connect**.
2. Add the redirect URL `https://streixanalyst.com/api/auth/oauth/linkedin/callback`.
3. Set `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`.

The buttons appear automatically once the keys are set.

### 6. Email (optional)

Set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_FROM` (any provider: Zoho, Brevo, Gmail app password…). This enables password-reset links and payment-confirmation emails.

## Payment safety

A plan unlocks **only** when one of these is true:

- **Paystack:** the webhook's HMAC-SHA512 signature is valid **and** Paystack's own verify API confirms all of: `success`, the same reference, NGN, and at least the amount the *server* priced. The browser never decides the price.
- **OPay:** OPay's signed server-to-server status query says `SUCCESS` with the right amount. A callback is only a hint to re-check.
- **Direct transfer:** an admin approves it after seeing the money.

Underpaid or mismatched payments go to **Admin → Payments → To verify** instead of unlocking. A payment can never be applied twice: duplicate webhooks and refreshes are harmless. Every approval or rejection is logged.

## Background jobs

With `ENABLE_BACKGROUND=1` (the default in production) the API runs three background loops:

- the market catalogue refresh, every 30 minutes;
- alerts, every 30 seconds;
- the track-record tracker, every 3 minutes.

They run inside the single uvicorn process. Keep **one** API instance (the Render blueprint does), or alerts could fire twice.

## Security notes

- **Passwords:** hashed with scrypt.
- **Sessions:** JWT in an httpOnly, SameSite=Lax cookie. Native apps get Bearer tokens with `X-Client: app`. Changing a password signs out other devices.
- **Request checks:** state-changing cookie requests must carry `X-Requested-With` (CSRF protection). Login, sign-up and chart calls are rate-limited.
- **Admin:** created from environment variables and never stored in code. The env password is the source of truth on every restart.
- **Receipts:** images and PDFs only, 8 MB maximum, never public (admin-only download).
- **Model upload:** only upload `guru_brain.joblib` files you trained yourself, because joblib files can run code.

## Honesty built in

The analyst shows the probability of reaching the target before the stop next to the break-even win rate, and the expected value after costs. When the odds aren't there, the verdict is **NO TRADE** with a conditional plan.

The model card says plainly whether out-of-sample testing proved an edge, and the public track record shows how the calls actually did afterwards, losses included. StreixAI is instructed never to promise profits or invent prices. This is an analysis and education tool, not financial advice.

# Strategy watches (alerts when a strategy finds a setup)

In the terminal press **Watch** (or the account menu → Watch for setups), pick a pair and timeframe, tick the strategies,
choose where the alert goes, and press **Start watching**. Each new setup is sent once to:

| Where | What it needs |
| --- | --- |
| The bell and a pop-up on the site | nothing (always on) |
| Email | `BREVO_API_KEY` and a verified `EMAIL_FROM` on the server (the **Send me a test email** link checks it) |
| Phone / browser notification | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (see `.env.example`); the person allows notifications once in the browser |

## How it runs
The server scans every active watch every 30 seconds while it is running, and only looks at a pair again when a new candle
has closed. A setup is reported once (strategy + candle + direction), and what was already live when the watch was created
is not announced.

## Hosting
* **Always-on host** (Oracle VM, a VPS, a paid instance): nothing more to do.
* **Host that sleeps when idle** (Render free, Cloud Run): set `CRON_SECRET` on the server (Render's blueprint generates one),
  then add two repository secrets in GitHub (Settings → Secrets and variables → Actions): `API_URL` (for example
  `https://your-api.onrender.com`) and `CRON_SECRET` (same value). `.github/workflows/watch-ping.yml` then calls
  `POST /api/watches/cron` every 5 minutes, which wakes the server and scans. GitHub may delay a run by a few minutes, so
  use 15m and higher timeframes on a sleeping host. Any other scheduler works too: `POST <API>/api/watches/cron` with the
  header `X-Cron-Secret: <CRON_SECRET>`.

Plan limits: 2 watches on the free plan, 20 on Pro (admin can change them under limits).

# Security

No website can promise that nobody will ever break in. What can be done is to close the usual ways in, limit the
damage when something goes wrong, and put the right protection in front of the server for floods of traffic. This
page lists what StreixAnalyst does, and the few things that have to be set up outside the code.

## What the app does

**Accounts and sessions**
- Passwords are stored as scrypt hashes, never as text. Weak and common passwords are refused at sign-up.
- Sessions are signed tokens in an HttpOnly cookie (scripts on the page cannot read it), Secure in production.
- Every state-changing request from a browser must carry `X-Requested-With`, which a form or image on another site
  cannot send. This blocks cross-site request forgery.
- Sign-in is limited per address and email (10 tries in 15 minutes), and an account locks for 30 minutes after 20
  wrong passwords from any number of addresses, so spreading a guessing attack over many machines does not help.
- Changing a password, resetting it, or an admin suspending the account signs it out everywhere at once.

**Admins**
- Admin pages and the admin API check the admin role on every request.
- Admins can suspend an account (signed out at once, sign-in refused with the reason) and delete one for good. Both
  are written to the activity log. The owner account set by `ADMIN_EMAIL` cannot be suspended or deleted from the
  console, and no admin can act on their own account.

**Requests**
- Every `/api` request counts against a per-address budget (`API_RATE_PER_MIN`, 900 a minute by default). A single
  machine flooding the API gets `429 Too Many Requests` without reaching the database. Chart and AI requests also have
  their own per-account limits.
- Request bodies are capped (`MAX_BODY_MB`, 8 MB; the model upload is allowed 400 MB).
- All database access goes through SQLAlchemy with bound parameters, so text typed into the app is never run as SQL.
- Inputs are checked by type and length before use (Pydantic models).
- Error messages to users never include internal details; the full error goes to the server log.

**Responses**
- API responses carry `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a `Content-Security-Policy` that
  lets JSON load nothing, `Cache-Control: no-store`, and `Strict-Transport-Security` in production.
- The web app sends `X-Frame-Options: DENY` and `frame-ancestors 'none'` (no other site can frame it), turns off
  plugins and `<base>` tricks, and asks browsers to stay on HTTPS.
- The interactive API docs (`/api/docs`) are off in production unless `ENABLE_DOCS=1`.

**Payments**
- Card and bank payments are confirmed with Paystack / OPay by the server before a plan is given; a payment page
  cannot unlock a plan by itself. Manual transfers are approved by an admin who has seen the money arrive.

## What has to be set up outside the code

**DDoS protection.** A large distributed attack (many thousands of machines) is stopped before it reaches the server,
not inside it: the per-address limit above only stops single sources. Put the site behind Cloudflare (free plan):

1. Add your domain to Cloudflare and change the domain's nameservers to the two Cloudflare gives you.
2. Point `streixanalyst.com` (the web app) and the API's host name at Render through Cloudflare (orange cloud on).
3. SSL/TLS → Full (strict). Security → Bots → Bot Fight Mode on.
4. Security → WAF → Rate limiting rules: for example, `/api/auth/*` at 20 requests per minute per IP.
5. During an attack, turn on "I'm Under Attack" mode until it passes.

**Secrets.** Keep `SECRET_KEY`, payment keys and AI keys only in Render's environment settings, never in the code or
in chat messages. If a key is ever shared by mistake, make a new one at the provider and replace it.

**Admin account.** Use a long, unique `ADMIN_PASSWORD`, and switch on two-step sign-in for the email account behind
`ADMIN_EMAIL`, since password resets go there.

**Backups.** Turn on daily backups for the PostgreSQL database in Render.

**Updates.** Rebuild and redeploy when FastAPI, Next.js or other dependencies publish security fixes.

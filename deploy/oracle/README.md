# Deploy StreixAnalyst on Oracle Cloud (always-free)

One VM runs everything in Docker: Postgres, the API, the website and Caddy (automatic HTTPS).

## 1. Make the VM (Oracle console)
1. Pick a **Europe** home region when you sign up (Frankfurt, Amsterdam, London...). Binance and Bybit refuse US servers. The region can't be changed later.
2. Compute → Instances → Create. Image **Ubuntu 22.04 or 24.04**, shape **VM.Standard.A1.Flex** (Ampere ARM), **2 OCPU / 12 GB**, boot volume 50 GB. Add your SSH public key.
3. Networking → your subnet → Security List → add **Ingress rules** for TCP **80** and **443** (source `0.0.0.0/0`).
4. Networking → Reserved public IPs → create one and attach it to the VM, so the address never changes.

## 2. Pick the address
- Own domain: add an **A record** to the VM's IP.
- No domain: use `<ip-with-dashes>.sslip.io`, for example `130-61-10-20.sslip.io`. `init-env.sh` offers it by default.

## 3. Set up the VM (once)
```bash
ssh ubuntu@<ip>
git clone https://github.com/SonOfDoumoyo/streixanalyst.git
cd streixanalyst/deploy/oracle
bash setup-vm.sh          # swap, Docker, firewall, nightly backup. Then log out and back in.
cd streixanalyst/deploy/oracle
./init-env.sh             # asks for the address and your admin login; makes the secrets
nano .env                 # add BREVO_API_KEY, EMAIL_FROM, VAPID_*, StreixAI keys, METAAPI_TOKEN ...
./deploy.sh               # builds and starts it (first build takes about 10 minutes)
```
Open `https://<your address>`. Keep a private copy of `.env`: `SECRET_KEY` encrypts people's saved broker keys.

## 4. Move your data from Render
On your computer (use pg_dump 18, like before):
```bash
pg_dump -Fc --no-owner --no-acl "<Render external database URL>" -f streix.dump
scp streix.dump ubuntu@<ip>:~/streixanalyst/deploy/oracle/
```
On the VM:
```bash
./restore.sh streix.dump
```
Use the **same `SECRET_KEY`** as on Render, or old sessions and encrypted broker keys stop working. Put Render's value in `.env` before restoring.

## Everyday
| Do | Command |
|---|---|
| Update to the newest code | `./deploy.sh --pull` |
| Logs | `docker compose logs -f api` |
| Back up now | `./backup.sh` (files in `backups/`, 14 days kept, nightly at 03:30) |
| Restore | `./restore.sh backups/<file>.dump` |
| Stop / start | `docker compose stop` / `docker compose start` |

Copy `backups/` off the VM now and then (`scp`), a VM can be lost.

## Notes
- Strategy watches, alerts and self-learning run inside the API, which is always on here. The GitHub watch-ping workflow isn't needed.
- Oracle can reclaim idle always-free VMs. The nightly backup and a weekly look at the site keep you safe.
- Payments (Paystack/OPay) and Google sign-in: point their webhook and redirect URLs at your new address.

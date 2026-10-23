#!/usr/bin/env bash
# Makes .env with fresh random secrets. Asks for the address, the admin email and the admin password.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then echo ".env already exists. Delete it first if you want a new one."; exit 1; fi
rnd() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "${1:-40}"; }
ip="$(curl -fsS -m 6 https://api.ipify.org 2>/dev/null || true)"
default_domain=""
[ -n "$ip" ] && default_domain="$(echo "$ip" | tr . -).sslip.io"
echo "Address people will open (a domain you own pointed at this VM, or the free one below)."
read -r -p "Domain [${default_domain}]: " domain
domain="${domain:-$default_domain}"
[ -z "$domain" ] && { echo "A domain is needed."; exit 1; }
read -r -p "Your admin email (you sign in with it): " admin_email
read -r -s -p "Admin password (12+ characters): " admin_pw; echo
[ "${#admin_pw}" -lt 12 ] && { echo "Use at least 12 characters."; exit 1; }
sed -e "s|^DOMAIN=.*|DOMAIN=${domain}|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rnd 32)|" \
    -e "s|^SECRET_KEY=.*|SECRET_KEY=$(rnd 64)|" \
    -e "s|^CRON_SECRET=.*|CRON_SECRET=$(rnd 40)|" \
    -e "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=${admin_email}|" \
    -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${admin_pw//|/\\|}|" \
    .env.example > .env
chmod 600 .env
echo
echo "Created .env. Open it (nano .env) to add your Brevo key, StreixAI keys and so on, then run ./deploy.sh"
echo "Keep a copy of .env somewhere safe: SECRET_KEY encrypts people's saved broker keys."

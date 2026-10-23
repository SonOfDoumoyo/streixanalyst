#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu VM on Oracle Cloud: swap, Docker, and the firewall for web traffic.
# Run as the normal user (ubuntu):   bash setup-vm.sh
set -euo pipefail
if [ "$(id -u)" = 0 ]; then echo "Run this as the normal user (it uses sudo itself)."; exit 1; fi

echo "== swap (a safety net while images build)"
if ! swapon --show | grep -q .; then
  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "== Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER"

echo "== firewall: open 80 and 443 (Oracle's Ubuntu images block them inside the VM as well as in the cloud console)"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
done
sudo iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save >/dev/null

echo "== daily database backup at 03:30"
here="$(cd "$(dirname "$0")" && pwd)"
( crontab -l 2>/dev/null | grep -v 'oracle/backup.sh\|streix-backup' ; echo "30 3 * * * cd $here && ./backup.sh >> $here/backups/backup.log 2>&1 # streix-backup" ) | crontab -
mkdir -p "$here/backups"

echo
echo "Done. Log out and back in once (so Docker works without sudo), then:  cd $here && ./init-env.sh && ./deploy.sh"

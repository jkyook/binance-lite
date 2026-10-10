#!/usr/bin/env bash
# Amazon Linux 2023 / Ubuntu 22.04 — Binance Lite on EC2 free tier
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/binance-lite}"
REPO_URL="${REPO_URL:-}"

echo "==> Node 20"
if ! command -v node >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs git
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y nodejs npm git
  else
    echo "Install Node 20+ manually"; exit 1
  fi
fi
node -v

if [[ -n "$REPO_URL" && ! -d "$APP_DIR/.git" ]]; then
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Edit $APP_DIR/.env then re-run or: sudo systemctl restart binance-lite"
fi

npm ci
npm run build

SERVICE_SRC="$APP_DIR/deploy/binance-lite.service"
if [[ -f "$SERVICE_SRC" ]]; then
  # patch WorkingDirectory / User for current user
  TMP=$(mktemp)
  sed -e "s|/home/ubuntu/binance-lite|$APP_DIR|g" \
      -e "s|^User=ubuntu$|User=$(whoami)|g" \
      "$SERVICE_SRC" > "$TMP"
  sudo cp "$TMP" /etc/systemd/system/binance-lite.service
  rm -f "$TMP"
  sudo systemctl daemon-reload
  sudo systemctl enable --now binance-lite
  sudo systemctl status binance-lite --no-pager || true
fi

echo ""
echo "Public IP (whitelist this on Binance API):"
curl -s https://api.ipify.org; echo
echo "App: http://$(curl -s https://api.ipify.org):3000"
echo "Security Group: open TCP 3000 (or 80 via Nginx) from your IP only."

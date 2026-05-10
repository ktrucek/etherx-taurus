#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$ROOT_DIR/src-tauri/target/release/bundle/deb"
STANDALONE_ENV="$ROOT_DIR/../standalone-browser/.env.local"

if [[ -f "$ROOT_DIR/.env.deploy" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.deploy"
fi

# Fallback: koristi postojeci standalone env da ne dupliciramo tajne po fajlovima.
if [[ -f "$STANDALONE_ENV" ]]; then
  # shellcheck disable=SC1091
  source "$STANDALONE_ENV"
fi

SKIP_BUILD=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      cat <<'USAGE'
Usage: ./deploy-tauri.sh [--skip-build] [--dry-run]

Required env vars:
  PROD_HOST              Remote server hostname or IP

Optional env vars:
  PROD_USER              SSH user (default: root)
  PROD_PORT              SSH port (default: 22)
  PROD_SSH_KEY           SSH private key path
  PROD_SSH_BATCH_MODE    true/false (default: false)
  PROD_UPLOAD_DIR        Remote upload dir (default: /tmp/etherx-tauri)
  PROD_SERVICE_NAME      systemd service name (default: etherx-browser)
  PROD_SERVICE_USER      systemd user (default: root)
  PROD_WORKING_DIR       systemd WorkingDirectory (default: /root)
  PROD_EXEC_START        systemd ExecStart (default: /usr/bin/xvfb-run -a /usr/bin/etherx-browser)
  PROD_INSTALL_SYSTEMD_UNIT true/false (default: true)
  PROD_START_COMMAND     Custom remote start command (optional)
  PROD_POST_DEPLOY       Extra remote command executed after install (optional)
  INSTALL_WITH_SUDO      true/false (default: true)

Fallback loading:
  - If present, script also loads ../standalone-browser/.env.local
  - Supported aliases: DEPLOY_HOST / ETHX_PROD_HOST -> PROD_HOST
  - Supported aliases: ETHX_SYSTEMD_SERVICE -> PROD_SERVICE_NAME

Examples:
  PROD_HOST=server.example.com ./deploy-tauri.sh
  PROD_HOST=1.2.3.4 PROD_USER=deploy PROD_SERVICE_NAME=etherx-browser ./deploy-tauri.sh
  ./deploy-tauri.sh --skip-build
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg"
      exit 1
      ;;
  esac
done

PROD_HOST="${PROD_HOST:-${DEPLOY_HOST:-${ETHX_PROD_HOST:-}}}"
PROD_USER="${PROD_USER:-root}"
PROD_PORT="${PROD_PORT:-22}"
PROD_SSH_KEY="${PROD_SSH_KEY:-}"
PROD_SSH_BATCH_MODE="${PROD_SSH_BATCH_MODE:-false}"
PROD_UPLOAD_DIR="${PROD_UPLOAD_DIR:-/tmp/etherx-tauri}"
PROD_SERVICE_NAME="${PROD_SERVICE_NAME:-${ETHX_SYSTEMD_SERVICE:-etherx-browser}}"
PROD_SERVICE_USER="${PROD_SERVICE_USER:-root}"
PROD_WORKING_DIR="${PROD_WORKING_DIR:-/root}"
PROD_EXEC_START="${PROD_EXEC_START:-/usr/bin/xvfb-run -a /usr/bin/etherx-browser}"
PROD_INSTALL_SYSTEMD_UNIT="${PROD_INSTALL_SYSTEMD_UNIT:-true}"
PROD_START_COMMAND="${PROD_START_COMMAND:-}"
PROD_POST_DEPLOY="${PROD_POST_DEPLOY:-}"
INSTALL_WITH_SUDO="${INSTALL_WITH_SUDO:-true}"

if [[ -z "$PROD_HOST" ]]; then
  echo "ERROR: PROD_HOST nije postavljen."
  echo "Primjer: PROD_HOST=your.server ./deploy-tauri.sh"
  exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[deploy-tauri]${NC} $*"; }
ok() { echo -e "${GREEN}[ok]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
fail() { echo -e "${RED}[fail]${NC} $*"; exit 1; }

run_cmd() {
  if [[ "$DRY_RUN" == true ]]; then
    echo "[dry-run] $*"
  else
    eval "$@"
  fi
}

SSH_OPTS=("-p" "$PROD_PORT" "-o" "StrictHostKeyChecking=accept-new")
if [[ "$PROD_SSH_BATCH_MODE" == true ]]; then
  SSH_OPTS+=("-o" "BatchMode=yes")
fi
if [[ -n "$PROD_SSH_KEY" ]]; then
  SSH_OPTS+=("-i" "$PROD_SSH_KEY")
fi

SCP_OPTS=("-P" "$PROD_PORT" "-o" "StrictHostKeyChecking=accept-new")
if [[ "$PROD_SSH_BATCH_MODE" == true ]]; then
  SCP_OPTS+=("-o" "BatchMode=yes")
fi
if [[ -n "$PROD_SSH_KEY" ]]; then
  SCP_OPTS+=("-i" "$PROD_SSH_KEY")
fi

REMOTE="${PROD_USER}@${PROD_HOST}"

if [[ "$SKIP_BUILD" != true ]]; then
  info "Buildam Tauri release paket..."
  run_cmd "cd \"$ROOT_DIR\" && npm run build"
  ok "Build zavrsen."
else
  warn "Preskacem build (--skip-build)."
fi

DEB_FILE="$(ls -1t "$BUILD_DIR"/*.deb 2>/dev/null | head -n 1 || true)"
if [[ -z "$DEB_FILE" ]]; then
  fail "Nisam nasao .deb paket u $BUILD_DIR"
fi

DEB_NAME="$(basename "$DEB_FILE")"
info "Koristim paket: $DEB_NAME"

info "Kopiram paket na produkciju ($REMOTE)..."
if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] ssh ${SSH_OPTS[*]} \"$REMOTE\" \"mkdir -p '$PROD_UPLOAD_DIR'\""
  echo "[dry-run] scp ${SCP_OPTS[*]} \"$DEB_FILE\" \"$REMOTE:$PROD_UPLOAD_DIR/$DEB_NAME\""
else
  ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p '$PROD_UPLOAD_DIR'"
  scp "${SCP_OPTS[@]}" "$DEB_FILE" "$REMOTE:$PROD_UPLOAD_DIR/$DEB_NAME"
fi
ok "Upload zavrsen."

if [[ "$INSTALL_WITH_SUDO" == true ]]; then
  SUDO_PREFIX="sudo"
else
  SUDO_PREFIX=""
fi

REMOTE_INSTALL=$(cat <<EOF
set -euo pipefail
cd "$PROD_UPLOAD_DIR"
if ! $SUDO_PREFIX dpkg -i "$DEB_NAME"; then
  $SUDO_PREFIX apt-get update -y
  $SUDO_PREFIX apt-get install -f -y
  $SUDO_PREFIX dpkg -i "$DEB_NAME"
fi
EOF
)

info "Instaliram paket na produkciji..."
if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] ssh ${SSH_OPTS[*]} \"$REMOTE\" '<remote install script>'"
else
  ssh "${SSH_OPTS[@]}" "$REMOTE" "$REMOTE_INSTALL"
fi
ok "Instalacija zavrsena."

if [[ -n "$PROD_SERVICE_NAME" ]]; then
  if [[ "$PROD_INSTALL_SYSTEMD_UNIT" == true ]]; then
    info "Kreiram/azuriram systemd unit: $PROD_SERVICE_NAME.service"
    REMOTE_UNIT_SCRIPT=$(cat <<EOF
set -euo pipefail
if ! command -v xvfb-run >/dev/null 2>&1; then
  $SUDO_PREFIX apt-get update -y
  $SUDO_PREFIX apt-get install -y xvfb
fi
cat > /tmp/${PROD_SERVICE_NAME}.service <<'UNITEOF'
[Unit]
Description=EtherX Browser (Tauri) headless session
After=network.target

[Service]
Type=simple
User=${PROD_SERVICE_USER}
WorkingDirectory=${PROD_WORKING_DIR}
ExecStart=${PROD_EXEC_START}
Restart=always
RestartSec=3
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target
UNITEOF

$SUDO_PREFIX mv /tmp/${PROD_SERVICE_NAME}.service /etc/systemd/system/${PROD_SERVICE_NAME}.service
$SUDO_PREFIX chmod 644 /etc/systemd/system/${PROD_SERVICE_NAME}.service
$SUDO_PREFIX systemctl daemon-reload
EOF
)

    if [[ "$DRY_RUN" == true ]]; then
      echo "[dry-run] ssh ${SSH_OPTS[*]} \"$REMOTE\" '<remote systemd unit install script>'"
    else
      ssh "${SSH_OPTS[@]}" "$REMOTE" "$REMOTE_UNIT_SCRIPT"
    fi
    ok "Systemd unit postavljen: $PROD_SERVICE_NAME.service"
  fi

  info "Restartam systemd servis: $PROD_SERVICE_NAME"
  if [[ "$DRY_RUN" == true ]]; then
    echo "[dry-run] ssh ${SSH_OPTS[*]} \"$REMOTE\" \"$SUDO_PREFIX systemctl daemon-reload || true; $SUDO_PREFIX systemctl enable '$PROD_SERVICE_NAME' || true; $SUDO_PREFIX systemctl restart '$PROD_SERVICE_NAME'; $SUDO_PREFIX systemctl status '$PROD_SERVICE_NAME' --no-pager -n 30 || true\""
  else
    if ssh "${SSH_OPTS[@]}" "$REMOTE" "$SUDO_PREFIX systemctl list-unit-files --type=service | grep -q '^${PROD_SERVICE_NAME}\\.service'"; then
      ssh "${SSH_OPTS[@]}" "$REMOTE" "$SUDO_PREFIX systemctl daemon-reload || true; $SUDO_PREFIX systemctl enable '$PROD_SERVICE_NAME' || true; $SUDO_PREFIX systemctl restart '$PROD_SERVICE_NAME'; $SUDO_PREFIX systemctl status '$PROD_SERVICE_NAME' --no-pager -n 30 || true"
      ok "Servis restartan: $PROD_SERVICE_NAME"
    else
      warn "Servis ${PROD_SERVICE_NAME}.service ne postoji na serveru - preskacem restart."
    fi
  fi
fi

if [[ -n "$PROD_START_COMMAND" ]]; then
  info "Pokrecem custom start komandu..."
  if [[ "$DRY_RUN" == true ]]; then
    echo "[dry-run] ssh ${SSH_OPTS[*]} \"$REMOTE\" \"$PROD_START_COMMAND\""
  else
    ssh "${SSH_OPTS[@]}" "$REMOTE" "$PROD_START_COMMAND"
  fi
  ok "Custom start komanda izvrsena."
fi

if [[ -n "$PROD_POST_DEPLOY" ]]; then
  info "Izvrsavam post-deploy komandu..."
  if [[ "$DRY_RUN" == true ]]; then
    echo "[dry-run] ssh ${SSH_OPTS[*]} \"$REMOTE\" \"$PROD_POST_DEPLOY\""
  else
    ssh "${SSH_OPTS[@]}" "$REMOTE" "$PROD_POST_DEPLOY"
  fi
  ok "Post-deploy izvrsen."
fi

if [[ -z "$PROD_SERVICE_NAME" && -z "$PROD_START_COMMAND" ]]; then
  warn "Paket je deployan i instaliran, ali nije definisan restart/start korak."
  warn "Postavi PROD_SERVICE_NAME ili PROD_START_COMMAND za automatsko pokretanje."
fi

ok "Deploy zavrsen: $DEB_NAME -> $REMOTE"

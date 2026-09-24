#!/usr/bin/env bash
set -euo pipefail

# PolyRoot Agent — One-line Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/cryptyroot-ux/polyroot-agent/main/scripts/install.sh | bash

REPO="cryptyroot-ux/polyroot-agent"
BRANCH="main"
INSTALL_DIR="${HOME}/.polyroot"
BIN_DIR="${HOME}/.local/bin"
VERSION="latest"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${BLUE}[polyroot]${NC} $*"; }
ok() { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err() { echo -e "${RED}✗${NC} $*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "Missing dependency: $1"; exit 1; }
}

detect_pkg_mgr() {
  if command -v apt-get >/dev/null; then echo "apt"
  elif command -v dnf >/dev/null; then echo "dnf"
  elif command -v pacman >/dev/null; then echo "pacman"
  elif command -v brew >/dev/null; then echo "brew"
  else echo "unknown"; fi
}

install_node24() {
  log "Installing Node.js 24..."
  if command -v nvm >/dev/null; then
    nvm install 24 && nvm use 24 && nvm alias default 24
    ok "Node.js 24 via nvm"
  elif command -v fnm >/dev/null; then
    fnm install 24 && fnm use 24 && fnm default 24
    ok "Node.js 24 via fnm"
  else
    case "$(detect_pkg_mgr)" in
      apt) curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs ;;
      dnf) curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash - && sudo dnf install -y nodejs ;;
      pacman) sudo pacman -S --needed nodejs-lts-iron npm ;;
      brew) brew install node@24 ;;
      *) err "Unsupported package manager. Install Node.js 24 manually: https://nodejs.org"; exit 1 ;;
    esac
    ok "Node.js 24 installed"
  fi
}

install_pg() {
  log "Installing PostgreSQL 15..."
  case "$(detect_pkg_mgr)" in
    apt) sudo apt-get update && sudo apt-get install -y postgresql-15 postgresql-client-15 ;;
    dnf) sudo dnf install -y postgresql15-server postgresql15 ;;
    pacman) sudo pacman -S --needed postgresql ;;
    brew) brew install postgresql@15 ;;
    *) warn "Install PostgreSQL 15 manually"; return ;;
  esac
  ok "PostgreSQL installed"
}

setup_pg() {
  log "Setting up database..."
  if command -v systemctl >/dev/null; then
    sudo systemctl enable --now postgresql 2>/dev/null || true
  elif command -v brew >/dev/null; then
    brew services start postgresql@15 2>/dev/null || true
  fi
  sleep 2
  sudo -u postgres psql -c "CREATE USER polyroot WITH SUPERUSER PASSWORD 'polyroot';" 2>/dev/null || true
  sudo -u postgres psql -c "CREATE DATABASE polyroot OWNER polyroot;" 2>/dev/null || true
  ok "Database ready: postgresql://polyroot:polyroot@localhost:5432/polyroot"
}

clone_repo() {
  log "Cloning PolyRoot Agent..."
  rm -rf "${INSTALL_DIR}"
  git clone --branch "${BRANCH}" --depth 1 "https://github.com/${REPO}.git" "${INSTALL_DIR}"
  ok "Cloned to ${INSTALL_DIR}"
}

install_deps() {
  log "Installing dependencies (this may take a minute)..."
  cd "${INSTALL_DIR}"
  npm ci
  ok "Dependencies installed"
}

build() {
  log "Building all packages..."
  cd "${INSTALL_DIR}"
  npm run build
  ok "Build complete"
}

link_binary() {
  log "Linking 'polyroot' command..."
  mkdir -p "${BIN_DIR}"
  cat > "${BIN_DIR}/polyroot" <<'EOF'
#!/usr/bin/env bash
# PolyRoot Agent launcher — delegates to installed copy
exec "${HOME}/.polyroot/node_modules/.bin/tsx" "${HOME}/.polyroot/src/pm/runtime/src/cli.ts" "$@"
EOF
  chmod +x "${BIN_DIR}/polyroot"
  # Ensure ~/.local/bin is in PATH
  case "${SHELL##*/}" in
    bash) RC="${HOME}/.bashrc" ;;
    zsh) RC="${HOME}/.zshrc" ;;
    fish) RC="${HOME}/.config/fish/config.fish" ;;
    *) RC="" ;;
  esac
  if [[ -n "${RC}" ]] && ! grep -q '\.local/bin' "${RC}" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "${RC}"
    log "Added ~/.local/bin to PATH in ${RC}"
  fi
  ok "Binary linked: ~/.local/bin/polyroot"
}

print_next_steps() {
  echo
  echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  PolyRoot Agent installed successfully!${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
  echo
  echo -e "${BLUE}Next:${NC} Open a NEW terminal (or run: source ~/.bashrc)"
  echo -e "Then type: ${YELLOW}polyroot start${NC}"
  echo
  echo -e "${BLUE}First run will launch interactive onboarding:${NC}"
  echo "  1. Choose AI provider & model (OpenAI, 9Router, Ollama, etc.)"
  echo "  2. Create new wallet or import existing (keystore encrypted)"
  echo "  3. Select mode: PAPER (safe) or LIVE (real money)"
  echo
  echo -e "${BLUE}Config stored in:${NC} ~/.polyroot/.env (auto-generated)"
  echo -e "${BLUE}Wallet keystore:${NC} ~/.polyroot/keystore.json (encrypted, 600 perms)"
  echo
  echo -e "${BLUE}Docs:${NC} https://github.com/${REPO}"
  echo
}

main() {
  echo -e "${BLUE}"
  echo "╔══════════════════════════════════════════════╗"
  echo "║     PolyRoot Agent — Quick Installer       ║"
  echo "║   Autonomous AI Trading for Polymarket     ║"
  echo "╚══════════════════════════════════════════════╝"
  echo -e "${NC}"

  require_cmd git
  require_cmd curl

  # Node.js 24 check
  if ! node --version 2>/dev/null | grep -qE '^v2[4-9]\.'; then
    install_node24
  else
    ok "Node.js $(node --version) already installed"
  fi

  # PostgreSQL check
  if ! command -v psql >/dev/null || ! psql --version | grep -qE ' 1[5-9]\.'; then
    install_pg
    setup_pg
  else
    ok "PostgreSQL $(psql --version | awk '{print $3}') already installed"
    setup_pg
  fi

  clone_repo
  install_deps
  build
  link_binary
  print_next_steps
}

main "$@"
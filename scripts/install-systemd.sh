#!/usr/bin/env bash
# PolyRoot Agent — systemd installer (24/7 autonomous operation).
# Renders scripts/polyroot.service.template and installs it as
# /etc/systemd/system/polyroot.service, then enables + starts it.
#
# Usage:
#   scripts/install-systemd.sh [--home DIR] [--user NAME] [--node BIN] [--print]
#
#   --home DIR   install dir (default: $HOME/.polyroot)
#   --user NAME  OS user to run as (default: ${SUDO_USER:-$(id -un)})
#   --node BIN   node binary (default: first `node` on PATH)
#   --print      render to stdout only (no install; for inspection/tests)
#
# Test hook: SYSTEMD_DIR overrides the destination dir. When it is anything
# other than /etc/systemd/system, sudo/daemon-reload/enable/start are skipped
# and the unit is written plainly (no root required).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/polyroot.service.template"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
UNIT="polyroot.service"

HOME_DIR="${HOME}/.polyroot"
RUN_USER="${SUDO_USER:-$(id -un)}"
NODE_BIN="$(command -v node || echo /usr/bin/node)"
PRINT_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --home) HOME_DIR="$2"; shift 2 ;;
    --user) RUN_USER="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --print) PRINT_ONLY=1; shift ;;
    *) echo "Unknown flag: $1 (see header)" >&2; exit 1 ;;
  esac
done

[[ -f "${TEMPLATE}" ]] || { echo "Template missing: ${TEMPLATE}" >&2; exit 1; }
[[ -x "${NODE_BIN}" ]] || { echo "node not executable: ${NODE_BIN}" >&2; exit 1; }

render() {
  sed -e "s|{{POLYROOT_USER}}|${RUN_USER}|g" \
      -e "s|{{POLYROOT_HOME}}|${HOME_DIR}|g" \
      -e "s|{{NODE_BIN}}|${NODE_BIN}|g" \
      "${TEMPLATE}"
}

if [[ "${PRINT_ONLY}" == "1" ]]; then
  render
  exit 0
fi

if [[ "${SYSTEMD_DIR}" == "/etc/systemd/system" ]]; then
  # Real install: needs root + a PID-1 systemd (skipped in containers/WSL).
  if [[ "$(ps -p 1 -o comm= 2>/dev/null | tr -d ' ')" != "systemd" ]]; then
    echo "[polyroot] No PID-1 systemd detected — skipping service install." >&2
    echo "[polyroot] Start the agent manually: polyroot run" >&2
    exit 0
  fi
  SUDO=""
  [[ "$(id -u)" == "0" ]] || SUDO="sudo"
  render | ${SUDO} tee "${SYSTEMD_DIR}/${UNIT}" >/dev/null
  ${SUDO} chmod 644 "${SYSTEMD_DIR}/${UNIT}"
  ${SUDO} systemctl daemon-reload
  # Clear stale failure state (e.g. an older unit pointing at moved paths).
  ${SUDO} systemctl reset-failed "${UNIT%.service}" 2>/dev/null || true
  ${SUDO} systemctl enable "${UNIT%.service}" >/dev/null
  if [[ -f "${HOME_DIR}/.env" ]]; then
    ${SUDO} systemctl restart "${UNIT%.service}"
    echo "[polyroot] Service installed, enabled, and started: systemctl status polyroot"
  else
    echo "[polyroot] Service installed + enabled (starts on boot)."
    echo "[polyroot] No ${HOME_DIR}/.env yet — run: polyroot setup"
    echo "[polyroot] Then start the 24/7 loop: sudo systemctl start polyroot"
  fi
else
  mkdir -p "${SYSTEMD_DIR}"
  render > "${SYSTEMD_DIR}/${UNIT}"
  echo "[polyroot] Rendered unit to ${SYSTEMD_DIR}/${UNIT} (test mode, systemd untouched)"
fi

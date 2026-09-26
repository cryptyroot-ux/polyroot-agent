#!/usr/bin/env bash
# PolyRoot Agent launcher — delegates to the installed copy.
# Runs the compiled CLI (dist) with node: no tsx, no build step, no CWD games.
# Installed to ~/.local/bin/polyroot by scripts/install.sh and refreshed by
# `polyroot update`, so already-installed users heal automatically.
# Override the install location (dev checkouts) via POLYROOT_AGENT_DIR.
AGENT_DIR="${POLYROOT_AGENT_DIR:-${HOME}/.polyroot}"
if [[ ! -d "${AGENT_DIR}" ]]; then
  echo "Error: PolyRoot Agent installation directory not found: ${AGENT_DIR}" >&2
  exit 1
fi

export NODE_ENV=production
export POLYROOT_AGENT_DIR="${AGENT_DIR}"
cd "${AGENT_DIR}" && exec node "${AGENT_DIR}/src/pm/runtime/dist/cli.js" "$@"

#!/usr/bin/env bash
set -euo pipefail

# agent-bridge installer
# Usage: curl -fsSL https://raw.githubusercontent.com/EthanSK/agent-bridge/main/install.sh | bash

REPO="https://raw.githubusercontent.com/EthanSK/agent-bridge/main/agent-bridge"
INSTALL_DIR="/usr/local/bin"
BIN_NAME="agent-bridge"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

printf '\n'
printf "${BOLD}${CYAN}  agent-bridge installer${RESET}\n"
printf '\n'

# Check for curl or wget
if command -v curl >/dev/null 2>&1; then
  FETCH="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then
  FETCH="wget -qO-"
else
  printf "${RED}  Error: curl or wget required.${RESET}\n"
  exit 1
fi

# Download
printf "${DIM}  Downloading agent-bridge...${RESET}\n"
TMPFILE="$(mktemp)"
$FETCH "$REPO" > "$TMPFILE"

# Install
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMPFILE" "$INSTALL_DIR/$BIN_NAME"
  chmod +x "$INSTALL_DIR/$BIN_NAME"
else
  printf "${DIM}  Installing to %s (requires sudo)...${RESET}\n" "$INSTALL_DIR"
  sudo mv "$TMPFILE" "$INSTALL_DIR/$BIN_NAME"
  sudo chmod +x "$INSTALL_DIR/$BIN_NAME"
fi

# Create backward-compat symlink
if [ -w "$INSTALL_DIR" ]; then
  ln -sf "$INSTALL_DIR/$BIN_NAME" "$INSTALL_DIR/claude-bridge" 2>/dev/null || true
else
  sudo ln -sf "$INSTALL_DIR/$BIN_NAME" "$INSTALL_DIR/claude-bridge" 2>/dev/null || true
fi

printf '\n'
printf "${GREEN}${BOLD}  [ok] agent-bridge installed to %s/%s${RESET}\n" "$INSTALL_DIR" "$BIN_NAME"
printf '\n'
printf "  Get started:\n"
printf "${DIM}    agent-bridge setup${RESET}\n"
printf "${DIM}    agent-bridge help${RESET}\n"
printf '\n'

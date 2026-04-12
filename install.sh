#!/usr/bin/env bash
set -euo pipefail

# claude-bridge installer
# Usage: curl -fsSL https://raw.githubusercontent.com/EthanSK/claude-bridge/main/install.sh | bash

REPO="https://raw.githubusercontent.com/EthanSK/claude-bridge/main/claude-bridge"
INSTALL_DIR="/usr/local/bin"
BIN_NAME="claude-bridge"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

printf '\n'
printf "${BOLD}${CYAN}  claude-bridge installer${RESET}\n"
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
printf "${DIM}  Downloading claude-bridge...${RESET}\n"
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

printf '\n'
printf "${GREEN}${BOLD}  [ok] claude-bridge installed to %s/%s${RESET}\n" "$INSTALL_DIR" "$BIN_NAME"
printf '\n'
printf "  Get started:\n"
printf "${DIM}    claude-bridge setup${RESET}\n"
printf "${DIM}    claude-bridge help${RESET}\n"
printf '\n'

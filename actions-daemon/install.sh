#!/bin/bash
# Installer for the agent-bridge actions daemon.
# See README.md for what this does and does not do.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.ethansk.agent-bridge-actions"
PLIST_SRC="${HERE}/${LABEL}.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
WATCHER="${HERE}/watcher.sh"
ACTIONS_DIR="${HOME}/.agent-bridge/actions"

[ -f "$PLIST_SRC" ] || { echo "missing: $PLIST_SRC" >&2; exit 1; }
[ -f "$WATCHER" ]  || { echo "missing: $WATCHER"  >&2; exit 1; }

chmod +x "$WATCHER"

mkdir -p "$ACTIONS_DIR"
chmod 700 "$ACTIONS_DIR"

mkdir -p "${HOME}/Library/LaunchAgents"

# Substitute the install dir placeholder in the plist before installing.
sed "s|__INSTALL_DIR__|${HERE}|g" "$PLIST_SRC" >"$PLIST_DST"
chmod 644 "$PLIST_DST"

plutil -lint "$PLIST_DST" >/dev/null

# Reload (unload first in case an old version is running).
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

cat <<MSG

agent-bridge actions daemon installed.

  label:       ${LABEL}
  plist:       ${PLIST_DST}
  watcher:     ${WATCHER}
  inbox:       ${ACTIONS_DIR}
  log:         ${HOME}/.agent-bridge/actions.log
  launchd log: /tmp/agent-bridge-actions.log

ONE-TIME ACCESSIBILITY GRANT (required):
  Open System Settings -> Privacy & Security -> Accessibility,
  click +, and add /bin/bash (located at /bin/bash).
  System Events needs this to post keystrokes into the target app.
  Without it the daemon will run but every action returns a -1719 error.

Test from the paired machine:
  agent-bridge send-action <this-machine-name> send-enter

MSG

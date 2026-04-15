#!/bin/bash
# Uninstaller for the agent-bridge actions daemon.
# Leaves ~/.agent-bridge/ in place because agent-bridge itself uses it.

set -euo pipefail

LABEL="com.ethansk.agent-bridge-actions"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [ -f "$PLIST_DST" ]; then
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  rm -f "$PLIST_DST"
  echo "removed: $PLIST_DST"
else
  echo "not installed: $PLIST_DST"
fi

echo "actions daemon uninstalled. ~/.agent-bridge/ left intact."

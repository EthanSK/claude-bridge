#!/bin/bash
# agent-bridge actions daemon watcher.
# Watches ~/.agent-bridge/actions/ for JSON action files and executes a
# closed set of osascript GUI actions inside the Aqua login session.
#
# This script is intentionally small. If you are reviewing it to confirm it
# is not a keylogger: it NEVER reads keyboard input, NEVER captures the
# screen, and NEVER opens network sockets. It only reads files that already
# exist on disk under $ACTIONS_DIR, dispatches to the handlers below, and
# deletes the file.

set -u  # do not use -e: we never want the daemon to exit on a handler error

ACTIONS_DIR="${HOME}/.agent-bridge/actions"
LOG_FILE="${HOME}/.agent-bridge/actions.log"
DEFAULT_TARGET_APP="Claude"
LOG_MAX_LINES=500

mkdir -p "$ACTIONS_DIR"
chmod 700 "$ACTIONS_DIR" 2>/dev/null || true

log() {
  # Append an operational line. We DO NOT log the content of send-text args —
  # only a fixed label so debugging is possible without recording keystrokes.
  local ts
  ts="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  printf '%s %s\n' "$ts" "$*" >>"$LOG_FILE" 2>/dev/null || true
  # Rotate by truncating to the tail N lines.
  if [ -f "$LOG_FILE" ]; then
    local lines
    lines="$(wc -l <"$LOG_FILE" 2>/dev/null || printf '0')"
    if [ "${lines:-0}" -gt "$LOG_MAX_LINES" ]; then
      local tmp="${LOG_FILE}.tmp"
      tail -n "$LOG_MAX_LINES" "$LOG_FILE" >"$tmp" 2>/dev/null && mv "$tmp" "$LOG_FILE"
    fi
  fi
}

# -- handlers -----------------------------------------------------------------
# Each handler is a thin wrapper over osascript with a FIXED command body.
# Only $target (window / app name) is interpolated, and it is sanitised to
# alphanumerics + space + dot + dash + underscore before use.

sanitise_target() {
  # Keep a narrow charset. Reject anything else by stripping.
  printf '%s' "$1" | LC_ALL=C tr -cd 'A-Za-z0-9 ._-'
}

sanitise_text() {
  # For send-text we accept printable ASCII only, and strip quotes + backslashes
  # so the value can't break out of the AppleScript string literal.
  printf '%s' "$1" | LC_ALL=C tr -d '\\"`$' | LC_ALL=C tr -cd '\t -~'
}

activate_and_run() {
  local target="$1" body="$2"
  # Wrap in a 3s AppleScript timeout. Without this, `tell application "X" to
  # activate` can hang for ~120s trying to launch an app that doesn't exist,
  # which blocks the daemon from processing any further action files.
  osascript -e "with timeout of 3 seconds
    tell application \"${target}\" to activate
    delay 0.1
    tell application \"System Events\" to tell process \"${target}\" to ${body}
  end timeout"
}

handle_send_enter() {
  local target="${1:-$DEFAULT_TARGET_APP}"
  target="$(sanitise_target "$target")"
  [ -z "$target" ] && target="$DEFAULT_TARGET_APP"
  activate_and_run "$target" 'keystroke return'
  return $?
}

handle_send_text() {
  local text="$1" target="${2:-$DEFAULT_TARGET_APP}"
  target="$(sanitise_target "$target")"
  [ -z "$target" ] && target="$DEFAULT_TARGET_APP"
  text="$(sanitise_text "$text")"
  [ -z "$text" ] && return 2
  activate_and_run "$target" "keystroke \"${text}\""
  return $?
}

handle_send_ctrl_c() {
  local target="${1:-$DEFAULT_TARGET_APP}"
  target="$(sanitise_target "$target")"
  [ -z "$target" ] && target="$DEFAULT_TARGET_APP"
  # keycode 8 = "c". 'using control down' sends Ctrl+C.
  activate_and_run "$target" 'keystroke "c" using control down'
  return $?
}

# -- dispatch -----------------------------------------------------------------

dispatch_file() {
  local file="$1"
  [ -f "$file" ] || return 0

  local action target text rc
  if ! command -v jq >/dev/null 2>&1; then
    log "error jq-missing file=$(basename "$file")"
    rm -f "$file" 2>/dev/null || true
    return 0
  fi

  action="$(jq -r '.action // empty' "$file" 2>/dev/null)"
  target="$(jq -r '.target // empty' "$file" 2>/dev/null)"
  text="$(jq -r '.args[0] // empty' "$file" 2>/dev/null)"

  case "$action" in
    send-enter)
      handle_send_enter "$target"; rc=$?
      log "action=send-enter target=${target:-$DEFAULT_TARGET_APP} rc=$rc"
      ;;
    send-text)
      handle_send_text "$text" "$target"; rc=$?
      log "action=send-text target=${target:-$DEFAULT_TARGET_APP} rc=$rc"
      ;;
    send-ctrl-c)
      handle_send_ctrl_c "$target"; rc=$?
      log "action=send-ctrl-c target=${target:-$DEFAULT_TARGET_APP} rc=$rc"
      ;;
    '')
      log "error empty-action file=$(basename "$file")"
      ;;
    *)
      log "error unknown-action=$action file=$(basename "$file")"
      ;;
  esac

  rm -f "$file" 2>/dev/null || true
}

process_pending() {
  local f
  for f in "$ACTIONS_DIR"/*.json; do
    [ -e "$f" ] || continue
    dispatch_file "$f" || true
  done
}

# Simple 2-second poll loop. Considered fswatch but the bash `while read -d ''`
# pipeline was unreliable under launchd on this machine (events emitted but not
# consumed). Poll is dead-simple, adds at most 2s of latency to an action, and
# doesn't depend on an external binary's I/O buffering behaviour. Fine for the
# use case (human-initiated unblock of a stuck prompt is not latency-sensitive).
log "watcher started backend=poll"
while true; do
  process_pending || true
  sleep 2
done

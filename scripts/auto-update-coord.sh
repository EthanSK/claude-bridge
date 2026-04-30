#!/usr/bin/env bash
#
# agent-bridge/scripts/auto-update-coord.sh
# -------------------------------------------------
# [AUTO-UPDATE-COORD-LOCK 2026-04-30]
#
# Same-host coordination helper for auto-update receivers. Multiple harnesses on
# one host (Claude Code, OpenClaw personas, etc.) may all see the same
# [BRIDGE-UPDATE-AVAILABLE] notification. This helper lets exactly one receiver
# perform the git pull + npm build + plugin reload for a given checkout while
# the others observe and report that another local receiver is already handling
# it.
#
# Lock scope: same host + one source checkout. The checkout path is canonicalized
# and hashed so independent clones coordinate independently.
#
# Default paths:
#   ~/.agent-bridge/locks/auto-update.<sha256(realpath(source-dir))>.lock
#   ~/.agent-bridge/locks/auto-update.<sha256(realpath(source-dir))>.state
#
# Usage:
#   scripts/auto-update-coord.sh run --source-dir "$PWD" --cycle <origin-sha> -- \
#     ./scripts/update.sh --auto
#
#   scripts/auto-update-coord.sh acquire --source-dir "$PWD" --cycle <origin-sha>
#   scripts/auto-update-coord.sh release --source-dir "$PWD" --token <token> --exit-code 0
#   scripts/auto-update-coord.sh status --source-dir "$PWD" --cycle <origin-sha>
#
# Environment overrides:
#   AGENT_BRIDGE_AUTO_UPDATE_STALE_LOCK_MS   default 1800000 (30 minutes)
#   AGENT_BRIDGE_AUTO_UPDATE_MIN_RETRY_MS    default 300000  (5 minutes)
#   AGENT_BRIDGE_LOCK_DIR                    default ~/.agent-bridge/locks
#
# Exit codes:
#   0  acquired / released / command succeeded
#   2  usage error
#   70 internal/filesystem error
#   73 another local receiver holds the lock
#   74 release attempted by a non-owner token
#   75 minimum retry interval has not elapsed for this cycle

set -uo pipefail

EX_USAGE=2
EX_INTERNAL=70
EX_LOCKED=73
EX_NOT_OWNER=74
EX_MIN_INTERVAL=75

SCRIPT_SRC="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_SRC" ]; do
  DIR="$(cd -P "$(dirname "$SCRIPT_SRC")" && pwd)"
  SCRIPT_SRC="$(readlink "$SCRIPT_SRC")"
  [[ "$SCRIPT_SRC" != /* ]] && SCRIPT_SRC="$DIR/$SCRIPT_SRC"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SRC")" && pwd)"
DEFAULT_SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

COMMAND="${1:-}"
if [[ -z "$COMMAND" ]]; then
  COMMAND="help"
else
  shift || true
fi

SOURCE_DIR=""
CYCLE=""
TOKEN_ARG=""
EXIT_CODE_ARG=""
PLAIN=0
VERBOSE=0
# Preferred env names are millisecond-based to match
# AGENT_BRIDGE_AUTO_UPDATE_INTERVAL_MS from the probe timer. The older *_SEC
# names remain accepted as compatibility aliases, but the *_MS values win when
# both are present.
MIN_RETRY_MS="${AGENT_BRIDGE_AUTO_UPDATE_MIN_RETRY_MS:-}"
STALE_LOCK_MS="${AGENT_BRIDGE_AUTO_UPDATE_STALE_LOCK_MS:-}"
MIN_INTERVAL_SEC="${AGENT_BRIDGE_AUTO_UPDATE_MIN_INTERVAL_SEC:-}"
STALE_AFTER_SEC="${AGENT_BRIDGE_AUTO_UPDATE_STALE_AFTER_SEC:-}"
MIN_INTERVAL=""
STALE_AFTER=""
MIN_RETRY_MS_EFFECTIVE=""
STALE_LOCK_MS_EFFECTIVE=""
LOCK_ROOT="${AGENT_BRIDGE_LOCK_DIR:-$HOME/.agent-bridge/locks}"
RUN_ARGS=()

usage() {
  sed -n '2,40p' "$0"
}

is_uint() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

ms_to_seconds_ceil() {
  local ms="$1"
  if ! is_uint "$ms"; then
    return 1
  fi
  if (( ms <= 0 )); then
    printf '0'
  else
    printf '%s' $(((ms + 999) / 1000))
  fi
}

resolve_duration_seconds() {
  local ms_value="$1"
  local sec_value="$2"
  local default_ms="$3"
  if is_uint "$ms_value"; then
    ms_to_seconds_ceil "$ms_value"
    return 0
  fi
  if is_uint "$sec_value"; then
    printf '%s' "$sec_value"
    return 0
  fi
  ms_to_seconds_ceil "$default_ms"
}

now_epoch() { date +%s; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

warn() { echo "auto-update-coord: $*" >&2; }
verbose() { if (( VERBOSE )); then warn "$*"; fi; }


json_escape() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\r'/ }"
  value="${value//$'\n'/ }"
  value="${value//$'\t'/ }"
  printf '%s' "$value"
}

json_string_field() {
  local key="$1"
  local value="${2:-}"
  printf '"%s":"%s"' "$key" "$(json_escape "$value")"
}

json_number_field() {
  local key="$1"
  local value="${2:-0}"
  if is_uint "$value"; then
    printf '"%s":%s' "$key" "$value"
  else
    json_string_field "$key" "$value"
  fi
}

coord_context_json() {
  local extra="${1:-}"
  printf '{'
  json_string_field source_dir "${SOURCE_DIR:-}"
  printf ','
  json_string_field cycle "${CYCLE:-}"
  printf ','
  json_string_field lock_path "${LOCK_PATH:-}"
  printf ','
  json_string_field state_path "${STATE_PATH:-}"
  printf ','
  json_number_field pid "$$"
  printf ','
  json_number_field stale_lock_ms "${STALE_LOCK_MS_EFFECTIVE:-0}"
  printf ','
  json_number_field min_retry_ms "${MIN_RETRY_MS_EFFECTIVE:-0}"
  if [[ -n "$extra" ]]; then
    printf ',%s' "$extra"
  fi
  printf '}'
}

log_coord_event() {
  local event="$1"
  local level="$2"
  local msg="$3"
  local extra="${4:-}"

  local logs_dir="$HOME/.agent-bridge/logs"
  mkdir -p "$logs_dir" 2>/dev/null || return 0
  chmod 700 "$logs_dir" 2>/dev/null || true

  local log_file="$logs_dir/agent-bridge.log"
  if [[ -f "$log_file" ]]; then
    local size
    size="$(stat -f%z "$log_file" 2>/dev/null || stat -c%s "$log_file" 2>/dev/null || printf 0)"
    if is_uint "$size" && (( size > 50 * 1024 * 1024 )); then
      mv "$log_file" "$log_file.1" 2>/dev/null || true
    fi
  fi

  local ts host context
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  host="$(hostname 2>/dev/null | sed 's/\.local$//' || printf unknown)"
  context="$(coord_context_json "$extra")"

  printf '{"ts":"%s","component":"auto-update-coord","machine":"%s","event":"%s","level":"%s","msg":"%s","context":%s}\n' \
    "$ts" "$(json_escape "$host")" "$(json_escape "$event")" "$(json_escape "$level")" "$(json_escape "$msg")" "$context" \
    >> "$log_file" 2>/dev/null || true
}

canonical_dir() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    warn "source dir does not exist: $dir"
    return 1
  fi
  (cd "$dir" && pwd -P)
}

hash_string() {
  local value="$1"
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$value" | shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$value" | sha256sum | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    printf '%s' "$value" | openssl dgst -sha256 | awk '{print $NF}'
  else
    # Last-resort fallback. cksum is not cryptographic, but still separates
    # ordinary checkout paths if sha256 tooling is unexpectedly unavailable.
    printf '%s' "$value" | cksum | awk '{print $1}'
  fi
}

kv_get() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" 2>/dev/null | tail -1
}

write_state_file() {
  local tmp="$STATE_PATH.tmp.$$.$RANDOM"
  {
    printf 'source_dir=%s\n' "$SOURCE_DIR"
    printf 'lock_path=%s\n' "$LOCK_PATH"
    printf 'state_path=%s\n' "$STATE_PATH"
    printf 'last_attempt_epoch=%s\n' "${STATE_LAST_ATTEMPT_EPOCH:-}"
    printf 'last_attempt_iso=%s\n' "${STATE_LAST_ATTEMPT_ISO:-}"
    printf 'last_attempt_cycle=%s\n' "${STATE_LAST_ATTEMPT_CYCLE:-}"
    printf 'last_holder_token=%s\n' "${STATE_LAST_HOLDER_TOKEN:-}"
    printf 'last_success_epoch=%s\n' "${STATE_LAST_SUCCESS_EPOCH:-}"
    printf 'last_success_iso=%s\n' "${STATE_LAST_SUCCESS_ISO:-}"
    printf 'last_success_cycle=%s\n' "${STATE_LAST_SUCCESS_CYCLE:-}"
    printf 'last_failure_epoch=%s\n' "${STATE_LAST_FAILURE_EPOCH:-}"
    printf 'last_failure_iso=%s\n' "${STATE_LAST_FAILURE_ISO:-}"
    printf 'last_failure_cycle=%s\n' "${STATE_LAST_FAILURE_CYCLE:-}"
    printf 'last_exit_code=%s\n' "${STATE_LAST_EXIT_CODE:-}"
  } > "$tmp" || return 1
  mv -f "$tmp" "$STATE_PATH"
}

load_state_defaults() {
  STATE_LAST_ATTEMPT_EPOCH="$(kv_get "$STATE_PATH" last_attempt_epoch)"
  STATE_LAST_ATTEMPT_ISO="$(kv_get "$STATE_PATH" last_attempt_iso)"
  STATE_LAST_ATTEMPT_CYCLE="$(kv_get "$STATE_PATH" last_attempt_cycle)"
  STATE_LAST_HOLDER_TOKEN="$(kv_get "$STATE_PATH" last_holder_token)"
  STATE_LAST_SUCCESS_EPOCH="$(kv_get "$STATE_PATH" last_success_epoch)"
  STATE_LAST_SUCCESS_ISO="$(kv_get "$STATE_PATH" last_success_iso)"
  STATE_LAST_SUCCESS_CYCLE="$(kv_get "$STATE_PATH" last_success_cycle)"
  STATE_LAST_FAILURE_EPOCH="$(kv_get "$STATE_PATH" last_failure_epoch)"
  STATE_LAST_FAILURE_ISO="$(kv_get "$STATE_PATH" last_failure_iso)"
  STATE_LAST_FAILURE_CYCLE="$(kv_get "$STATE_PATH" last_failure_cycle)"
  STATE_LAST_EXIT_CODE="$(kv_get "$STATE_PATH" last_exit_code)"
}

init_paths() {
  MIN_INTERVAL="$(resolve_duration_seconds "$MIN_RETRY_MS" "$MIN_INTERVAL_SEC" 300000)"
  STALE_AFTER="$(resolve_duration_seconds "$STALE_LOCK_MS" "$STALE_AFTER_SEC" 1800000)"
  MIN_RETRY_MS_EFFECTIVE=$((MIN_INTERVAL * 1000))
  STALE_LOCK_MS_EFFECTIVE=$((STALE_AFTER * 1000))

  if [[ -z "$SOURCE_DIR" ]]; then
    SOURCE_DIR="$DEFAULT_SOURCE_DIR"
  fi
  SOURCE_DIR="$(canonical_dir "$SOURCE_DIR")" || exit "$EX_USAGE"

  local hash
  hash="$(hash_string "$SOURCE_DIR")"
  mkdir -p "$LOCK_ROOT" || {
    warn "could not create lock dir: $LOCK_ROOT"
    exit "$EX_INTERNAL"
  }
  LOCK_PATH="$LOCK_ROOT/auto-update.$hash.lock"
  STATE_PATH="$LOCK_ROOT/auto-update.$hash.state"
}

lock_age_seconds() {
  local now started
  now="$(now_epoch)"
  started="$(kv_get "$LOCK_PATH" started_epoch)"
  if ! is_uint "$started"; then
    printf '0'
    return 0
  fi
  if (( now >= started )); then
    printf '%s' $((now - started))
  else
    printf '0'
  fi
}

reclaim_stale_lock_if_needed() {
  [[ -f "$LOCK_PATH" ]] || return 0

  local age
  age="$(lock_age_seconds)"
  if (( age <= STALE_AFTER )); then
    return 1
  fi

  local guard="$LOCK_PATH.reclaim"
  if ! mkdir "$guard" 2>/dev/null; then
    return 1
  fi

  # We hold the reclaim guard now. Re-check the age in case another process
  # refreshed/reclaimed while we were waiting.
  if [[ -f "$LOCK_PATH" ]]; then
    age="$(lock_age_seconds)"
    if (( age > STALE_AFTER )); then
      local stale_path="$LOCK_PATH.stale.$(now_epoch).$RANDOM"
      local old_token old_started old_cycle
      old_token="$(kv_get "$LOCK_PATH" token)"
      old_started="$(kv_get "$LOCK_PATH" started_iso)"
      old_cycle="$(kv_get "$LOCK_PATH" cycle)"
      mv -f "$LOCK_PATH" "$stale_path" 2>/dev/null || rm -f "$LOCK_PATH" 2>/dev/null || true
      log_coord_event "auto_update_coord.reclaimed_stale" "warn" "reclaimed stale auto-update coord lock" "$(json_number_field lock_age_sec "$age"),$(json_string_field stale_path "$stale_path"),$(json_string_field holder_token "$old_token"),$(json_string_field holder_started_iso "$old_started"),$(json_string_field holder_cycle "$old_cycle")"
      verbose "reclaimed stale lock older than ${STALE_AFTER}s: $LOCK_PATH"
    fi
  fi

  rmdir "$guard" 2>/dev/null || true
  return 0
}

min_interval_gate_allows() {
  load_state_defaults

  if (( MIN_INTERVAL <= 0 )); then
    return 0
  fi
  if ! is_uint "$STATE_LAST_ATTEMPT_EPOCH"; then
    return 0
  fi

  # The retry gate is cycle-aware when a cycle is provided. A new origin/main
  # SHA should not be blocked by the prior SHA's failure/success, but repeated
  # attempts for the same SHA should not spin in tight loops.
  if [[ -n "$CYCLE" && -n "$STATE_LAST_ATTEMPT_CYCLE" && "$STATE_LAST_ATTEMPT_CYCLE" != "$CYCLE" ]]; then
    return 0
  fi

  local now age remaining
  now="$(now_epoch)"
  if (( now < STATE_LAST_ATTEMPT_EPOCH )); then
    return 0
  fi
  age=$((now - STATE_LAST_ATTEMPT_EPOCH))
  if (( age >= MIN_INTERVAL )); then
    return 0
  fi

  remaining=$((MIN_INTERVAL - age))
  log_coord_event "auto_update_coord.skipped_retry_gate" "warn" "minimum retry interval active for auto-update coord" "$(json_number_field elapsed_sec "$age"),$(json_number_field remaining_sec "$remaining"),$(json_string_field last_attempt_iso "$STATE_LAST_ATTEMPT_ISO"),$(json_string_field last_attempt_cycle "$STATE_LAST_ATTEMPT_CYCLE")"
  warn "minimum retry interval active for cycle '${CYCLE:-<none>}' (${age}s elapsed, ${remaining}s remaining, min=${MIN_INTERVAL}s). state=$STATE_PATH"
  return "$EX_MIN_INTERVAL"
}

write_lock_metadata() {
  local token="$1"
  local tmp_content
  tmp_content="$(mktemp "$LOCK_ROOT/auto-update-lock.XXXXXX" 2>/dev/null || printf '%s' "$LOCK_ROOT/auto-update-lock.$$.$RANDOM")"
  {
    printf 'token=%s\n' "$token"
    printf 'pid=%s\n' "$$"
    printf 'ppid=%s\n' "${PPID:-}"
    printf 'host=%s\n' "$(hostname 2>/dev/null || printf unknown)"
    printf 'started_epoch=%s\n' "$(now_epoch)"
    printf 'started_iso=%s\n' "$(now_iso)"
    printf 'cycle=%s\n' "$CYCLE"
    printf 'source_dir=%s\n' "$SOURCE_DIR"
  } > "$tmp_content" || return 1

  # noclobber redirection is the atomic claim. We avoid depending on flock(1),
  # which is absent on stock macOS.
  if ( set -o noclobber; cat "$tmp_content" > "$LOCK_PATH" ) 2>/dev/null; then
    rm -f "$tmp_content" 2>/dev/null || true
    return 0
  fi
  rm -f "$tmp_content" 2>/dev/null || true
  return 1
}

record_attempt_state() {
  local token="$1"
  load_state_defaults
  STATE_LAST_ATTEMPT_EPOCH="$(now_epoch)"
  STATE_LAST_ATTEMPT_ISO="$(now_iso)"
  STATE_LAST_ATTEMPT_CYCLE="$CYCLE"
  STATE_LAST_HOLDER_TOKEN="$token"
  write_state_file
}

record_release_state() {
  local exit_code="$1"
  load_state_defaults
  STATE_LAST_EXIT_CODE="$exit_code"
  if [[ "$exit_code" == "0" ]]; then
    STATE_LAST_SUCCESS_EPOCH="$(now_epoch)"
    STATE_LAST_SUCCESS_ISO="$(now_iso)"
    STATE_LAST_SUCCESS_CYCLE="$CYCLE"
  else
    STATE_LAST_FAILURE_EPOCH="$(now_epoch)"
    STATE_LAST_FAILURE_ISO="$(now_iso)"
    STATE_LAST_FAILURE_CYCLE="$CYCLE"
  fi
  write_state_file
}

acquire_lock() {
  reclaim_stale_lock_if_needed || {
    local token started age cycle
    token="$(kv_get "$LOCK_PATH" token)"
    started="$(kv_get "$LOCK_PATH" started_iso)"
    cycle="$(kv_get "$LOCK_PATH" cycle)"
    age="$(lock_age_seconds)"
    log_coord_event "auto_update_coord.skipped_locked" "warn" "another local receiver holds the auto-update coord lock" "$(json_string_field reason "held"),$(json_number_field lock_age_sec "$age"),$(json_string_field holder_token "$token"),$(json_string_field holder_started_iso "$started"),$(json_string_field holder_cycle "$cycle")"
    warn "another local receiver holds the auto-update lock (age=${age}s, started=${started:-unknown}, cycle=${cycle:-<none>}, token=${token:-unknown}). lock=$LOCK_PATH"
    return "$EX_LOCKED"
  }

  min_interval_gate_allows || return "$?"

  local token
  token="$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
  if write_lock_metadata "$token"; then
    if ! record_attempt_state "$token"; then
      rm -f "$LOCK_PATH" 2>/dev/null || true
      warn "failed to write state file: $STATE_PATH"
      return "$EX_INTERNAL"
    fi
    ACQUIRED_TOKEN="$token"
    log_coord_event "auto_update_coord.acquired" "info" "acquired auto-update coord lock" "$(json_string_field token "$token")"
    return 0
  fi

  local age started cycle held_token
  age="$(lock_age_seconds)"
  started="$(kv_get "$LOCK_PATH" started_iso)"
  cycle="$(kv_get "$LOCK_PATH" cycle)"
  held_token="$(kv_get "$LOCK_PATH" token)"
  log_coord_event "auto_update_coord.skipped_locked" "warn" "another local receiver won the auto-update coord lock" "$(json_string_field reason "race"),$(json_number_field lock_age_sec "$age"),$(json_string_field holder_token "$held_token"),$(json_string_field holder_started_iso "$started"),$(json_string_field holder_cycle "$cycle")"
  warn "another local receiver won the auto-update lock (age=${age}s, started=${started:-unknown}, cycle=${cycle:-<none>}, token=${held_token:-unknown}). lock=$LOCK_PATH"
  return "$EX_LOCKED"
}

release_lock() {
  local token="$1"
  local exit_code="${2:-0}"
  if [[ -z "$token" ]]; then
    warn "release requires --token"
    return "$EX_USAGE"
  fi
  if ! is_uint "$exit_code"; then
    exit_code=1
  fi
  if [[ ! -f "$LOCK_PATH" ]]; then
    verbose "lock already absent: $LOCK_PATH"
    load_state_defaults
    if [[ "$STATE_LAST_HOLDER_TOKEN" == "$token" ]]; then
      record_release_state "$exit_code" || true
    fi
    return 0
  fi

  local held_token
  held_token="$(kv_get "$LOCK_PATH" token)"
  if [[ "$held_token" != "$token" ]]; then
    warn "not releasing lock owned by another token (held=${held_token:-unknown}, mine=$token). lock=$LOCK_PATH"
    return "$EX_NOT_OWNER"
  fi

  local age
  age="$(lock_age_seconds)"
  record_release_state "$exit_code" || true
  rm -f "$LOCK_PATH" 2>/dev/null || {
    warn "failed to remove lock: $LOCK_PATH"
    return "$EX_INTERNAL"
  }
  log_coord_event "auto_update_coord.released" "info" "released auto-update coord lock" "$(json_string_field token "$token"),$(json_number_field exit_code "$exit_code"),$(json_number_field held_sec "$age")"
  return 0
}

status_report() {
  local lock_state="free"
  local age=""
  local held_token=""
  local started=""
  local lock_cycle=""

  if [[ -f "$LOCK_PATH" ]]; then
    age="$(lock_age_seconds)"
    held_token="$(kv_get "$LOCK_PATH" token)"
    started="$(kv_get "$LOCK_PATH" started_iso)"
    lock_cycle="$(kv_get "$LOCK_PATH" cycle)"
    if (( age > STALE_AFTER )); then
      lock_state="stale"
    else
      lock_state="held"
    fi
  fi

  load_state_defaults

  if (( PLAIN )); then
    printf 'source_dir=%s\n' "$SOURCE_DIR"
    printf 'lock_path=%s\n' "$LOCK_PATH"
    printf 'state_path=%s\n' "$STATE_PATH"
    printf 'lock_state=%s\n' "$lock_state"
    printf 'lock_age_sec=%s\n' "$age"
    printf 'lock_token=%s\n' "$held_token"
    printf 'lock_started_iso=%s\n' "$started"
    printf 'lock_cycle=%s\n' "$lock_cycle"
    printf 'stale_lock_ms=%s\n' "$STALE_LOCK_MS_EFFECTIVE"
    printf 'min_retry_ms=%s\n' "$MIN_RETRY_MS_EFFECTIVE"
    printf 'last_attempt_epoch=%s\n' "$STATE_LAST_ATTEMPT_EPOCH"
    printf 'last_attempt_iso=%s\n' "$STATE_LAST_ATTEMPT_ISO"
    printf 'last_attempt_cycle=%s\n' "$STATE_LAST_ATTEMPT_CYCLE"
    printf 'last_success_iso=%s\n' "$STATE_LAST_SUCCESS_ISO"
    printf 'last_failure_iso=%s\n' "$STATE_LAST_FAILURE_ISO"
    printf 'last_exit_code=%s\n' "$STATE_LAST_EXIT_CODE"
  else
    cat <<EOF
source dir:       $SOURCE_DIR
lock path:        $LOCK_PATH
state path:       $STATE_PATH
lock state:       $lock_state
lock age:         ${age:-n/a}s
lock started:     ${started:-n/a}
lock cycle:       ${lock_cycle:-n/a}
stale lock:       ${STALE_LOCK_MS_EFFECTIVE}ms
min retry:        ${MIN_RETRY_MS_EFFECTIVE}ms
last attempt:     ${STATE_LAST_ATTEMPT_ISO:-n/a} (${STATE_LAST_ATTEMPT_CYCLE:-no-cycle})
last success:     ${STATE_LAST_SUCCESS_ISO:-n/a} (${STATE_LAST_SUCCESS_CYCLE:-no-cycle})
last failure:     ${STATE_LAST_FAILURE_ISO:-n/a} (${STATE_LAST_FAILURE_CYCLE:-no-cycle})
last exit code:   ${STATE_LAST_EXIT_CODE:-n/a}
EOF
  fi
}

parse_common_args() {
  while (( $# )); do
    case "$1" in
      --source-dir=*) SOURCE_DIR="${1#--source-dir=}"; shift ;;
      --source-dir) SOURCE_DIR="${2:-}"; shift 2 ;;
      --cycle=*) CYCLE="${1#--cycle=}"; shift ;;
      --cycle) CYCLE="${2:-}"; shift 2 ;;
      --token=*) TOKEN_ARG="${1#--token=}"; shift ;;
      --token) TOKEN_ARG="${2:-}"; shift 2 ;;
      --exit-code=*) EXIT_CODE_ARG="${1#--exit-code=}"; shift ;;
      --exit-code) EXIT_CODE_ARG="${2:-}"; shift 2 ;;
      --min-retry-ms=*|--min-interval-ms=*) MIN_RETRY_MS="${1#*=}"; shift ;;
      --min-retry-ms|--min-interval-ms) MIN_RETRY_MS="${2:-}"; shift 2 ;;
      --stale-lock-ms=*|--stale-after-ms=*) STALE_LOCK_MS="${1#*=}"; shift ;;
      --stale-lock-ms|--stale-after-ms) STALE_LOCK_MS="${2:-}"; shift 2 ;;
      --min-interval-sec=*) MIN_INTERVAL_SEC="${1#--min-interval-sec=}"; shift ;;
      --min-interval-sec) MIN_INTERVAL_SEC="${2:-}"; shift 2 ;;
      --stale-after-sec=*) STALE_AFTER_SEC="${1#--stale-after-sec=}"; shift ;;
      --stale-after-sec) STALE_AFTER_SEC="${2:-}"; shift 2 ;;
      --plain) PLAIN=1; shift ;;
      -v|--verbose) VERBOSE=1; shift ;;
      --)
        shift
        RUN_ARGS=("$@")
        return 0
        ;;
      -h|--help) usage; exit 0 ;;
      *) warn "unknown arg: $1"; exit "$EX_USAGE" ;;
    esac
  done
}

case "$COMMAND" in
  acquire)
    parse_common_args "$@"
    init_paths
    acquire_lock
    rc="$?"
    if (( rc == 0 )); then
      printf 'AGENT_BRIDGE_AUTO_UPDATE_TOKEN=%s\n' "$ACQUIRED_TOKEN"
      printf 'AGENT_BRIDGE_AUTO_UPDATE_LOCK=%s\n' "$LOCK_PATH"
      printf 'AGENT_BRIDGE_AUTO_UPDATE_STATE=%s\n' "$STATE_PATH"
      printf 'AGENT_BRIDGE_AUTO_UPDATE_SOURCE_DIR=%s\n' "$SOURCE_DIR"
      printf 'AGENT_BRIDGE_AUTO_UPDATE_CYCLE=%s\n' "$CYCLE"
      exit 0
    fi
    exit "$rc"
    ;;

  release)
    parse_common_args "$@"
    init_paths
    release_lock "$TOKEN_ARG" "${EXIT_CODE_ARG:-0}"
    exit "$?"
    ;;

  run)
    parse_common_args "$@"
    init_paths
    if (( ${#RUN_ARGS[@]} == 0 )); then
      warn "run requires -- followed by a command"
      exit "$EX_USAGE"
    fi
    acquire_lock
    rc="$?"
    if (( rc != 0 )); then
      exit "$rc"
    fi
    export AGENT_BRIDGE_AUTO_UPDATE_TOKEN="$ACQUIRED_TOKEN"
    export AGENT_BRIDGE_AUTO_UPDATE_LOCK="$LOCK_PATH"
    export AGENT_BRIDGE_AUTO_UPDATE_STATE="$STATE_PATH"
    export AGENT_BRIDGE_AUTO_UPDATE_SOURCE_DIR="$SOURCE_DIR"
    export AGENT_BRIDGE_AUTO_UPDATE_CYCLE="$CYCLE"

    run_status=0
    cleanup() {
      local status="$1"
      release_lock "$ACQUIRED_TOKEN" "$status" || true
    }
    interrupt_cleanup() {
      local status="$1"
      cleanup "$status"
      trap - EXIT INT TERM
      exit "$status"
    }
    trap 'cleanup "$run_status"' EXIT
    trap 'run_status=130; interrupt_cleanup "$run_status"' INT
    trap 'run_status=143; interrupt_cleanup "$run_status"' TERM
    "${RUN_ARGS[@]}"
    run_status="$?"
    cleanup "$run_status"
    trap - EXIT INT TERM
    exit "$run_status"
    ;;

  status)
    parse_common_args "$@"
    init_paths
    status_report
    exit 0
    ;;

  help|-h|--help)
    usage
    exit 0
    ;;

  *)
    warn "unknown command: $COMMAND"
    usage >&2
    exit "$EX_USAGE"
    ;;
esac

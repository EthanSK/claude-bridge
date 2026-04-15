# agent-bridge actions daemon

A tiny, auditable macOS user LaunchAgent that lets a paired machine remotely
trigger a **fixed, closed set** of GUI keystroke actions on this machine.

## Purpose

The primary and only intended use case is: **auto-pressing Enter (or typing
`y`, `n`, or Ctrl+C) on a Claude Code CLI session that is stuck on an
interactive yes/no permission prompt**, when that session is running on
*this* Mac and the human operating it is sitting at the *other* Mac.

Nothing else. If a future use case requires more actions, that requires a
code change, a review, and a re-install. This is by design.

## Why a LaunchAgent?

On macOS, `osascript` calls that use `System Events` (which is how you post
synthetic keystrokes to another app) will **fail with error `-609` /
`-1719` when invoked from an SSH session**. SSH sessions are not attached
to the Aqua login session that `System Events` will talk to.

So the paired machine can't just SSH in and run `osascript`. Instead:

1. The paired machine (over SSH, authenticated by the existing agent-bridge
   SSH keypair) drops a small JSON file into `~/.agent-bridge/actions/`.
2. A user LaunchAgent — running *inside the Aqua session* at login —
   notices the new file, validates it against a hard-coded allowlist, and
   runs the corresponding `osascript` incantation.
3. The action file is deleted.

That's the entire design.

## What it DOES

- Watches a single directory: `~/.agent-bridge/actions/` (mode `0700`).
- Dispatches new `*.json` files to one of three hard-coded handlers.
- Deletes the action file after dispatch.
- Appends a **one-line** operational log entry to `~/.agent-bridge/actions.log`
  recording the action type, target window name, and `osascript` exit code.

## What it does NOT do

This is **not** a keylogger. To be explicit:

- It does **not** read keyboard input or listen for keystrokes.
- It does **not** record the screen, take screenshots, or access the
  clipboard.
- It does **not** open network sockets, listen on any port, make any HTTP
  request, or phone home.
- It does **not** run arbitrary shell commands. The only things it will
  ever execute are the three `osascript` invocations defined inline in
  `watcher.sh`. Inspect them yourself — they are short.
- It does **not** log the content of what it is asked to type. For
  `send-text` actions, the operational log records only that a `send-text`
  happened, never the text itself.
- It does **not** touch anything outside `~/.agent-bridge/actions/` and
  `~/.agent-bridge/actions.log`.

## Supported actions

| action         | osascript effect                             | args              |
|----------------|----------------------------------------------|-------------------|
| `send-enter`   | `keystroke return` to target app             | none              |
| `send-text`    | `keystroke "<sanitised text>"` to target app | `[text]`          |
| `send-ctrl-c`  | `keystroke "c" using control down`           | none              |

All three route to the same `activate_and_run` helper in `watcher.sh`,
which `activate`s the target app first then sends the keystroke via
`System Events`. The target defaults to the app named `Claude`; a
different name can be passed per-action via the `target` JSON field.

Inputs are sanitised before being interpolated into AppleScript:

- `target` is stripped to `[A-Za-z0-9 ._-]`.
- `send-text` argument is stripped of `\` `"` `` ` `` `$` and limited to
  printable ASCII + tab, so it can't break out of the AppleScript string
  literal or inject additional commands.

Adding an action requires editing the `case` statement in `watcher.sh`,
re-installing, and (if the new action uses a new System Events API) the
user may need to re-confirm the Accessibility grant. This is intentional.

## Action file schema

Written to `~/.agent-bridge/actions/<uuid>.json` with mode `0600`:

```json
{
  "id": "msg-<uuid>",
  "action": "send-enter",
  "target": "Claude",
  "args": [],
  "timestamp": "2026-04-14T12:34:56Z"
}
```

`send-text` example:

```json
{
  "id": "msg-<uuid>",
  "action": "send-text",
  "target": "Claude",
  "args": ["y"],
  "timestamp": "2026-04-14T12:34:56Z"
}
```

Unknown `action` values are logged as `error unknown-action=...` and the
file is deleted without side effects.

## Security / threat model

- **Delivery is SSH-authenticated.** Action files land in
  `~/.agent-bridge/actions/` by way of the same SSH keypair and paired
  config that the rest of agent-bridge uses. An attacker who can write
  into that directory is already logged in as the user.
- **No network listener.** The daemon does not bind any port. It only
  reads the local filesystem.
- **Closed allowlist.** Arbitrary `action` values are rejected. Arbitrary
  `target` values are sanitised to a safe charset. `send-text` payloads
  are stripped of quote / backslash / backtick / `$` before being handed
  to `osascript`.
- **File perms.** The inbox is created `0700`. Individual action files
  land `0600` (the SSH writer controls this; the installer enforces the
  directory perm).
- **Accessibility grant is scoped.** macOS requires you to explicitly
  grant `/bin/bash` (i.e. the watcher process) Accessibility access the
  first time. Revoke it in System Settings to instantly disable the
  daemon without uninstalling.

## Privacy

- No telemetry, no third-party calls, no analytics, no remote logging.
- `~/.agent-bridge/actions.log` stores the last ~500 lines of
  `timestamp action=<type> target=<window> rc=<exit>` and nothing else.
  `send-text` contents are **never** written to disk anywhere.
- `launchd` stdout/stderr go to `/tmp/agent-bridge-actions.log` and are
  limited to daemon lifecycle chatter (fswatch start, poll fallback).

## Installation

Prereqs: macOS, `bash`, `jq`, `fswatch` (optional — poll fallback if
absent), and the agent-bridge CLI already paired to the other machine.

```sh
cd ~/Projects/agent-bridge/actions-daemon
./install.sh
```

The installer will:

1. Create `~/.agent-bridge/actions/` with mode `0700`.
2. `sed`-replace `__INSTALL_DIR__` in the plist and copy it to
   `~/Library/LaunchAgents/com.ethansk.agent-bridge-actions.plist`.
3. `plutil -lint` the plist.
4. `launchctl load` it.

### One-time Accessibility grant

macOS will refuse `System Events` keystrokes until you explicitly approve
the process:

1. Open **System Settings -> Privacy & Security -> Accessibility**.
2. Click **+**.
3. Add **`/bin/bash`** (Cmd+Shift+G inside the file picker, paste
   `/bin/bash`).
4. Ensure the toggle is on.

Without this, every action will return a non-zero exit code and the log
will show `rc=1` lines. There is **no way to automate this** — Apple
requires a human click.

## Uninstallation

```sh
cd ~/Projects/agent-bridge/actions-daemon
./uninstall.sh
```

This unloads the LaunchAgent and deletes the plist. It deliberately does
**not** delete `~/.agent-bridge/` because that directory is shared with
the rest of agent-bridge (SSH keys, inbox, config).

## How it integrates with agent-bridge

On the **sending** machine:

```sh
agent-bridge send-action <remote-machine> send-enter
agent-bridge send-action <remote-machine> send-text y
agent-bridge send-action <remote-machine> send-text y --target "Claude"
agent-bridge send-action <remote-machine> send-ctrl-c
```

Under the hood, `send-action` builds the JSON described above and pipes
it over SSH to `cat > ~/.agent-bridge/actions/<id>.json` on the remote,
reusing the existing paired SSH key and host/user/port from the
agent-bridge config.

On the **receiving** machine, the LaunchAgent picks it up within ~1s
(fswatch) or at most ~2s (poll fallback) and runs it.

## Code pointers

- [`watcher.sh`](./watcher.sh) — the daemon.
  - `sanitise_target` / `sanitise_text` — input hardening.
  - `activate_and_run` — the only place that calls `osascript`.
  - `handle_send_enter` / `handle_send_text` / `handle_send_ctrl_c` —
    the three handlers.
  - `dispatch_file` — the `case` statement that is the full public
    surface of this daemon.
- [`com.ethansk.agent-bridge-actions.plist`](./com.ethansk.agent-bridge-actions.plist) —
  launchd manifest. `LimitLoadToSessionType = Aqua` pins it to the GUI
  login session.
- [`install.sh`](./install.sh) / [`uninstall.sh`](./uninstall.sh) —
  installers.

## Troubleshooting

- **Actions log shows `rc=1` every time.** Accessibility grant missing or
  revoked. Re-add `/bin/bash` in System Settings -> Privacy & Security
  -> Accessibility.
- **Actions log shows `error jq-missing`.** Install jq: `brew install jq`.
- **No log entries at all after sending.** Confirm the LaunchAgent is
  loaded: `launchctl list | grep agent-bridge-actions`. Check
  `/tmp/agent-bridge-actions.log` for launchd output.
- **Target app doesn't receive the keystroke.** The app may be named
  something other than `Claude`. Pass `--target "My App"` to
  `send-action` (or whatever your terminal / CLI wrapper is actually
  called in the Dock).

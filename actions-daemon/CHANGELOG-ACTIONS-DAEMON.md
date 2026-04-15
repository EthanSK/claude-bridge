# Changelog — actions-daemon

All notable changes to the agent-bridge actions daemon subsystem.

## [0.1.0] — 2026-04-14

Initial release.

### Added
- `watcher.sh`: user LaunchAgent watcher that monitors
  `~/.agent-bridge/actions/` for JSON action files and dispatches them to
  a closed set of three handlers (`send-enter`, `send-text`,
  `send-ctrl-c`).
- `com.ethansk.agent-bridge-actions.plist`: launchd manifest with
  `RunAtLoad=true`, `KeepAlive=true`,
  `LimitLoadToSessionType=Aqua` so the daemon only ever runs inside the
  GUI login session (which is what `System Events` requires).
- `install.sh`: idempotent installer. Creates the inbox dir with mode
  `0700`, substitutes `__INSTALL_DIR__` in the plist, `plutil`-lints,
  and loads via `launchctl`.
- `uninstall.sh`: single-command removal. Leaves `~/.agent-bridge/`
  intact because it is shared with the rest of agent-bridge.
- Agent-bridge CLI integration (`agent-bridge send-action`): new
  subcommand that builds a JSON action file and SSH-streams it into the
  remote's `~/.agent-bridge/actions/<uuid>.json` using the existing
  paired SSH key.
- Extensive `README.md` covering purpose, what it does and does not do,
  supported actions, action file schema, security / threat model,
  privacy posture, install, Accessibility grant, uninstall, and
  troubleshooting.

### Design decisions
- **Closed allowlist.** Only three actions are supported. Adding a new
  action requires editing `watcher.sh` and reinstalling. This is
  deliberate to keep the surface auditable.
- **No `send-text` logging.** The operational log records that a
  `send-text` happened but never the text itself.
- **Target sanitisation.** Both `target` and `send-text` payloads are
  run through character-class filters before being interpolated into
  AppleScript.
- **Poll fallback.** `fswatch` is preferred, but if it is absent or
  exits, the watcher falls back to a 2-second poll loop so the daemon
  survives missing dependencies.
- **`/bin/bash` as the Accessibility target.** Using the system bash
  avoids churn if the user upgrades Homebrew. The trade-off is that any
  script the user runs via `/bin/bash` inherits the grant; since the
  user already has physical and SSH access to their own machine, this
  is not a meaningful escalation.

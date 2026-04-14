# agent-bridge OpenClaw channel plugin

The OpenClaw counterpart to the Claude Code agent-bridge channel plugin.

Watches `~/.agent-bridge/inbox/` and pushes incoming bridge messages into a
running OpenClaw agent session by invoking
`openclaw agent --to agent-bridge-<peer> --message <envelope>`. Messages arrive
as a new user turn formatted like:

```
<channel source="agent-bridge" from="MachineA" to="MachineB" message_id="..." ts="...">
content here
</channel>
```

This mirrors the Claude Code delivery format so agents on either side of the
bridge behave consistently.

## Two ways to run it

### 1. As an OpenClaw plugin (recommended for most users)

Installs into the gateway process so the watcher is running whenever the
OpenClaw gateway is running.

```bash
openclaw plugins install --link ~/Projects/agent-bridge/openclaw-plugin \
  --dangerously-force-unsafe-install
openclaw gateway restart
```

The `--dangerously-force-unsafe-install` flag is required because OpenClaw's
plugin security scanner flags any `child_process` usage as critical. This
plugin needs `child_process` to shell out to the host `openclaw` CLI — the
only stable, documented way to inject a new user turn into an existing agent
session. If you'd rather not bypass the scanner, use the standalone daemon
below.

Confirm it's loaded:

```bash
openclaw plugins list | grep agent-bridge
openclaw plugins inspect agent-bridge
```

### 2. As a standalone daemon (no plugin install required)

Run the bundled Node script directly — works identically without touching
OpenClaw's plugin system:

```bash
node ~/Projects/agent-bridge/openclaw-plugin/bin/agent-bridge-openclaw-inbox.js
```

Or wire it into launchd so it starts at login. Example
`~/Library/LaunchAgents/com.agent-bridge.openclaw.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agent-bridge.openclaw</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOUR_USERNAME/Projects/agent-bridge/openclaw-plugin/bin/agent-bridge-openclaw-inbox.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENCLAW_BIN</key>
    <string>/opt/homebrew/bin/openclaw</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>/tmp/agent-bridge-openclaw.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/agent-bridge-openclaw.err</string>
</dict>
</plist>
```

> launchd plists do **not** expand `$HOME` or `~` inside `ProgramArguments`.
> Replace `YOUR_USERNAME` with the actual macOS username (e.g. `ethansk` on the
> Mac Mini, `ethansarif-kattan` on the MacBook Pro). If you prefer to keep the
> plist portable, point `ProgramArguments` at a small shell-script wrapper you
> own (e.g. `~/bin/agent-bridge-openclaw`) that itself resolves `$HOME` and
> execs the node script.

Generate a plist with your current path already substituted:

```bash
cat > ~/Library/LaunchAgents/com.agent-bridge.openclaw.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agent-bridge.openclaw</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$HOME/Projects/agent-bridge/openclaw-plugin/bin/agent-bridge-openclaw-inbox.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>OPENCLAW_BIN</key><string>$(command -v openclaw)</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/agent-bridge-openclaw.log</string>
  <key>StandardErrorPath</key><string>/tmp/agent-bridge-openclaw.err</string>
</dict>
</plist>
PLIST
launchctl load ~/Library/LaunchAgents/com.agent-bridge.openclaw.plist
```

The heredoc expands `$HOME`, `$(command -v node)`, and `$(command -v openclaw)`
from your shell **before** the file is written, so the resulting plist contains
absolute paths with no placeholders left over.

## Configuration

Plugin config lives under `plugins.entries.agent-bridge` in
`~/.openclaw/openclaw.json`. Defaults are sensible, but you can override:

```json
{
  "plugins": {
    "entries": {
      "agent-bridge": {
        "enabled": true,
        "inboxDir": "/Users/me/.agent-bridge/inbox",
        "sessionKeyPrefix": "agent-bridge",
        "agentId": "main",
        "pollIntervalMs": 2000,
        "deliveryTimeoutSec": 600
      }
    }
  }
}
```

| Field | Default | What it does |
|-------|---------|--------------|
| `enabled` | `true` | Master on/off switch |
| `inboxDir` | `~/.agent-bridge/inbox` | Directory watched for new messages |
| `sessionKeyPrefix` | `agent-bridge` | Prefix used to derive the session key per peer |
| `agentId` | default agent | Which OpenClaw agent should receive the message |
| `pollIntervalMs` | `2000` | Polling interval when fswatch/inotifywait aren't available |
| `deliveryTimeoutSec` | `600` | Per-message agent-turn timeout (seconds) |

When running the standalone daemon, all of these are settable via env vars
(`AGENT_BRIDGE_INBOX_DIR`, `AGENT_BRIDGE_SESSION_PREFIX`, `AGENT_BRIDGE_AGENT_ID`,
`AGENT_BRIDGE_POLL_MS`, `AGENT_BRIDGE_TIMEOUT_SEC`).

## How delivery works

1. Peer machine's agent-bridge MCP server writes a message file to
   `~/.agent-bridge/inbox/msg-<uuid>.json` on this machine (via SSH).
2. This plugin/daemon's file watcher (`fswatch` / `inotifywait` / polling)
   sees the new file.
3. The plugin parses it, formats the `<channel>` envelope, and invokes
   `openclaw agent --to agent-bridge-<peer> --message <envelope>`.
4. OpenClaw routes the message to a session keyed on the peer machine, so
   each remote peer gets its own conversation thread.
5. On success, the message ID is appended to
   `~/.agent-bridge/.openclaw-delivered` so it isn't re-delivered if the
   plugin restarts.

Failed deliveries stay in the inbox for the next event loop (same retry
behaviour as the Claude Code channel plugin).

## Why shell out to `openclaw agent`?

Three options were considered:

1. **`api.runtime.agent.runEmbeddedAgent(...)`** — exists, but requires
   reconstructing ~40 params (sessionId, sessionFile, workspaceDir, runId,
   timeoutMs, onAssistantMessageStart, etc.) that the CLI composes internally.
   Fragile across versions.
2. **Custom channel plugin** — the "proper" way per the
   [Channel Plugin SDK docs](https://docs.openclaw.ai/plugins/sdk-channel-plugins),
   but requires implementing DM policy, pairing, outbound send, threading,
   mention gating, etc. Overkill for a local file-inbox.
3. **Shell out to `openclaw agent --to ... --message ...`** — the single
   stable, documented primitive that drives a full agent turn through the
   gateway (with embedded fallback). This is what we use.

## Troubleshooting

- **`openclaw plugins list` doesn't show agent-bridge** — run
  `openclaw gateway restart` and re-check. Plugins load at gateway startup.
- **Messages stay in the inbox but never get delivered** — check
  `openclaw gateway status`. The embedded fallback requires a working model
  provider; authentication failures cause delivery to fail silently and
  retry.
- **Recursion / infinite spawn** — fixed in v1.0.0 by the
  `AGENT_BRIDGE_PLUGIN_SKIP` env var. If you see runaway `openclaw` spawns,
  stop the gateway, upgrade the plugin, and restart.
- **Security scanner blocks install** — use
  `--dangerously-force-unsafe-install` or run the standalone daemon instead.

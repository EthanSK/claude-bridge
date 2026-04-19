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
| `targetAgent` | `main` | Default OpenClaw agent id for `agent-turn` mode (legacy: `agentId`) |
| `pollIntervalMs` | `2000` | Polling interval when fswatch/inotifywait aren't available |
| `deliveryTimeoutSec` | `600` | Per-message agent-turn timeout (seconds) |
| `deliveryMode` | `log-only` | `log-only` / `message-send` / `agent-turn` / `agent` — see "Delivery modes" below |
| `deliveryChannel` | `telegram` | Channel for `message-send` / `agent-turn` reply |
| `deliveryAccount` | _none_ | Channel account id (e.g. `default`, `clawdiboi2`) |
| `deliveryTarget` | _none_ | Default chat target id |
| `chatIdToAccount` | `{}` | Map of `chat_id → account` for auto-resolving the bot |

When running the standalone daemon, all of these are settable via env vars
(`AGENT_BRIDGE_INBOX_DIR`, `AGENT_BRIDGE_SESSION_PREFIX`, `AGENT_BRIDGE_AGENT_ID`,
`AGENT_BRIDGE_POLL_MS`, `AGENT_BRIDGE_TIMEOUT_SEC`,
`AGENT_BRIDGE_DELIVERY_MODE`, `AGENT_BRIDGE_DELIVERY_CHANNEL`,
`AGENT_BRIDGE_DELIVERY_ACCOUNT`, `AGENT_BRIDGE_DELIVERY_TARGET`,
`AGENT_BRIDGE_CHAT_ID_TO_ACCOUNT` as JSON map).

## Delivery modes

| Mode | Behaviour |
|------|-----------|
| `log-only` *(default)* | Parse + verify + archive. No agent invocation. The MCP tools path (`bridge_send_message` etc.) handles bidirectional comms; the inbox watcher just drains. |
| `message-send` | Shell out to `openclaw message send --channel <ch> --account <acc> --target <chat>`. Posts the bridge envelope as a message FROM the bot into a chat. Cheap, no agent turn. |
| `agent-turn` | Shell out to `openclaw agent --agent <id> --message <envelope> --deliver --reply-channel <ch> --reply-account <acc> --reply-to <chat>`. Runs a real agent turn; agent processes the message and posts its reply to the chat. Costs an agent turn per inbound message. **This is "OpenClaw actually responds."** |
| `agent` *(legacy)* | The old `openclaw agent --to <slug>` path. Flaky — kept for backward compat only. |

## Per-message routing

A single plugin instance can serve multiple Telegram bots (or other
channels) without separate config blocks. A `BridgeMessage` may specify
its target in two ways:

1. **Top-level `route` field on the message JSON:**
   ```json
   {
     "id": "msg-...",
     "from": "MacBookPro",
     "content": "actual body",
     "route": {
       "target_chat_id": "6164541473",
       "target_account": "clawdiboi2",
       "target_agent": "main",
       "target_channel": "telegram"
     }
   }
   ```
2. **Inline `@@route` header on the first line of `content`** (handy when
   sending via stock `bridge_send_message`):
   ```
   @@route target_chat_id=6164541473 target_account=clordlethird

   actual message body here
   ```
   Recognised keys: `target_chat_id` / `chat_id` / `to`,
   `target_account` / `account` / `bot`, `target_agent` / `agent`,
   `target_channel` / `channel`. The header is stripped before injection.

Plugin-config defaults (`deliveryAccount`, `deliveryTarget`,
`targetAgent`, `deliveryChannel`) fill in any missing field. A
`chatIdToAccount` map can resolve account from chat id automatically.

Full design notes in [ROUTING.md](./ROUTING.md).

## How delivery works

1. Peer machine's agent-bridge MCP server writes a message file to
   `~/.agent-bridge/inbox/msg-<uuid>.json` on this machine (via SSH).
2. This plugin/daemon's file watcher (`fswatch` / `inotifywait` / polling)
   sees the new file.
3. The plugin parses it, resolves routing (per-message `route` /
   `@@route` header / plugin defaults), strips any routing header from
   the body, and formats the `<channel>` envelope.
4. The plugin dispatches based on `deliveryMode`:
   - `log-only`: just acks + archives (default).
   - `message-send`: posts the envelope into the configured chat as a
     message FROM the bot.
   - `agent-turn`: runs a real `openclaw agent` turn with `--deliver`,
     so the agent processes the envelope and posts its reply into the
     configured chat.
5. On success, the message ID is appended to
   `~/.agent-bridge/.openclaw-delivered` and the inbox file is moved to
   `~/.agent-bridge/inbox/.openclaw-delivered/` so it isn't re-delivered
   on restart.

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

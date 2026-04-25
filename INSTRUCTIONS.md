# Agent Bridge -- Instructions for AI Agents

agent-bridge lets running agents send messages between paired machines over SSH, and optionally run plain diagnostic shell commands. Claude Code and OpenClaw are both tested, but they use different host models: Claude Code uses a unified MCP + experimental `claude/channel` stdio plugin; OpenClaw uses a separate native `openclaw-channel/` plugin under the OpenClaw gateway. Codex, Gemini CLI, Aider, and other MCP hosts are scaffolded until their receive/reply loops are verified.

## Quick reference

```bash
agent-bridge setup                              # Enable SSH, generate keys, show pairing screen
agent-bridge pair --name "X" --host IP --port 22 --user U --token T --pubkey "ssh-ed25519 ..."
agent-bridge list                               # List paired machines
agent-bridge status [machine]                   # Check reachability
agent-bridge run <machine> "command"            # Run a PLAIN shell command remotely (diagnostics only)
agent-bridge connect <machine>                  # Open interactive SSH session
agent-bridge unpair <machine>                   # Remove a pairing
```

> **Agent-to-agent communication is channel-mode only.** To talk to the running agent on another machine, use the `bridge_send_message` MCP tool — NOT a shell wrapper. The `--claude` / `--codex` / `--agent` flags on `agent-bridge run` were removed in 3.0.0 because they spawned a fresh non-interactive agent session on the remote machine, which defeats the whole point of this project (bridging EXISTING live sessions).

## Setup flow

1. Run `agent-bridge setup` on each machine. It enables SSH, generates an ED25519 key pair, and displays a pairing screen with connection details (IP, port, token, public key).
2. Share the pairing screen with the other machine's agent (e.g., photograph it and send the photo). The agent reads the image, extracts the details, and runs the pair command.
3. For bidirectional access, run pair on both machines with each other's details.

## Pairing from a photo

When given a photo of a pairing screen, extract these fields:
- Machine Name
- Username
- IP address (Local IP or Public IP)
- Port
- Token
- Public Key

Then run:
```bash
agent-bridge pair --name "<name>" --host "<ip>" --port <port> --user "<user>" --token "<token>" --pubkey "<pubkey>"
```

## Talking to the running remote agent

Use `bridge_send_message` from the MCP server. **As of mcp-server 3.4.0 the `target` parameter is REQUIRED** — there is no default routing:

```
bridge_send_message({ machine: "MacBook", message: "fix the failing tests", target: "claude-code" })
bridge_send_message({ machine: "MacBook", message: "what's up?",            target: "openclaw/clawdiboi2" })
```

Each target maps to a subdir under `~/.agent-bridge/inbox/` on the remote (`inbox/claude-code/`, `inbox/openclaw/clawdiboi2/`, …) and a specific listener picks it up:

- `target: "claude-code"` → Claude Code channel plugin pushes the message into the running Claude session as a `<channel source="agent-bridge" ...>` event.
- `target: "openclaw/<account>"` → openclaw-channel plugin dispatches the message into the OpenClaw Telegram session for `<account>` via `dispatchInboundReplyWithBase` from `openclaw/plugin-sdk/compat` — a synchronous agent turn runs and the reply is sent through the live Telegram outbound (landing in e.g. @Clawdiboi2bot) because the synthetic ctxPayload pins `OriginatingChannel: "telegram"`.

Calls without `target` are rejected. Legacy flat-file messages that land at the root of `inbox/` are moved to `inbox/.failed/_unrouted/` on next startup.

There is no fresh-spawn / `--print` equivalent. The old `agent-bridge run ... --claude` flag was removed in 3.0.0.

## Same-machine delivery (3.5.0+)

`bridge_send_message` accepts the **local machine name** (or one of the reserved aliases `local`, `self`, `localhost`) as its `machine` parameter. When the target is local, the message JSON is written directly to `~/.agent-bridge/inbox/<target>/<id>.json` using the same atomic write pattern as the SSH path — no SSH hop, no loopback round-trip.

```
bridge_send_message({ machine: "local",            message: "...", target: "openclaw/clawdiboi2" })
bridge_send_message({ machine: "Ethans-Mac-mini",  message: "...", target: "claude-code" })
```

Use it when one MCP host on a machine needs to fan a message out to another agent harness on the **same** machine — the canonical case is a Claude Code session sending to OpenClaw embedded Telegram sessions running in the same OpenClaw gateway. The receiver still needs a watcher running on its own per-target subdir: the Claude Code channel plugin watches `inbox/claude-code/`, `openclaw-channel` watches `inbox/openclaw/<account>/`. agent-bridge does not push the message into the receiver itself; it just lands the file atomically.

Design notes:

- The local machine is identified by either its real name (matched case-insensitively against `getLocalMachineName()`) or one of the reserved aliases. There is no per-machine `local = true` config flag — the local route is implicit and always available.
- Pairing a remote machine under one of those names is rejected up-front (CLI and MCP) so the local route cannot be shadowed.
- `bridge_status` reports the local pseudo-machine as `LOCAL (no SSH — same-machine delivery via inbox/<target>/)`. `bridge_list_machines` always lists it first.
- `bridge_run_command` and `agent-bridge run` reject local routing with a clear error — there is no SSH loopback. For local shell work, use the harness's regular shell tool.
- The success message returned by `bridge_send_message` includes `transport=local` for same-machine sends and `transport=ssh` for cross-machine sends, so callers can verify which path was taken.

## Architecture

- Config directory: `~/.agent-bridge/`
- Config file: `~/.agent-bridge/config` (INI-style, one `[section]` per machine)
- Keys: `~/.agent-bridge/keys/` (ED25519, mode 600)
- Inbox: `~/.agent-bridge/inbox/` — per-harness/per-target subdirs (3.4.0+):
  - `inbox/claude-code/` — watched by the Claude Code channel plugin
  - `inbox/openclaw/<target>/` — watched by the openclaw-channel plugin
  - `inbox/.archive/claude-code/` — delivered Claude Code messages retained for debug
  - `inbox/.failed/claude-code/` — malformed/misrouted Claude Code-target files
  - `inbox/.failed/_unrouted/` — legacy flat messages with no routable target, quarantined
  - `archive/openclaw/<target>/` — delivered OpenClaw messages retained for debug
  - `.openclaw-v2-delivered` — OpenClaw delivered-ID ledger
- Outbox: `~/.agent-bridge/outbox/` (copies of sent messages)
- Logs: `~/.agent-bridge/logs/` (MCP server logs, auto-rotated)
- No cloud -- SSH file transport, with Node-based MCP/channel plugins for agent integration

## MCP Server (agent-to-agent messaging)

The MCP server provides the shared `bridge_*` tools for EXISTING running agent sessions. Push delivery is host-specific: Claude Code uses the MCP server's `claude/channel` stdio path, while OpenClaw uses `openclaw-channel/`. It does NOT spawn new agent processes.

### MCP tools

| Tool | Description |
|------|-------------|
| `bridge_list_machines` | List paired machines and connection details |
| `bridge_status` | Check if a machine is reachable via SSH |
| `bridge_send_message` | Send a message to another machine's running agent |
| `bridge_receive_messages` | Manual inspection/consumption of the local Claude Code-target inbox |
| `bridge_run_command` | Run a shell command on a remote machine |
| `bridge_clear_inbox` | Clear the local inbox |
| `bridge_inbox_stats` | Get inbox statistics and watcher health |

### Claude Code channel plugin (3.6.0+)

When used with Claude Code, agent-bridge ships **two cooperating plugins**:

1. **`agent-bridge`** (the MCP server in [`mcp-server/`](mcp-server/)) — tools-only. Exposes `bridge_*` tools to the running session. The plugin host may respawn this stdio child between turns; it owns no long-lived state.
2. **`agent-bridge-channel`** (the channel host in [`claude-code-channel/`](claude-code-channel/)) — long-lived, session-scoped. Holds the `~/.agent-bridge/locks/claude-code.watcher-lock.json` lease, polls `~/.agent-bridge/inbox/claude-code/` at 2 s, and emits `notifications/claude/channel` back to the running session as:

```
<channel source="agent-bridge" from="MachineName" message_id="msg-xxx" ts="2026-01-01T00:00:00Z">
Message content here
</channel>
```

The agent responds using the `bridge_send_message` tool from the tools-only MCP server. The two plugins coordinate exclusively via the filesystem (inbox subdir + lease file); they do not talk to each other at runtime.

**Why split?** Pre-3.6.0 the channel watcher lived inside the same MCP child as the tools. Claude Code's plugin host reaps stdio MCP children between tool turns (or on `/reload-plugins`), which kept causing the watcher to die mid-session. The 3.6.0 split moves the long-lived channel concern into its own plugin (modeled on Telegram's `~/.claude/plugins/cache/.../telegram/0.0.6/server.ts`) whose lifetime matches the Claude Code session. See [`docs/3.6.0-channel-plugin-migration.md`](docs/3.6.0-channel-plugin-migration.md) for the full rationale.

**Legacy mode:** non-Claude hosts that don't run the channel plugin (Codex CLI, Gemini CLI, plain MCP experimentation) can still set `AGENT_BRIDGE_ROLE=channel-owner` in the MCP server's `.mcp.json` `env` block to opt back into the all-in-one pre-3.6.0 behaviour. Most setups should leave this alone — `tools-only` is the new default.

### OpenClaw native channel plugin

OpenClaw push delivery is **not** Claude's `claude/channel` protocol. Keep the MCP server in tools-only mode for `bridge_*` tools, and load `openclaw-channel/` as a native OpenClaw plugin. That plugin watches `inbox/openclaw/<target>/`, resolves an OpenClaw route, and dispatches a real OpenClaw turn via `dispatchInboundReplyWithBase`.

### Manual/polling fallback (unverified MCP hosts)

`bridge_receive_messages` currently inspects/consumes the local Claude Code-target inbox (`inbox/claude-code/`). Use it for diagnostics, tools-only/manual setups, or future harness-specific polling experiments. Do not assume Codex, Gemini CLI, Aider, or arbitrary MCP hosts have the same push lifecycle as Claude Code or OpenClaw until their target and receive loop are tested end-to-end.

### Channel setup

**Claude Code (recommended, 3.6.0+):** Install as Claude Code plugins. The repo's local marketplace ships both pieces; install BOTH so the tools and the channel are wired up:

```bash
cd ~/Projects/agent-bridge/mcp-server && npm install && npm run build
cd ~/Projects/agent-bridge/claude-code-channel && npm install && npm run build
claude plugin marketplace add ~/Projects/agent-bridge
claude plugin install agent-bridge@agent-bridge          # tools (MCP server)
claude plugin install agent-bridge-channel@agent-bridge  # channel host (long-lived watcher)
```

Verify with `claude plugin list`. The plugin manifests live at `.claude-plugin/marketplace.json` (repo root), `mcp-server/.claude-plugin/plugin.json` + `mcp-server/.mcp.json`, and `claude-code-channel/.claude-plugin/plugin.json` + `claude-code-channel/.mcp.json`.

> ⚠️ **You still need `--dangerously-load-development-channels`.** An earlier version of this doc claimed the plugin install removes that requirement — it does not. Because the marketplace is a **local directory** (`claude plugin marketplace add ~/Projects/agent-bridge`), Claude Code treats it as a dev channel and its built-in allowlist will reject it on launch with:
>
> ```
> plugin agent-bridge@agent-bridge is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)
> ```
>
> The flag is required **until the plugin is published through an official GitHub marketplace** Claude Code's allowlist trusts. Add it to your launch alias, e.g.:
>
> ```bash
> alias claude-tel='claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official --dangerously-load-development-channels plugin:agent-bridge@agent-bridge'
> ```
>
> **Note:** `--dangerously-load-development-channels` takes a **tagged argument** (`plugin:<name>@<marketplace>` for an installed plugin's channel, or `server:<name>` for a raw MCP server) and does **both jobs in one entry**: activates the channel AND marks it as allowlist-exempt. Do NOT also add `--channels plugin:agent-bridge@agent-bridge` — that creates a second entry with `dev:false` that fails the allowlist check. Running the flag bare (no tag) also fails: `--dangerously-load-development-channels entries must be tagged: --channels plugin:<name>@<marketplace> | server:<name>`.

**OpenClaw MCP tools:** add the MCP server as tools-only, then load the native channel plugin separately through OpenClaw config:
```bash
openclaw mcp set agent-bridge '{"command":"node","args":["/absolute/path/to/agent-bridge/mcp-server/build/index.js"],"env":{"AGENT_BRIDGE_ROLE":"tools-only"}}'
```

**Other MCP hosts (Codex, Gemini CLI, Aider):** add the server to the harness's MCP config for tools. Inbound receive/reply remains scaffolded until tested:
```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": ["/path/to/agent-bridge/mcp-server/build/index.js"],
      "env": { "AGENT_BRIDGE_ROLE": "tools-only" }
    }
  }
}
```

### Legacy: manual channel launch

If you load the MCP server outside of the plugin system (for example with `server:agent-bridge` pointing at a hand-edited `.mcp.json`), Claude Code's channel allowlist still requires the dev-channel flag. The flag takes a tagged argument and both activates the channel and marks it allowlist-exempt:

```bash
claude --dangerously-load-development-channels server:agent-bridge
```

Prefer the plugin install path above for normal use, but a local-directory marketplace still needs the tagged `--dangerously-load-development-channels plugin:agent-bridge@agent-bridge` launch flag until the plugin is published through a trusted marketplace.

### Message flow

1. Machine A's agent calls `bridge_send_message({ machine: "MacBook", message: "check the test results", target: "claude-code" })` or an OpenClaw target like `target: "openclaw/default"`.
2. The message is written to Machine B's target-specific inbox subdir via SSH, e.g. `~/.agent-bridge/inbox/claude-code/<id>.json` or `~/.agent-bridge/inbox/openclaw/default/<id>.json`.
3. The target's listener detects the new file.
4. **Claude Code push:** the channel-owner MCP child emits `notifications/claude/channel` into the running Claude session.
5. **OpenClaw push:** the native OpenClaw plugin dispatches via `dispatchInboundReplyWithBase` into the resolved OpenClaw session.
6. **Manual fallback:** a tools-only/manual agent can call `bridge_receive_messages()` for the Claude Code-target inbox.
7. Machine B's agent responds via `bridge_send_message` back to Machine A, using `fromTarget` when present.

### Offline recovery

Pending messages persist in their per-target inbox subdir until delivered, consumed, expired, or quarantined (default TTL: 1 day). On MCP server startup, undelivered Claude Code messages in `inbox/claude-code/` are replayed as channel notifications in chronological order; successfully delivered files are archived to `inbox/.archive/claude-code/`. A `.delivered` tracker prevents duplicate Claude Code notifications across restarts. This is replay-on-spawn durability, not a separate always-on Claude daemon. OpenClaw uses `~/.agent-bridge/.openclaw-v2-delivered` and archives under `~/.agent-bridge/archive/openclaw/<target>/`.

### Authentication

All messages are delivered via SSH with key-based authentication. The `authenticated: ssh-key` metadata in channel notifications confirms the sender was verified by the SSH transport layer.

### Message format

```json
{
  "id": "msg-uuid",
  "from": "Mac-Mini",
  "to": "MacBookPro",
  "type": "message",
  "content": "The tests are passing now.",
  "timestamp": "2026-04-13T01:15:00Z",
  "replyTo": null,
  "ttl": 86400,
  "target": "claude-code",
  "fromTarget": "claude-code"
}
```

The `target` field (added in 3.4.0) decides which inbox subdir on the receiver the message lands in, and therefore which listener consumes it. `fromTarget` is the sender's return target for bridge replies; Claude Code sends default it to `claude-code`, while OpenClaw senders should pass their own target such as `openclaw/default`.

### Claude Code per-session targets (future work)

Ideally each Claude Code session would identify itself with a flag (e.g. `claude --agent-bridge-target laptop-main`) so its channel plugin could watch a tighter subdir like `inbox/claude-code/laptop-main/`. That requires upstream support in `anthropics/claude-plugins-official/telegram` and is tracked as future work — for now all Claude Code sessions on a given machine share the `inbox/claude-code/` subdir.

# Agent Bridge -- Instructions for AI Agents

agent-bridge lets AI coding agents run commands on other machines over SSH and send messages between running agent sessions. It works with any CLI agent (Claude Code, Codex, Gemini CLI, Aider, etc.).

## Quick reference

```bash
agent-bridge setup                              # Enable SSH, generate keys, show pairing screen
agent-bridge pair --name "X" --host IP --port 22 --user U --token T --pubkey "ssh-ed25519 ..."
agent-bridge list                               # List paired machines
agent-bridge status [machine]                   # Check reachability
agent-bridge run <machine> "command"            # Run a shell command remotely
agent-bridge run <machine> "prompt" --agent     # Run an AI agent prompt remotely (default: claude --print)
agent-bridge run <machine> "prompt" --claude    # Shorthand for --agent "claude --print"
agent-bridge run <machine> "prompt" --codex     # Shorthand for --agent "codex exec"
agent-bridge connect <machine>                  # Open interactive SSH session
agent-bridge unpair <machine>                   # Remove a pairing
```

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

## Remote agent execution

The `--agent` flag wraps a prompt in an agent command on the remote machine:
```bash
agent-bridge run MacBook "fix the tests" --agent                    # Uses "claude --print"
agent-bridge run MacBook "fix the tests" --agent "codex exec"       # Uses Codex
agent-bridge run MacBook "fix the tests" --agent "aider --message"  # Uses Aider
```

## Architecture

- Config directory: `~/.agent-bridge/`
- Config file: `~/.agent-bridge/config` (INI-style, one `[section]` per machine)
- Keys: `~/.agent-bridge/keys/` (ED25519, mode 600)
- Inbox: `~/.agent-bridge/inbox/` (incoming messages, JSON files)
- Outbox: `~/.agent-bridge/outbox/` (copies of sent messages)
- Logs: `~/.agent-bridge/logs/` (MCP server logs, auto-rotated)
- No cloud, no dependencies -- pure bash over SSH

## MCP Server (agent-to-agent messaging)

The MCP server enables EXISTING running agent sessions to communicate in real time. It does NOT spawn new agent processes.

### MCP tools

| Tool | Description |
|------|-------------|
| `bridge_list_machines` | List paired machines and connection details |
| `bridge_status` | Check if a machine is reachable via SSH |
| `bridge_send_message` | Send a message to another machine's running agent |
| `bridge_receive_messages` | Check for and consume incoming messages |
| `bridge_run_command` | Run a shell command on a remote machine |
| `bridge_clear_inbox` | Clear the local inbox |
| `bridge_inbox_stats` | Get inbox statistics and watcher health |

### Channel plugin (Claude Code only)

When used with Claude Code, the MCP server acts as a **channel plugin**. Incoming messages are **pushed** into the running session automatically as:
```
<channel source="agent-bridge" from="MachineName" message_id="msg-xxx" ts="2026-01-01T00:00:00Z">
Message content here
</channel>
```

The agent responds using the `bridge_send_message` tool. No polling needed.

### Polling mode (all other harnesses)

For Codex, Gemini CLI, Aider, etc., agents call `bridge_receive_messages` to check for incoming messages. The watcher updates an internal cache so polling is fast.

### Channel setup

**Claude Code (recommended):** Install as a Claude Code plugin. The repo doubles as a local marketplace — one command registers BOTH the MCP server and the channel:

```bash
cd ~/Projects/agent-bridge/mcp-server && npm install && npm run build
claude plugin marketplace add ~/Projects/agent-bridge
claude plugin install agent-bridge@agent-bridge
```

Verify with `claude plugin list`. The plugin manifest lives at `.claude-plugin/marketplace.json` (repo root) and `mcp-server/.claude-plugin/plugin.json` + `mcp-server/.mcp.json`.

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

**Other harnesses (Codex, Gemini CLI, Aider):** Add to your harness's MCP config directly:
```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": ["/path/to/agent-bridge/mcp-server/build/index.js"]
    }
  }
}
```

### Legacy: manual channel launch

If you load the MCP server outside of the plugin system (for example with `claude --channels server:agent-bridge` pointing at a hand-edited `.mcp.json`), Claude Code's channel allowlist requires:

```bash
claude --dangerously-load-development-channels --channels server:agent-bridge
```

Prefer the plugin install path above — it removes the need for this flag.

### Message flow

1. Machine A's agent calls `bridge_send_message("MacBook", "check the test results")`
2. The message is written to Machine B's `~/.agent-bridge/inbox/` via SSH
3. Machine B's file watcher detects the new file
4. **Push mode:** Channel plugin pushes the message into the running Claude session
5. **Polling mode:** Agent calls `bridge_receive_messages()` to consume it
6. Machine B's agent responds via `bridge_send_message` back to Machine A

### Offline recovery

Messages persist in the inbox until consumed or expired (default TTL: 1 hour). On MCP server startup, undelivered messages are replayed as channel notifications in chronological order. A `.delivered` tracker prevents duplicate notifications across restarts.

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
  "ttl": 3600
}
```

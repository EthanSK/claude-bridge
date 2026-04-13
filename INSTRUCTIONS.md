# Agent Bridge -- Instructions for AI Agents

agent-bridge lets AI coding agents run commands on other machines over SSH and send messages between running agent sessions. It works with any CLI agent (Claude Code, Codex, Gemini CLI, OpenClaw, Aider, etc.).

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

For Codex, Gemini CLI, OpenClaw, Aider, etc., agents call `bridge_receive_messages` to check for incoming messages. The watcher updates an internal cache so polling is fast.

### Channel setup

Add to your harness's MCP config:
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

Claude Code automatically detects the `claude/channel` capability and starts receiving pushed messages.

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

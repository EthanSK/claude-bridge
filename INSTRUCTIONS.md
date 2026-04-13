# Agent Bridge -- Instructions for AI Agents

agent-bridge lets AI coding agents run commands on other machines over SSH. It works with any CLI agent (Claude Code, Codex, Gemini CLI, Aider, etc.).

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
- No cloud, no dependencies -- pure bash over SSH

## v2: Channel Plugin (push-based agent-to-agent messaging)

The MCP server is also a **Claude Code channel plugin**. When configured as a channel, incoming messages from other machines are **pushed** into the running Claude session automatically -- no polling needed.

### How it works

Messages appear in Claude's context as:
```
<channel source="agent-bridge" from="MachineName" message_id="msg-xxx" ts="2025-01-01T00:00:00Z">
Message content here
</channel>
```

The agent responds using the `bridge_send_message` tool.

### Channel setup

Add to Claude Code's MCP config (in `~/.claude/settings.json` or project settings):
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

### Message flow (channel mode)

1. Machine A's Claude calls `bridge_send_message("MacBook", "check the test results")`
2. The message is written to Machine B's `~/.agent-bridge/inbox/` via SSH
3. Machine B's file watcher detects the new file
4. Machine B's channel plugin pushes the message into the running Claude session
5. Machine B's Claude sees `<channel source="agent-bridge" ...>` and responds

No polling is needed. The `bridge_receive_messages` tool still works for manual checks but is no longer the primary way to receive messages.

### Authentication

All messages are delivered via SSH with key-based authentication. The `authenticated: ssh-key` metadata in channel notifications confirms the sender was verified by the SSH transport layer.

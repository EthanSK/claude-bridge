---
name: agent-bridge
description: Bridge AI coding agents across machines over SSH. Run commands and agent prompts on paired remote machines, and send/receive messages between running agent sessions. Use when connecting to other machines, running remote commands, sending messages, or pairing new peers.
metadata:
  openclaw:
    emoji: "\U0001F309"
    requires:
      bins: ["ssh", "ssh-keygen"]
    primaryEnv: ""
---

# Agent Bridge

You are an AI coding agent with agent-bridge installed. This machine is a **peer** in a bidirectional bridge -- it can both send commands to and receive commands from other paired machines.

## When to activate

Activate when the user says things like:
- "connect to my MacBook" / "talk to the other machine"
- "run X on [machine name]"
- "check if [machine] is online"
- "pair with a new machine" / "add a remote machine"
- "what machines are connected?"
- "set up remote access" / "set up agent-bridge"
- "send a message to the other agent"

## CLI commands

```bash
agent-bridge setup                              # Enable SSH, generate keys, show pairing screen
agent-bridge list                               # List paired machines
agent-bridge status [machine]                   # Check reachability
agent-bridge run <machine> "command"            # Run a shell command remotely
agent-bridge run <machine> "prompt" --agent     # Run an AI agent prompt (default: claude --print)
agent-bridge run <machine> "prompt" --claude    # Shorthand for --agent "claude --print"
agent-bridge run <machine> "prompt" --codex     # Shorthand for --agent "codex exec"
agent-bridge connect <machine>                  # Open interactive SSH session
agent-bridge pair                               # Pair with another machine
agent-bridge unpair <machine>                   # Remove a pairing
```

## MCP tools (if MCP server is configured)

If the agent-bridge MCP server is registered, these tools are available directly:

| Tool | Description |
|------|-------------|
| `bridge_list_machines` | List paired machines and connection details |
| `bridge_status` | Check if a machine is reachable via SSH |
| `bridge_send_message` | Send a message to another machine's running agent |
| `bridge_receive_messages` | Check for and consume incoming messages (call periodically) |
| `bridge_run_command` | Run a shell command on a remote machine |
| `bridge_clear_inbox` | Clear the local inbox |
| `bridge_inbox_stats` | Get inbox statistics and watcher health |

**Delivery mode:** If the OpenClaw agent-bridge plugin (or the standalone daemon) is installed, incoming messages are **pushed** into your running session automatically as a new user turn formatted `<channel source="agent-bridge" from="..." ...>content</channel>` — no polling required. If the plugin/daemon is NOT installed, fall back to polling with `bridge_receive_messages` at natural breakpoints. Messages persist in the inbox until consumed (default TTL: 1 hour).

### Install the OpenClaw push plugin (recommended)

```bash
# Option A — install as OpenClaw plugin (requires scanner bypass for child_process use)
openclaw plugins install --link ~/Projects/agent-bridge/openclaw-plugin \
  --dangerously-force-unsafe-install
openclaw gateway restart

# Option B — run as a standalone daemon (no plugin install)
node ~/Projects/agent-bridge/openclaw-plugin/bin/agent-bridge-openclaw-inbox.js
```

See `openclaw-plugin/README.md` in the agent-bridge repo for a launchd plist template and full configuration reference.

## Pairing from a photo

When given a photo of a pairing screen:
1. Extract: Machine Name, Username, IP, Port, Token, Public Key
2. Run: `agent-bridge pair --name "<name>" --host "<ip>" --port <port> --user "<user>" --token "<token>" --pubkey "<pubkey>"`
3. Test: `agent-bridge status <name>`

## Examples

```bash
agent-bridge run MacBook-Pro "ls -la ~/Projects"
agent-bridge run MacBook-Pro "cd ~/Projects/myapp && git pull && npm run build"
agent-bridge run MacBook-Pro "review the code in ~/Projects/myapp" --agent
```

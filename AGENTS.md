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
- "enable SSH for remote access"
- "let the other agent control this machine"
- Sends a photo of an agent-bridge pairing screen

## Setup (run on any machine you want to bridge)

```bash
agent-bridge setup
```

Options:
```bash
agent-bridge setup --name "MacBook-Pro"   # Custom machine name
agent-bridge setup --port 2222             # Custom SSH port
```

### What setup does

1. **Enables SSH** (Remote Login on macOS) if not already on
2. **Generates an ED25519 key pair** at `~/.agent-bridge/keys/`
3. **Adds the public key** to `~/.ssh/authorized_keys`
4. **Displays a pairing screen** with all connection details

### After setup

Tell the user to:
1. **Photograph the pairing screen** displayed in the terminal
2. **Send the photo** to the agent on the other machine (e.g., via Telegram)
3. The other agent will read the photo and complete the pairing

## Available commands

All commands use the `agent-bridge` CLI:

### Check paired machines
```bash
agent-bridge list
```

### Check machine status
```bash
agent-bridge status              # All machines
agent-bridge status MacBook-Pro  # Specific machine
```

### Run a command remotely
```bash
agent-bridge run MacBook-Pro "ls -la ~/Projects"
agent-bridge run MacBook-Pro "brew update && brew upgrade"
```

### Run an AI agent prompt on a remote machine
```bash
# Default (Claude Code):
agent-bridge run MacBook-Pro "fix the failing tests in ~/Projects/myapp" --agent

# Specify an agent explicitly:
agent-bridge run MacBook-Pro "fix the failing tests" --agent "claude --print"
agent-bridge run MacBook-Pro "fix the failing tests" --agent "codex exec"
agent-bridge run MacBook-Pro "fix the failing tests" --agent "aider --message"

# Shorthands:
agent-bridge run MacBook-Pro "fix the failing tests" --claude
agent-bridge run MacBook-Pro "fix the failing tests" --codex
```
The `--agent` flag wraps the prompt in the specified agent command on the remote machine. Without a value, it defaults to `claude --print`.

### Open an interactive SSH session
```bash
agent-bridge connect MacBook-Pro
```

### Pair a new machine
```bash
# With flags:
agent-bridge pair --name "MacBook-Pro" --host 192.168.1.50 --port 22 --user ethan --token bridge-a7f3k9 --pubkey "ssh-ed25519 AAAA..."

# Interactive:
agent-bridge pair
```

### Remove a pairing
```bash
agent-bridge unpair MacBook-Pro
```

## Pairing from a photo

When the user sends a photo of another machine's pairing screen:

1. Read the image (you can see images natively)
2. Extract these fields from the pairing screen:
   - Machine Name
   - Username
   - Local IP (or Public IP if connecting over the internet)
   - Port
   - Token
   - Public Key
3. Run the pair command:
```bash
agent-bridge pair --name "<name>" --host "<ip>" --port <port> --user "<user>" --token "<token>" --pubkey "<pubkey>"
```
4. Then test: `agent-bridge status <name>`

## Typical workflows

### "Deploy my app on the MacBook"
```bash
agent-bridge run MacBook-Pro "cd ~/Projects/myapp && git pull && npm install && npm run build"
```

### "Ask the remote agent to review my code"
```bash
agent-bridge run MacBook-Pro "review the code in ~/Projects/myapp/src/ and suggest improvements" --agent
```

### "Check what's running on my other machine"
```bash
agent-bridge run MacBook-Pro "ps aux | head -20 && df -h && free -h 2>/dev/null"
```

## v2: MCP Server (running agent-to-agent communication)

agent-bridge v2 adds an MCP server for real-time communication between RUNNING agent sessions. It does NOT spawn new agent processes — it connects existing, already-running sessions on different machines.

If configured as an MCP server in Claude Code, the following tools become available natively:

- `bridge_list_machines` — list paired machines
- `bridge_status` — check if a machine is reachable
- `bridge_send_message` — send a message to another machine's running agent
- `bridge_receive_messages` — check for incoming messages (polling-based)
- `bridge_run_command` — run a shell command on a remote machine
- `bridge_clear_inbox` — clear the local inbox
- `bridge_inbox_stats` — get inbox statistics and watcher health

Setup: `cd mcp-server && npm install && npm run build`, then add to MCP config.

### How messaging works

1. Machine A's Claude calls `bridge_send_message` to write a message to Machine B's inbox via SSH
2. Machine B's file watcher detects the new file
3. Machine B's running Claude calls `bridge_receive_messages` to read it
4. Machine B processes and responds via `bridge_send_message` back to Machine A
5. Machine A calls `bridge_receive_messages` to get the reply

Messages include sender name, timestamp, content, optional reply-to ID for threading, and TTL.

## Troubleshooting

### SSH not enabling
On macOS, go to System Settings > General > Sharing > Remote Login and enable it manually.

### Firewall blocking connections
```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/sbin/sshd
```

### Using Tailscale
If both machines are on Tailscale, use the Tailscale hostname or IP instead of the local IP. This works across networks.

## Security notes

- All communication uses SSH with key-based authentication
- Private keys are stored in `~/.agent-bridge/keys/` (mode 600)
- Config is stored in `~/.agent-bridge/config` (mode 600)
- No passwords are stored or transmitted
- All files are stored in `~/.agent-bridge/` with restrictive permissions (mode 700)

# Agent Bridge Skill

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
5. **Auto-adds agent-bridge instructions** to detected AI harness files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.openclaw/AGENTS.md`, `~/.gemini/GEMINI.md`) so every new session knows about the bridge. This also runs during `pair`.

### After setup

Tell the user to:
1. **Photograph the pairing screen** displayed in the terminal
2. **Send the photo** to the agent on the other machine (e.g., via Telegram)
3. The other agent will read the photo and complete the pairing

Alternatively, they can:
- Copy the manual pairing command shown on screen
- Copy the private key file to the other machine: `scp ~/.agent-bridge/keys/agent-bridge_<name> other-machine:~/.agent-bridge/keys/`

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
agent-bridge pair --name "MacBook-Pro" --host 192.168.1.50 --port 22 --user ethan --key ~/.agent-bridge/keys/agent-bridge_MacBook-Pro --token bridge-a7f3k9

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
3. Run the pair command:
```bash
agent-bridge pair --name "<name>" --host "<ip>" --port <port> --user "<user>" --token "<token>"
```
4. Then test: `agent-bridge status <name>`

## Transferring the private key

Setup generates a key pair on each machine. The private key must be on the connecting machine to authenticate. Options:
1. **Manual copy**: `scp other-machine:~/.agent-bridge/keys/agent-bridge_<name> ~/.agent-bridge/keys/`
2. **Use existing SSH keys**: If you already have SSH access, skip the key step

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

### "Start a dev server on the MacBook"
```bash
agent-bridge run MacBook-Pro "cd ~/Projects/myapp && nohup npm run dev > /tmp/dev.log 2>&1 &"
```

## v2: MCP Server (running agent-to-agent communication)

If the agent-bridge MCP server is configured, you have direct access to these tools without needing the CLI. The MCP server enables EXISTING running agent sessions to communicate — it does NOT spawn new agent processes.

| Tool | Description |
|------|-------------|
| `bridge_list_machines` | List paired machines |
| `bridge_status` | Check if a machine is reachable |
| `bridge_send_message` | Send a message to another machine's running agent |
| `bridge_receive_messages` | Check for incoming messages (polling-based) |
| `bridge_run_command` | Run a shell command remotely |
| `bridge_clear_inbox` | Clear the local inbox |
| `bridge_inbox_stats` | Get inbox statistics and watcher health |

### MCP server setup

```bash
cd ~/Projects/agent-bridge/mcp-server
npm install && npm run build
```

Add to Claude Code MCP config:
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

### Messaging workflow

1. Machine A's Claude calls `bridge_send_message("MacBookPro", "check the test results")` to send
2. The message is written to Machine B's `~/.agent-bridge/inbox/` via SSH
3. Machine B's file watcher detects the new file and updates the cache
4. Machine B's running Claude calls `bridge_receive_messages()` to read it
5. Machine B processes and responds via `bridge_send_message` back to Machine A
6. Machine A calls `bridge_receive_messages()` to get the reply

Messages are JSON files delivered via SSH. A file watcher (fswatch on macOS, inotifywait on Linux, polling fallback) detects new files and updates an internal cache. The running agent must call `bridge_receive_messages` to consume messages — there is no push notification to the agent.

Each message includes: sender name, timestamp, content, optional `reply_to` ID for threading, and TTL (default 1 hour).

## Troubleshooting

### SSH not enabling
On macOS, go to System Settings > General > Sharing > Remote Login and enable it manually.

### Firewall blocking connections
```bash
# Check if firewall is on
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate

# Allow SSH through
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/sbin/sshd
```

### Can't find IP address
```bash
# Get local IP
ipconfig getifaddr en0    # Wi-Fi
ipconfig getifaddr en1    # Ethernet (or en0 on some Macs)

# Or use Tailscale
tailscale ip -4
```

### Using Tailscale
If both machines are on Tailscale, use the Tailscale hostname or IP instead of the local IP. This works across networks.

## Security notes

- All communication uses SSH with key-based authentication
- Private keys are stored in `~/.agent-bridge/keys/` (mode 600)
- Config is stored in `~/.agent-bridge/config` (mode 600)
- No passwords are stored or transmitted
- All files are stored in `~/.agent-bridge/` with restrictive permissions (mode 700)

# Claude Bridge Skill

You are a Claude Code instance with claude-bridge installed. This machine is a **peer** in a bidirectional bridge -- it can both send commands to and receive commands from other paired machines.

## When to activate

Activate when the user says things like:
- "connect to my MacBook" / "talk to the other machine"
- "run X on [machine name]"
- "check if [machine] is online"
- "pair with a new machine" / "add a remote machine"
- "what machines are connected?"
- "set up remote access" / "set up claude-bridge"
- "enable SSH for remote access"
- "let the other Claude control this machine"
- Sends a photo of a claude-bridge pairing screen

## Setup (run on any machine you want to bridge)

```bash
claude-bridge setup
```

Options:
```bash
claude-bridge setup --name "MacBook-Pro"   # Custom machine name
claude-bridge setup --port 2222             # Custom SSH port
```

### What setup does

1. **Enables SSH** (Remote Login on macOS) if not already on
2. **Generates an ED25519 key pair** at `~/.claude-bridge/keys/`
3. **Adds the public key** to `~/.ssh/authorized_keys`
4. **Displays a pairing screen** with all connection details

### After setup

Tell the user to:
1. **Photograph the pairing screen** displayed in the terminal
2. **Send the photo** to the Claude on the other machine (e.g., via Telegram)
3. The other Claude will read the photo and complete the pairing

Alternatively, they can:
- Copy the manual pairing command shown on screen
- Copy the private key file to the other machine: `scp ~/.claude-bridge/keys/claude-bridge_<name> other-machine:~/.claude-bridge/keys/`

## Available commands

All commands use the `claude-bridge` CLI:

### Check paired machines
```bash
claude-bridge list
```

### Check machine status
```bash
claude-bridge status              # All machines
claude-bridge status MacBook-Pro  # Specific machine
```

### Run a command remotely
```bash
claude-bridge run MacBook-Pro "ls -la ~/Projects"
claude-bridge run MacBook-Pro "brew update && brew upgrade"
```

### Run a Claude Code prompt on a remote machine
```bash
claude-bridge run MacBook-Pro "fix the failing tests in ~/Projects/myapp" --claude
```
This wraps the command in `claude --print "..."` on the remote machine, effectively asking the remote Claude to do work.

### Open an interactive SSH session
```bash
claude-bridge connect MacBook-Pro
```

### Pair a new machine
```bash
# With flags:
claude-bridge pair --name "MacBook-Pro" --host 192.168.1.50 --port 22 --user ethan --key ~/.claude-bridge/keys/claude-bridge_MacBook-Pro --token bridge-a7f3k9

# Interactive:
claude-bridge pair
```

### Remove a pairing
```bash
claude-bridge unpair MacBook-Pro
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
claude-bridge pair --name "<name>" --host "<ip>" --port <port> --user "<user>" --token "<token>"
```
4. Then test: `claude-bridge status <name>`

## Transferring the private key

Setup generates a key pair on each machine. The private key must be on the connecting machine to authenticate. Options:
1. **Manual copy**: `scp other-machine:~/.claude-bridge/keys/claude-bridge_<name> ~/.claude-bridge/keys/`
2. **Use existing SSH keys**: If you already have SSH access, skip the key step

## Typical workflows

### "Deploy my app on the MacBook"
```bash
claude-bridge run MacBook-Pro "cd ~/Projects/myapp && git pull && npm install && npm run build"
```

### "Ask the other Claude to review my code"
```bash
claude-bridge run MacBook-Pro "review the code in ~/Projects/myapp/src/ and suggest improvements" --claude
```

### "Check what's running on my other machine"
```bash
claude-bridge run MacBook-Pro "ps aux | head -20 && df -h && free -h 2>/dev/null"
```

### "Start a dev server on the MacBook"
```bash
claude-bridge run MacBook-Pro "cd ~/Projects/myapp && nohup npm run dev > /tmp/dev.log 2>&1 &"
```

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
- Private keys are stored in `~/.claude-bridge/keys/` (mode 600)
- Config is stored in `~/.claude-bridge/config` (mode 600)
- No passwords are stored or transmitted
- All files are stored in `~/.claude-bridge/` with restrictive permissions (mode 700)

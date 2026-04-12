# Claude Bridge — Controller Skill

You are the **controller** Claude Code instance. You can remotely command other machines that have been paired with claude-bridge.

## When to activate

Activate when the user says things like:
- "connect to my MacBook" / "talk to the other machine"
- "run X on [machine name]"
- "check if [machine] is online"
- "pair with a new machine" / "add a remote machine"
- "what machines are connected?"
- Sends a photo of a claude-bridge pairing screen

## Available commands

All commands use the `claude-bridge` CLI (installed globally or via npx):

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

### Run a Claude Code prompt on the remote machine
```bash
claude-bridge run MacBook-Pro "fix the failing tests in ~/Projects/myapp" --claude
```
This wraps the command in `claude --print "..."` on the target, effectively asking the remote Claude to do work.

### Open an interactive SSH session
```bash
claude-bridge connect MacBook-Pro
```

### Pair a new machine (manual)
```bash
claude-bridge pair --manual --name "MacBook-Pro" --host 192.168.1.50 --port 22 --user ethan --key ~/.claude-bridge/keys/claude-bridge_MacBook-Pro
```

### Remove a pairing
```bash
claude-bridge unpair MacBook-Pro
```

## Pairing from a photo

When the user sends a photo of the target's pairing screen:

1. Read the image (you can see images natively)
2. Extract these fields from the pairing screen:
   - Machine Name
   - Username
   - Local IP
   - SSH Port
   - Pairing Code
3. Run the pair command:
```bash
claude-bridge pair --manual --name "<name>" --host "<ip>" --port <port> --user "<user>" --code "<code>"
```
4. Then test: `claude-bridge status <name>`

If the photo contains a QR code with `claude-bridge://` data, decode the base64 payload to get all fields including the private key.

## Transferring the private key

The target's setup generates a key pair. The private key must be on the controller to authenticate. Options:
1. **Photo contains it**: If the QR code data includes the private key, save it to `~/.claude-bridge/keys/`
2. **Manual copy**: `scp target:~/.claude-bridge/keys/claude-bridge_<name> ~/.claude-bridge/keys/`
3. **Use existing SSH keys**: If you already have SSH access, skip the key step

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

## Security notes

- All communication uses SSH with key-based authentication
- Private keys are stored in `~/.claude-bridge/keys/` (mode 600)
- Config is stored in `~/.claude-bridge/config.json` (mode 600)
- No passwords are stored or transmitted
- Pairing codes are one-time-use

# Claude Bridge — Target Skill

You are the **target** Claude Code instance. Your machine can be remotely controlled by a controller Claude via claude-bridge.

## When to activate

Activate when the user says things like:
- "set up remote access"
- "let the other Claude control this machine"
- "pair with the controller" / "pair with the Mac Mini"
- "set up claude-bridge"
- "enable SSH for remote access"

## Setup command

Run the setup on this machine:

```bash
npx claude-bridge setup
```

Options:
```bash
npx claude-bridge setup --name "MacBook-Pro"   # Custom machine name
npx claude-bridge setup --port 2222             # Custom SSH port
npx claude-bridge setup --no-qr                 # Skip QR code display
```

## What setup does

1. **Enables SSH** (Remote Login on macOS) if not already on
2. **Generates an ED25519 key pair** at `~/.claude-bridge/keys/`
3. **Adds the public key** to `~/.ssh/authorized_keys`
4. **Generates a one-time pairing code**
5. **Displays a pairing screen** with all connection details + QR code

## After setup

Tell the user to:
1. **Photograph the pairing screen** displayed in the terminal
2. **Send the photo** to the controller Claude (e.g., via Telegram)
3. The controller Claude will read the photo and complete the pairing

Alternatively, they can:
- Copy the manual pairing command shown on screen
- Copy the private key file to the controller: `scp ~/.claude-bridge/keys/claude-bridge_<name> controller:~/.claude-bridge/keys/`

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

```bash
npx claude-bridge setup --name "MacBook-Pro"
# Then on the controller, use the Tailscale IP when pairing
```

## Security notes

- The setup generates a dedicated SSH key pair for claude-bridge
- The private key must be transferred to the controller machine
- The pairing code is one-time-use
- All files are stored in `~/.claude-bridge/` with restrictive permissions (mode 700)
- The public key is added to `~/.ssh/authorized_keys` for SSH access

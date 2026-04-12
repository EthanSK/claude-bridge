# claude-bridge

**Let your Claude Code instances talk to each other across machines.**

[Website](https://ethansk.github.io/claude-bridge/) · [GitHub](https://github.com/EthanSK/claude-bridge)

---

## Quick Start

Paste this into Claude Code on **each computer** you want to bridge:

```
Read the README at https://github.com/EthanSK/claude-bridge and follow the setup instructions for this computer. Install claude-bridge, run the setup command, and install the Claude Code skill. Do everything automatically — don't ask me questions.
```

Then photograph the pairing screen and send it to Claude on the other machine. That's it — they can now talk to each other.

---

## What it looks like

### Step 1: Setup

Run on each machine you want to bridge:

```
$ claude-bridge setup

  +----------------------------------------------+
  |         claude-bridge  .  setup               |
  +----------------------------------------------+

  1. SSH Server
  [ok] SSH (Remote Login) is already enabled.

  2. SSH Key Pair
  Key pair generated.

  3. Pairing Token
  One-time pairing token generated.

  ╔══════════════════════════════════════════════════╗
  ║            claude-bridge pairing                 ║
  ╠══════════════════════════════════════════════════╣
  ║  Machine:    MacBook-Pro                        ║
  ║  User:       ethan                              ║
  ║  Local:      MacBookPro.local                   ║
  ║  Local IP:   192.168.1.42                       ║
  ║  Public IP:  82.45.123.67                       ║
  ║  Port:       22                                 ║
  ║  Token:      bridge-a7f3k9                      ║
  ╚══════════════════════════════════════════════════╝

  Photograph this screen and send to Claude on your other machine.
```

### Step 2: Pair

On the other machine, tell Claude the connection details (or paste the manual command):

```
$ claude-bridge pair \
    --name "MacBook-Pro" \
    --host 192.168.1.42 \
    --port 22 \
    --user ethan \
    --token bridge-a7f3k9

  [ok] Pairing token verified.

  [ok] Paired with "MacBook-Pro"!

  Connection details:
    Host:     192.168.1.42
    Port:     22
    User:     ethan
    Key:      ~/.claude-bridge/keys/claude-bridge_MacBook-Pro
```

### Step 3: Use

```
$ claude-bridge run MacBook-Pro "uname -a"
  Running command on MacBook-Pro...
Darwin MacBookPro.local 25.3.0 Darwin Kernel Version 25.3.0...

  [ok] command completed on MacBook-Pro (exit 0)

$ claude-bridge run MacBook-Pro "what files are in ~/Projects?" --claude
  Running Claude prompt on MacBook-Pro...
The ~/Projects directory contains:
  - producer-player/
  - ai-music-video-studio/
  - OBScene/
  - claude-bridge/

  [ok] Claude prompt completed on MacBook-Pro (exit 0)
```

### Optional: Internet tunnel

Expose your machine to the internet without port forwarding:

```
$ claude-bridge setup --internet

  ...
  4. Internet Tunnel
  Starting reverse SSH tunnel via serveo.net...
  [ok] Tunnel active!

  Internet access:
    Host: serveo.net
    Port: 43521

  Remote pair command:
    claude-bridge pair --name "MacBook-Pro" --host serveo.net --port 43521 --user ethan --token "bridge-a7f3k9"
```

---

## How it works

```
 COMPUTER A (Mac Mini)                    COMPUTER B (MacBook Pro)
 ┌──────────────────────┐                ┌──────────────────────┐
 │                      │                │                      │
 │  Claude Code         │     SSH        │  Claude Code         │
 │  + bridge skill      │ ◄────────────► │  + bridge skill      │
 │                      │                │                      │
 │  claude-bridge CLI   │                │  claude-bridge CLI   │
 │                      │                │                      │
 └──────────────────────┘                └──────────────────────┘

 "Run the tests on my MacBook"    ──►    ssh MacBook "npm test"
 "Ask the other Claude to fix it" ──►    ssh MacBook "claude --print '...'"
```

Both machines are **peers** — either one can run commands on the other. There's no fixed "controller" or "target."

### Three steps

1. **Setup** — Run `claude-bridge setup` on each machine. It enables SSH, generates keys, and shows a pairing screen.
2. **Pair** — Photograph one machine's pairing screen and send it to the Claude on the other machine. Claude reads the image and extracts the connection details. Or use the manual pairing command.
3. **Connect** — That's it. "Run X on my MacBook" just works from either machine.

---

## Installation

**Zero dependencies.** Just bash, ssh, and ssh-keygen (built into every Mac and Linux).

### Option A: One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/EthanSK/claude-bridge/main/install.sh | bash
```

### Option B: Clone and symlink

```bash
git clone https://github.com/EthanSK/claude-bridge.git
cd claude-bridge
chmod +x claude-bridge
sudo ln -sf "$(pwd)/claude-bridge" /usr/local/bin/claude-bridge
```

### Option C: Just download the script

```bash
curl -fsSL https://raw.githubusercontent.com/EthanSK/claude-bridge/main/claude-bridge -o /usr/local/bin/claude-bridge
chmod +x /usr/local/bin/claude-bridge
```

---

## Setup guide

### On each machine you want to bridge:

```bash
claude-bridge setup
```

This will:
- Enable SSH (Remote Login) if not already on
- Generate an SSH key pair
- Display a pairing screen with connection details

For internet access without port forwarding, add the `--internet` flag:
```bash
claude-bridge setup --internet
```

### Pair the machines:

**Option A: Photo pairing (the magic way)**
1. Take a photo of one machine's pairing screen
2. Send it to the Claude on the other machine (via Telegram, chat, etc.)
3. Claude reads the image, extracts the details, and runs the pair command

**Option B: Manual pairing**
```bash
claude-bridge pair \
  --name "MacBook-Pro" \
  --host 192.168.1.50 \
  --port 22 \
  --user ethan \
  --key ~/.claude-bridge/keys/claude-bridge_MacBook-Pro \
  --token bridge-a7f3k9
```

**Option C: Interactive pairing**
```bash
claude-bridge pair
# Follow the prompts
```

### Test the connection:

```bash
claude-bridge status MacBook-Pro
claude-bridge run MacBook-Pro "uname -a"
```

---

## CLI reference

| Command | Description |
|---------|-------------|
| `claude-bridge setup` | Enables SSH, generates keys, and displays a pairing screen. Use `--internet` for tunnel. |
| `claude-bridge pair` | Interactive or flag-based pairing to connect to another machine. |
| `claude-bridge connect <machine>` | Open an interactive SSH session. |
| `claude-bridge status [machine]` | Check if machine(s) are reachable. |
| `claude-bridge list` | List all paired machines. |
| `claude-bridge run <machine> "cmd"` | Run a command on a paired machine. |
| `claude-bridge run <machine> "prompt" --claude` | Run a Claude Code prompt on the remote machine. |
| `claude-bridge unpair <machine>` | Remove a pairing. |

### Setup options

```
-n, --name <name>              Machine name (defaults to hostname)
-p, --port <port>              SSH port (default: 22)
    --internet                 Start a reverse SSH tunnel for internet access
    --tunnel-provider <name>   Tunnel provider (default: serveo)
```

### Pair options

```
-n, --name <name>      Machine name (defaults to host)
-H, --host <host>      Hostname or IP of the other machine
-u, --user <user>      SSH username
-p, --port <port>      SSH port (default: 22)
-k, --key <key>        Path to SSH private key
-t, --token <token>    Pairing token from setup screen
```

---

## Claude Code skill

claude-bridge ships with a Claude Code skill that teaches Claude how to use the bridge automatically.

### Install the skill

```bash
# If you cloned the repo:
cp -r skills/bridge ~/.claude/skills/claude-bridge

# Or download directly:
curl -fsSL https://raw.githubusercontent.com/EthanSK/claude-bridge/main/skills/bridge/skill.md \
  -o ~/.claude/skills/claude-bridge/skill.md --create-dirs
```

Or reference it in your CLAUDE.md:
```
When the user asks to run something on another machine, use claude-bridge:
- `claude-bridge list` to see paired machines
- `claude-bridge run <machine> "command"` to execute commands
- `claude-bridge run <machine> "prompt" --claude` to run Claude Code prompts remotely
```

---

## Architecture

```
~/.claude-bridge/
├── config               # Paired machines (INI-style key-value)
├── .pending-token       # One-time pairing token (deleted after use)
└── keys/                # SSH key pairs
    ├── claude-bridge_MacBook-Pro
    └── claude-bridge_MacBook-Pro.pub
```

### Config format

Simple INI-style flat file — no JSON, no YAML:

```ini
[MacBook-Pro]
host=192.168.1.50
user=ethan
port=22
key=~/.claude-bridge/keys/claude-bridge_MacBook-Pro
paired_at=2026-04-09T12:00:00Z
```

### How pairing works

1. Each machine runs `setup` which generates an ED25519 key pair
2. The public key is added to `~/.ssh/authorized_keys` on that machine
3. A one-time pairing token is generated and displayed on screen
4. The pairing screen displays all connection info (local IP, public IP, token)
5. The other machine reads the pairing info (from photo or manual entry)
6. The pairing token is verified during the `pair` step, then deleted
7. The private key is copied to `~/.claude-bridge/keys/` on the connecting machine
8. The connecting machine can now SSH in using key-based auth

### How remote execution works

```
Machine A                               Machine B
─────────                              ─────────
claude-bridge run MacBook "cmd"
  └─► SSH connect (key auth)  ────────► sshd
      └─► exec "cmd"         ────────► shell
      └─► capture stdout/err  ◄──────── output
      └─► display result
```

For Claude-to-Claude communication:
```
Claude on Machine A                     Machine B
───────────────────                    ─────────
"fix the tests on MacBook"
  └─► claude-bridge run MacBook \
        "fix failing tests" --claude
      └─► SSH ──────────────────────► claude --print "fix failing tests"
      └─► capture output     ◄──────── Claude's response
      └─► display to user
```

---

## Security

- **SSH key-based auth only** — no passwords stored or transmitted
- **ED25519 keys** — modern, fast, secure
- **Restrictive file permissions** — config dir is mode 700, keys are mode 600
- **No cloud** — all communication is direct SSH, no third-party servers
- **Separate config** — stored in `~/.claude-bridge/`, not in `.claude/` to avoid accidental git commits

### Recommendations

- Use **Tailscale** for cross-network connections (avoids exposing SSH to the internet)
- Enable macOS **Firewall** and only allow SSH
- Regularly rotate keys with `claude-bridge unpair` + re-setup
- Review `~/.ssh/authorized_keys` periodically

---

## Tailscale support

If both machines are on the same Tailscale network, use the Tailscale hostname or IP:

```bash
# When pairing, use the Tailscale address
claude-bridge pair \
  --name "MacBook-Pro" \
  --host macbook-pro.tail12345.ts.net \
  --user ethan \
  --key ~/.claude-bridge/keys/claude-bridge_MacBook-Pro
```

This lets your Claudes talk to each other from anywhere.

---

## Examples

### Run a command on the other machine
```bash
claude-bridge run MacBook-Pro "ls -la ~/Projects"
```

### Deploy an app
```bash
claude-bridge run MacBook-Pro "cd ~/Projects/myapp && git pull && npm install && npm run build"
```

### Ask the remote Claude to do work
```bash
claude-bridge run MacBook-Pro "review the code in ~/Projects/myapp and suggest improvements" --claude
```

### Check system status
```bash
claude-bridge run MacBook-Pro "uptime && df -h && top -l 1 | head -10"
```

### Start a dev server in the background
```bash
claude-bridge run MacBook-Pro "cd ~/Projects/myapp && nohup npm run dev > /tmp/dev.log 2>&1 & echo started"
```

---

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

```bash
git clone https://github.com/EthanSK/claude-bridge.git
cd claude-bridge
chmod +x claude-bridge
./claude-bridge help
```

---

## License

[MIT](LICENSE) -- Ethan SK

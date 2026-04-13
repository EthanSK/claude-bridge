# agent-bridge

**Bridge AI coding agents across machines — works with Claude Code, Codex, OpenClaw, Gemini CLI, Aider, and any CLI agent.**

[![Claude Code](https://img.shields.io/badge/Claude_Code-skill-blueviolet)](https://github.com/EthanSK/claude-bridge)
[![Codex](https://img.shields.io/badge/Codex-AGENTS.md-green)](https://github.com/EthanSK/claude-bridge)
[![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-GEMINI.md-blue)](https://github.com/EthanSK/claude-bridge)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-SKILL.md-orange)](https://github.com/EthanSK/claude-bridge)
[![Any Agent](https://img.shields.io/badge/Any_Agent-INSTRUCTIONS.md-gray)](https://github.com/EthanSK/claude-bridge)

[Website](https://ethansk.github.io/claude-bridge/) · [GitHub](https://github.com/EthanSK/claude-bridge)

---

## Compatibility

agent-bridge works with any AI coding agent that can run shell commands. It ships with config files for each major harness:

| Agent Harness | Config File | Location |
|---------------|-------------|----------|
| **Claude Code** | `skills/bridge/skill.md` | Copy to `~/.claude/skills/agent-bridge/skill.md` |
| **Codex CLI** (OpenAI) | `AGENTS.md` | Repo root (auto-detected by Codex) |
| **Gemini CLI** | `GEMINI.md` | Repo root (auto-detected by Gemini CLI) |
| **OpenClaw** | `skills/openclaw/SKILL.md` | Copy to `~/.openclaw/workspace/skills/agent-bridge/SKILL.md` |
| **Aider / others** | `INSTRUCTIONS.md` | Repo root (plain-English reference for any agent) |

Each file teaches the respective agent how to use agent-bridge: listing machines, running commands, pairing from photos, and delegating work to remote agents.

---

## Quick Start

Paste this into your AI agent on **each computer** you want to bridge:

```
Read the README at https://github.com/EthanSK/claude-bridge and follow the setup instructions for this computer. Install agent-bridge, run the setup command, and install the skill for this agent. Do everything automatically — don't ask me questions.
```

**Important — first-time setup on each machine:**
- **macOS:** System Settings → General → Sharing → toggle **Remote Login** ON
- **macOS (Full Disk Access):** Without this, SSH sessions can't access Desktop, Documents, or Downloads. To grant it:
  1. Open **System Settings → Privacy & Security → Full Disk Access**
  2. Click the **+** button
  3. Press **Cmd+Shift+G** in the file picker (Go to folder)
  4. Type `/usr/sbin/sshd` and press Go
  5. Select `sshd` and click **Open**
  6. Toggle it **ON**
  7. Restart SSH: `sudo launchctl kickstart -k system/com.openssh.sshd`
- **Linux:** `sudo systemctl enable --now sshd`

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

  ╔══════════════════════════════════════════════════════════════════════╗
  ║                    claude-bridge pairing                            ║
  ╠══════════════════════════════════════════════════════════════════════╣
  ║  Machine:    MacBook-Pro                                           ║
  ║  User:       ethan                                                 ║
  ║  Local:      MacBookPro.local                                      ║
  ║  Local IP:   192.168.1.42                                          ║
  ║  Public IP:  82.45.123.67                                          ║
  ║  Port:       22                                                    ║
  ║  Token:      bridge-a7f3k9                                         ║
  ╠════════════════════════════════════════════════════════════════════  ╣
  ║  Public Key: ssh-ed25519 AAAA...long...key bridge:MacBook-Pro      ║
  ╚══════════════════════════════════════════════════════════════════════╝

  Photograph this screen and send to Claude on your other machine.
```

### Step 2: Pair

On the other machine, tell Claude the connection details (or paste the manual command). The public key from the setup screen is included -- no password needed:

```
$ claude-bridge pair \
    --name "MacBook-Pro" \
    --host 192.168.1.42 \
    --port 22 \
    --user ethan \
    --token bridge-a7f3k9 \
    --pubkey "ssh-ed25519 AAAA...key bridge:MacBook-Pro"

  1. Local Key Pair
  Using existing key pair for Mac-Mini.

  2. Authorize Remote Key
  [ok] Remote public key added to ~/.ssh/authorized_keys.
  The other machine can now SSH into this one.

  3. Token Verification
  [ok] Token accepted: bridge-a7f3k9

  [ok] Paired with "MacBook-Pro"!

  Connection details:
    Host:     192.168.1.42
    Port:     22
    User:     ethan
    Key:      ~/.claude-bridge/keys/claude-bridge_Mac-Mini
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
  --token bridge-a7f3k9 \
  --pubkey "ssh-ed25519 AAAA...key bridge:MacBook-Pro"
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
-n, --name <name>        Machine name (defaults to host)
-H, --host <host>        Hostname or IP of the other machine
-u, --user <user>        SSH username
-p, --port <port>        SSH port (default: 22)
-k, --key <key>          Path to SSH private key (override)
-t, --token <token>      Pairing token from setup screen
    --pubkey <key>       Public key from the other machine's setup screen
```

---

## Agent skills

agent-bridge ships with skill/instruction files for each major AI coding agent.

### Claude Code

```bash
# If you cloned the repo:
cp -r skills/bridge ~/.claude/skills/agent-bridge

# Or download directly:
curl -fsSL https://raw.githubusercontent.com/EthanSK/claude-bridge/main/skills/bridge/skill.md \
  -o ~/.claude/skills/agent-bridge/skill.md --create-dirs
```

### Codex CLI (OpenAI)

Codex automatically reads `AGENTS.md` from the repo root. No extra setup needed if you clone the repo.

### Gemini CLI

Gemini CLI automatically reads `GEMINI.md` from the repo root. No extra setup needed if you clone the repo.

### OpenClaw

```bash
cp -r skills/openclaw ~/.openclaw/workspace/skills/agent-bridge
```

### Any other agent

Reference `INSTRUCTIONS.md` in your agent's config, or paste its contents into your agent's system prompt. It contains a plain-English description of all commands.

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
4. The pairing screen displays all connection info (local IP, public IP, token, **public key**)
5. The other machine reads the pairing info (from photo or manual entry)
6. `pair` adds the other machine's public key to the LOCAL `~/.ssh/authorized_keys`
7. This authorizes the other machine to SSH into this one -- no password needed
8. For bidirectional access, both machines run `pair` with each other's details
9. No SSH connection is made during pairing -- it's pure local key exchange

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

- **SSH key-based auth only** — zero passwords in the entire flow
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

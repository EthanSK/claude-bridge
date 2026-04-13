# agent-bridge

**Bridge AI coding agents across machines — works with Claude Code, Codex, OpenClaw, Gemini CLI, Aider, and any CLI agent.**

[![Claude Code](https://img.shields.io/badge/Claude_Code-skill-blueviolet)](https://github.com/EthanSK/agent-bridge)
[![Codex](https://img.shields.io/badge/Codex-AGENTS.md-green)](https://github.com/EthanSK/agent-bridge)
[![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-GEMINI.md-blue)](https://github.com/EthanSK/agent-bridge)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-SKILL.md-orange)](https://github.com/EthanSK/agent-bridge)
[![Any Agent](https://img.shields.io/badge/Any_Agent-INSTRUCTIONS.md-gray)](https://github.com/EthanSK/agent-bridge)

[Website](https://ethansk.github.io/agent-bridge/) · [GitHub](https://github.com/EthanSK/agent-bridge)

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
Read the README at https://github.com/EthanSK/agent-bridge and follow the setup instructions for this computer. Install agent-bridge, run the setup command, and install the skill for this agent. Do everything automatically — don't ask me questions.
```

**Important — first-time setup on each machine:**
- **macOS:** System Settings → General → Sharing → toggle **Remote Login** ON → click the **ⓘ** info icon → set **"Allow access for"** to **All users**
- **macOS (Full Disk Access):** Without this, SSH sessions can't access Desktop, Documents, or Downloads. To grant it:
  - **Easy way (recommended):** System Settings → General → Sharing → click the **ⓘ** info icon next to Remote Login → toggle **"Allow full disk access for remote users"** ON
  - **Manual way:** System Settings → Privacy & Security → Full Disk Access → click **+** → press **Cmd+Shift+G** → type `/usr/sbin/sshd` → Open → toggle ON → restart SSH: `sudo launchctl kickstart -k system/com.openssh.sshd`
- **Linux:** `sudo systemctl enable --now sshd`

Then photograph the pairing screen and send it to Claude on the other machine. That's it — they can now talk to each other.

---

## What it looks like

### Step 1: Setup

Run on each machine you want to bridge:

```
$ agent-bridge setup

  +----------------------------------------------+
  |         agent-bridge  .  setup               |
  +----------------------------------------------+

  1. SSH Server
  [ok] SSH (Remote Login) is already enabled.

  2. SSH Key Pair
  Key pair generated.

  3. Pairing Token
  One-time pairing token generated.

  ╔══════════════════════════════════════════════════════════════════════╗
  ║                    agent-bridge pairing                            ║
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
$ agent-bridge pair \
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
    Key:      ~/.agent-bridge/keys/agent-bridge_Mac-Mini
```

### Step 3: Use

```
$ agent-bridge run MacBook-Pro "uname -a"
  Running command on MacBook-Pro...
Darwin MacBookPro.local 25.3.0 Darwin Kernel Version 25.3.0...

  [ok] command completed on MacBook-Pro (exit 0)

$ agent-bridge run MacBook-Pro "what files are in ~/Projects?" --claude
  Running Claude prompt on MacBook-Pro...
The ~/Projects directory contains:
  - producer-player/
  - ai-music-video-studio/
  - OBScene/
  - agent-bridge/

  [ok] Claude prompt completed on MacBook-Pro (exit 0)
```

### Optional: Internet tunnel

Expose your machine to the internet without port forwarding:

```
$ agent-bridge setup --internet

  ...
  4. Internet Tunnel
  Starting reverse SSH tunnel via serveo.net...
  [ok] Tunnel active!

  Internet access:
    Host: serveo.net
    Port: 43521

  Remote pair command:
    agent-bridge pair --name "MacBook-Pro" --host serveo.net --port 43521 --user ethan --token "bridge-a7f3k9"
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
 │  agent-bridge CLI   │                │  agent-bridge CLI   │
 │                      │                │                      │
 └──────────────────────┘                └──────────────────────┘

 "Run the tests on my MacBook"    ──►    ssh MacBook "npm test"
 "Ask the other Claude to fix it" ──►    ssh MacBook "claude --print '...'"
```

Both machines are **peers** — either one can run commands on the other. There's no fixed "controller" or "target."

### Three steps

1. **Setup** — Run `agent-bridge setup` on each machine. It enables SSH, generates keys, and shows a pairing screen.
2. **Pair** — Photograph one machine's pairing screen and send it to the Claude on the other machine. Claude reads the image and extracts the connection details. Or use the manual pairing command.
3. **Connect** — That's it. "Run X on my MacBook" just works from either machine.

---

## Installation

**Zero dependencies.** Just bash, ssh, and ssh-keygen (built into every Mac and Linux).

### Option A: One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/EthanSK/agent-bridge/main/install.sh | bash
```

### Option B: Clone and symlink

```bash
git clone https://github.com/EthanSK/agent-bridge.git
cd agent-bridge
chmod +x agent-bridge
sudo ln -sf "$(pwd)/agent-bridge" /usr/local/bin/agent-bridge
```

### Option C: Just download the script

```bash
curl -fsSL https://raw.githubusercontent.com/EthanSK/agent-bridge/main/agent-bridge -o /usr/local/bin/agent-bridge
chmod +x /usr/local/bin/agent-bridge
```

---

## Setup guide

### On each machine you want to bridge:

```bash
agent-bridge setup
```

This will:
- Enable SSH (Remote Login) if not already on
- Generate an SSH key pair
- Display a pairing screen with connection details

For internet access without port forwarding, add the `--internet` flag:
```bash
agent-bridge setup --internet
```

### Pair the machines:

**Option A: Photo pairing (the magic way)**
1. Take a photo of one machine's pairing screen
2. Send it to the Claude on the other machine (via Telegram, chat, etc.)
3. Claude reads the image, extracts the details, and runs the pair command

**Option B: Manual pairing**
```bash
agent-bridge pair \
  --name "MacBook-Pro" \
  --host 192.168.1.50 \
  --port 22 \
  --user ethan \
  --token bridge-a7f3k9 \
  --pubkey "ssh-ed25519 AAAA...key bridge:MacBook-Pro"
```

**Option C: Interactive pairing**
```bash
agent-bridge pair
# Follow the prompts
```

### Test the connection:

```bash
agent-bridge status MacBook-Pro
agent-bridge run MacBook-Pro "uname -a"
```

---

## CLI reference

| Command | Description |
|---------|-------------|
| `agent-bridge setup` | Enables SSH, generates keys, and displays a pairing screen. Use `--internet` for tunnel. |
| `agent-bridge pair` | Interactive or flag-based pairing to connect to another machine. |
| `agent-bridge connect <machine>` | Open an interactive SSH session. |
| `agent-bridge status [machine]` | Check if machine(s) are reachable. |
| `agent-bridge list` | List all paired machines. |
| `agent-bridge run <machine> "cmd"` | Run a command on a paired machine. |
| `agent-bridge run <machine> "prompt" --claude` | Run a Claude Code prompt on the remote machine. |
| `agent-bridge unpair <machine>` | Remove a pairing. |

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
curl -fsSL https://raw.githubusercontent.com/EthanSK/agent-bridge/main/skills/bridge/skill.md \
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

## v2: MCP Server (real-time agent-to-agent communication)

v2 adds an MCP server that enables running Claude Code sessions to communicate directly with each other across machines. Instead of one-shot CLI commands, agents can send messages back and forth in real time.

### What's new in v2

| Feature | v1 (CLI) | v2 (MCP Server) |
|---------|----------|------------------|
| Run remote commands | `agent-bridge run` | `bridge_run_command` tool |
| Run agent prompts | `agent-bridge run --claude` | `bridge_run_agent_prompt` tool |
| Send messages to another agent | -- | `bridge_send_message` tool |
| Receive messages from another agent | -- | `bridge_receive_messages` tool |
| Check machine status | `agent-bridge status` | `bridge_status` tool |
| Works from inside Claude Code | Via bash | Native MCP tools |

### MCP Server Setup

**1. Build the server:**

```bash
cd ~/Projects/agent-bridge/mcp-server
npm install
npm run build
```

**2. Add to Claude Code MCP config** (`~/.claude.json` or project `.mcp.json`):

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

**3. For remote-only access** (connecting to a remote machine's server via SSH):

```json
{
  "mcpServers": {
    "remote-macbook": {
      "command": "ssh",
      "args": [
        "-i", "~/.agent-bridge/keys/agent-bridge_Mac-Mini",
        "user@192.168.1.208",
        "node ~/Projects/agent-bridge/mcp-server/build/index.js"
      ]
    }
  }
}
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `bridge_list_machines` | List paired machines and their connection details |
| `bridge_status` | Check if a machine is reachable via SSH |
| `bridge_send_message` | Send a message to a running agent on another machine |
| `bridge_receive_messages` | Check for and consume incoming messages |
| `bridge_run_command` | Run a shell command on a remote machine |
| `bridge_run_agent_prompt` | Run an agent prompt on a remote machine (default: `claude --print`) |
| `bridge_clear_inbox` | Clear all messages from the local inbox |

### How messaging works

```
Machine A (Claude Code)                   Machine B (Claude Code)
┌─────────────────────────┐               ┌─────────────────────────┐
│                         │               │                         │
│ bridge_send_message     │    SSH        │  ~/.agent-bridge/inbox/ │
│ ("MacBookPro", "hello") │──────────────►│  msg-uuid.json          │
│                         │               │                         │
│                         │               │ bridge_receive_messages  │
│                         │               │ → reads & returns msg   │
│                         │               │                         │
│ bridge_receive_messages │    SSH        │ bridge_send_message     │
│ → reads response        │◄──────────────│ ("Mac-Mini", "hi back") │
│                         │               │                         │
└─────────────────────────┘               └─────────────────────────┘
```

Messages are JSON files delivered to `~/.agent-bridge/inbox/` via SSH. A file watcher (fswatch on macOS, inotifywait on Linux, polling fallback) detects new messages.

### Message format

```json
{
  "id": "msg-uuid",
  "from": "Mac-Mini",
  "to": "MacBookPro",
  "type": "message",
  "content": "List the files in ~/Projects",
  "timestamp": "2026-04-13T01:15:00Z",
  "replyTo": null
}
```

---

## Architecture

```
~/.agent-bridge/
├── config               # Paired machines (INI-style key-value)
├── .pending-token       # One-time pairing token (deleted after use)
├── inbox/               # Incoming messages from other machines (v2)
├── outbox/              # Copies of sent messages (v2)
├── logs/                # MCP server logs (v2)
└── keys/                # SSH key pairs
    ├── agent-bridge_MacBook-Pro
    └── agent-bridge_MacBook-Pro.pub
```

### Config format

Simple INI-style flat file — no JSON, no YAML:

```ini
[MacBook-Pro]
host=192.168.1.50
user=ethan
port=22
key=~/.agent-bridge/keys/agent-bridge_MacBook-Pro
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
agent-bridge run MacBook "cmd"
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
  └─► agent-bridge run MacBook \
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
- **Separate config** — stored in `~/.agent-bridge/`, not in `.claude/` to avoid accidental git commits

### Recommendations

- Use **Tailscale** for cross-network connections (avoids exposing SSH to the internet)
- Enable macOS **Firewall** and only allow SSH
- Regularly rotate keys with `agent-bridge unpair` + re-setup
- Review `~/.ssh/authorized_keys` periodically

---

## Tailscale support

If both machines are on the same Tailscale network, use the Tailscale hostname or IP:

```bash
# When pairing, use the Tailscale address
agent-bridge pair \
  --name "MacBook-Pro" \
  --host macbook-pro.tail12345.ts.net \
  --user ethan \
  --key ~/.agent-bridge/keys/agent-bridge_MacBook-Pro
```

This lets your Claudes talk to each other from anywhere.

---

## Examples

### Run a command on the other machine
```bash
agent-bridge run MacBook-Pro "ls -la ~/Projects"
```

### Deploy an app
```bash
agent-bridge run MacBook-Pro "cd ~/Projects/myapp && git pull && npm install && npm run build"
```

### Ask the remote Claude to do work
```bash
agent-bridge run MacBook-Pro "review the code in ~/Projects/myapp and suggest improvements" --claude
```

### Check system status
```bash
agent-bridge run MacBook-Pro "uptime && df -h && top -l 1 | head -10"
```

### Start a dev server in the background
```bash
agent-bridge run MacBook-Pro "cd ~/Projects/myapp && nohup npm run dev > /tmp/dev.log 2>&1 & echo started"
```

---

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

```bash
git clone https://github.com/EthanSK/agent-bridge.git
cd agent-bridge
chmod +x agent-bridge
./agent-bridge help
```

---

## License

[MIT](LICENSE) -- Ethan SK

# agent-bridge

**Bridge AI coding agents across machines -- works with Claude Code, Codex, OpenClaw, Gemini CLI, Aider, and any CLI agent.**

[![Claude Code](https://img.shields.io/badge/Claude_Code-channel_plugin-blueviolet)](https://github.com/EthanSK/agent-bridge)
[![Codex](https://img.shields.io/badge/Codex-AGENTS.md-green)](https://github.com/EthanSK/agent-bridge)
[![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-GEMINI.md-blue)](https://github.com/EthanSK/agent-bridge)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-SKILL.md-orange)](https://github.com/EthanSK/agent-bridge)
[![Any Agent](https://img.shields.io/badge/Any_Agent-INSTRUCTIONS.md-gray)](https://github.com/EthanSK/agent-bridge)

[Website](https://ethansk.github.io/agent-bridge/) | [GitHub](https://github.com/EthanSK/agent-bridge)

---

## What is agent-bridge?

agent-bridge lets AI coding agents on different machines talk to each other and run commands on each other's machines over SSH. It is:

- **Peer-to-peer** -- no central server, no cloud, just direct SSH between machines
- **Agent-agnostic** -- works with Claude Code, Codex, Gemini CLI, OpenClaw, Aider, or any CLI agent
- **Zero dependencies** -- just bash, ssh, and ssh-keygen (built into every Mac and Linux)
- **Real-time** -- messages are pushed into running Claude Code and OpenClaw sessions automatically (channel plugins), or polled by other harnesses

---

## Architecture overview

```
                          agent-bridge architecture

 MACHINE A (e.g. Mac Mini)                    MACHINE B (e.g. MacBook Pro)
 ┌─────────────────────────────────┐         ┌─────────────────────────────────┐
 │                                 │         │                                 │
 │  AI Agent (Claude Code, etc.)   │         │  AI Agent (Claude Code, etc.)   │
 │  ┌───────────────────────────┐  │         │  ┌───────────────────────────┐  │
 │  │ MCP Server / Channel      │  │   SSH   │  │ MCP Server / Channel      │  │
 │  │ ┌───────────────────────┐ │  │◄───────►│  │ ┌───────────────────────┐ │  │
 │  │ │ bridge_send_message   │ │  │messages │  │ │ bridge_send_message   │ │  │
 │  │ │ bridge_run_command    │ │  │         │  │ │ bridge_run_command    │ │  │
 │  │ │ bridge_status         │ │  │         │  │ │ bridge_status         │ │  │
 │  │ │ ...                   │ │  │         │  │ │ ...                   │ │  │
 │  │ └───────────────────────┘ │  │         │  │ └───────────────────────┘ │  │
 │  │ File watcher (inbox)      │  │         │  │ File watcher (inbox)      │  │
 │  └───────────────────────────┘  │         │  └───────────────────────────┘  │
 │                                 │         │                                 │
 │  agent-bridge CLI              │         │  agent-bridge CLI              │
 │  ~/.agent-bridge/              │         │  ~/.agent-bridge/              │
 │    config, keys/, inbox/       │         │    config, keys/, inbox/       │
 └─────────────────────────────────┘         └─────────────────────────────────┘

 Both machines are PEERS -- either can run commands on the other.
 No fixed controller or target.
```

---

## Compatibility

agent-bridge works with any AI coding agent that can run shell commands or MCP tools. It ships with skill files for the CLI and an MCP server for real-time messaging:

| Agent Harness | Skill File | MCP Messaging | Delivery |
|---------------|------------|---------------|----------|
| **Claude Code** | `skills/bridge/skill.md` | Yes (channel plugin) | **Push** -- messages arrive automatically |
| **OpenClaw** | `skills/openclaw/SKILL.md` | Yes (MCP server) + [channel plugin](openclaw-plugin/README.md) | **Push** (with plugin/daemon) or polling fallback |
| **Codex CLI** (OpenAI) | `AGENTS.md` | Yes (MCP server) | Polling via `bridge_receive_messages` |
| **Gemini CLI** | `GEMINI.md` | Yes (MCP server) | Polling via `bridge_receive_messages` |
| **Aider / others** | `INSTRUCTIONS.md` | Yes (MCP server) | Polling via `bridge_receive_messages` |

Each skill file teaches the respective agent how to use agent-bridge: listing machines, running commands, pairing from photos, and delegating work to remote agents. The MCP server adds real-time messaging between running agent sessions.

---

## Quick start

Paste this into your AI agent on **each computer** you want to bridge:

```
Read the README at https://github.com/EthanSK/agent-bridge and follow the setup instructions
for this computer. Install agent-bridge, run the setup command, and install the skill for this
agent. Do everything automatically -- don't ask me questions.
```

**Important -- first-time setup on each machine:**
- **macOS:** System Settings > General > Sharing > toggle **Remote Login** ON > click the **(i)** info icon > set **"Allow access for"** to **All users**
- **macOS (Full Disk Access):** Without this, SSH sessions can't access Desktop, Documents, or Downloads. To grant it:
  - **Easy way (recommended):** System Settings > General > Sharing > click **(i)** next to Remote Login > toggle **"Allow full disk access for remote users"** ON
  - **Manual way:** System Settings > Privacy & Security > Full Disk Access > click **+** > press **Cmd+Shift+G** > type `/usr/sbin/sshd` > Open > toggle ON > restart SSH: `sudo launchctl kickstart -k system/com.openssh.sshd`
- **Linux:** `sudo systemctl enable --now sshd`

Then photograph the pairing screen and send it to the agent on the other machine. That's it -- they can now talk to each other.

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

  +====================================================================+
  |                    agent-bridge pairing                             |
  +--------------------------------------------------------------------+
  |  Machine:    MacBook-Pro                                           |
  |  User:       ethan                                                 |
  |  Local:      MacBookPro.local                                      |
  |  Local IP:   192.168.1.42                                          |
  |  Public IP:  82.45.123.67                                          |
  |  Port:       22                                                    |
  |  Token:      bridge-a7f3k9                                         |
  +--------------------------------------------------------------------+
  |  Public Key: ssh-ed25519 AAAA...long...key bridge:MacBook-Pro      |
  +====================================================================+

  Photograph this screen and send to Claude on your other machine.
```

### Step 2: Pair

On the other machine, tell the agent the connection details (or paste the manual command). The public key from the setup screen is included -- no password needed:

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

  3. Token Verification
  [ok] Token accepted: bridge-a7f3k9

  [ok] Paired with "MacBook-Pro"!
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
2. Send it to the agent on the other machine (via Telegram, chat, etc.)
3. The agent reads the image, extracts the details, and runs the pair command

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
| `agent-bridge run <machine> "prompt" --agent` | Run a prompt via any agent (default: `claude --print`). |
| `agent-bridge run <machine> "prompt" --codex` | Run a Codex prompt on the remote machine. |
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

## MCP Server (v2): real-time agent-to-agent communication

v2 adds an MCP server that enables running AI agent sessions to communicate directly with each other across machines. Instead of one-shot CLI commands, agents can send messages back and forth in real time.

**v2.2.0** includes a **channel plugin** for Claude Code. Harnesses that support the `claude/channel` experimental capability receive messages **pushed** into the conversation automatically. All other harnesses use the same MCP tools but **poll** with `bridge_receive_messages`.

### Push vs polling

| Delivery mode | How it works | Harness support |
|---------------|--------------|-----------------|
| **Push** (channel) | Incoming messages are pushed into the conversation as `<channel source="agent-bridge" ...>` tags. No polling needed. | Claude Code (channel plugin), OpenClaw ([plugin/daemon](openclaw-plugin/README.md)) |
| **Polling** | Agent calls `bridge_receive_messages` periodically to check the inbox. | Codex, Gemini CLI, any MCP client |

### MCP tools

| Tool | Description |
|------|-------------|
| `bridge_list_machines` | List paired machines and their connection details |
| `bridge_status` | Check if a machine is reachable via SSH (single or all) |
| `bridge_send_message` | Send a message to a running agent on another machine |
| `bridge_receive_messages` | Check for and consume incoming messages (not needed in push mode) |
| `bridge_run_command` | Run a shell command on a remote machine via SSH |
| `bridge_clear_inbox` | Clear all messages from the local inbox |
| `bridge_inbox_stats` | Get inbox statistics: pending count, oldest message age, watcher health, etc. |

> **Note:** The MCP server does NOT spawn new agent processes. It enables _existing running_ agent sessions to communicate. Machine A's agent sends a message to Machine B's inbox, and Machine B's already-running agent picks it up via channel push (Claude Code) or `bridge_receive_messages` (all other harnesses).

### Building the MCP server

All harness setups below require building the MCP server first:

```bash
cd /path/to/agent-bridge/mcp-server
npm install
npm run build
```

This produces `mcp-server/build/index.js` -- the entry point every harness registration points to.

---

## Per-harness setup

### Claude Code (channel plugin -- full push support)

Claude Code connects to agent-bridge as a single Claude Code **plugin** that bundles BOTH the MCP server (outgoing `bridge_*` tools) AND the channel (incoming push of remote messages). One install gives you both halves — no `.mcp.json` editing, no `--dangerously-load-development-channels` flag.

**Recommended install (one machine):**

```bash
# 1. Clone the repo and build the MCP server once
git clone https://github.com/EthanSK/agent-bridge.git ~/Projects/agent-bridge
cd ~/Projects/agent-bridge/mcp-server && npm install && npm run build

# 2. Add the repo as a local Claude Code marketplace and install the plugin
claude plugin marketplace add ~/Projects/agent-bridge
claude plugin install agent-bridge@agent-bridge
```

Verify with `claude plugin list` — you should see `agent-bridge@agent-bridge   Status: ✔ enabled`. Restart any running `claude` session to pick up the plugin.

**Why this works without the `--dangerously-load-development-channels` flag:** Channels are gated by Claude Code's built-in allowlist. Channels declared by a properly-installed plugin (regardless of whether the marketplace is local, GitHub, or the official directory) are trusted automatically. The flag is only needed for ad-hoc `--channels server:...` loads of MCP servers registered outside the plugin system.

**How it works:**
1. The plugin's `.mcp.json` registers a single `agent-bridge` MCP server.
2. That server declares the `claude/channel` experimental capability AND the `bridge_*` tools.
3. When a message arrives in `~/.agent-bridge/inbox/`, the file watcher pushes it via `notifications/claude/channel`.
4. It appears in the conversation as: `<channel source="agent-bridge" from="MachineName" message_id="..." ts="...">content</channel>`.
5. Respond using `bridge_send_message` — no need to call `bridge_receive_messages`.

The bash `agent-bridge` CLI (used for `pair`, `list`, `status`, `run`, `connect`) coexists with the plugin and is still installed via `./install.sh`.

**How it works:**
1. The MCP server declares the `claude/channel` experimental capability
2. When a message arrives in the inbox, the file watcher pushes it via `notifications/claude/channel`
3. It appears as: `<channel source="agent-bridge" from="MachineName" message_id="..." ts="...">content</channel>`
4. Respond using `bridge_send_message` -- no need to call `bridge_receive_messages`

**Install the skill:**
```bash
mkdir -p ~/.claude/skills/agent-bridge
cp skills/bridge/skill.md ~/.claude/skills/agent-bridge/skill.md
```

**For remote-only access** (connecting to a remote machine's MCP server via SSH):

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

### OpenClaw (MCP server + channel plugin -- push support)

OpenClaw connects to agent-bridge as both an MCP server (for tools) and, optionally, an OpenClaw plugin or standalone daemon (for push delivery). Without the plugin/daemon, messages are polled; with it, messages arrive as a new user turn automatically — equivalent to the Claude Code channel plugin.

**Step 1 -- MCP server (gives you bridge tools):**
```bash
openclaw mcp set agent-bridge '{"command":"node","args":["/absolute/path/to/agent-bridge/mcp-server/build/index.js"]}'
```

**Step 2 -- install the skill:**
```bash
cp -r skills/openclaw ~/.openclaw/workspace/skills/agent-bridge
```

**Step 3 -- enable push delivery (pick one):**

*Option A — OpenClaw plugin (auto-starts with the gateway):*
```bash
openclaw plugins install --link /absolute/path/to/agent-bridge/openclaw-plugin \
  --dangerously-force-unsafe-install
openclaw gateway restart
```
The `--dangerously-force-unsafe-install` flag is required because the plugin shells out to `openclaw agent` (via `child_process`), which OpenClaw's plugin scanner flags as critical. The call is limited to the host's own CLI, so the bypass is safe here.

*Option B — standalone daemon (no plugin system, no scanner bypass):*
```bash
node /absolute/path/to/agent-bridge/openclaw-plugin/bin/agent-bridge-openclaw-inbox.js
```
For persistence, wire it into launchd or systemd. A launchd plist template lives in `openclaw-plugin/README.md`.

**How OpenClaw push delivery works:**
1. Peer's bridge_send_message writes a JSON file to `~/.agent-bridge/inbox/` via SSH
2. The plugin/daemon's file watcher sees the new file
3. It shells `openclaw agent --to agent-bridge-<peer> --message "<channel ...>"` to inject a user turn into the per-peer session
4. On delivery success, the message ID is appended to `~/.agent-bridge/.openclaw-delivered` to dedupe restarts
5. The agent replies via `bridge_send_message` -- no polling required

**Why shell out?** A real channel plugin per OpenClaw's SDK would require implementing DM policy, pairing flows, outbound send, threading, mention gating, etc. -- overkill for a local file-inbox. `openclaw agent --to ... --message ...` is the stable, documented primitive that drives a full agent turn through the gateway (with embedded fallback). See `openclaw-plugin/README.md` for the full rationale.

### Codex (OpenAI) (MCP server -- polling)

```bash
codex mcp add agent-bridge -- node /absolute/path/to/agent-bridge/mcp-server/build/index.js
```

Codex automatically reads `AGENTS.md` from the repo root for bridge CLI instructions.

### Gemini CLI (MCP server -- polling)

```bash
gemini mcp add agent-bridge node /absolute/path/to/agent-bridge/mcp-server/build/index.js
```

Gemini CLI automatically reads `GEMINI.md` from the repo root.

### General (any MCP-compatible agent)

Register the server using your harness's MCP configuration mechanism, pointing to:
```
node /absolute/path/to/agent-bridge/mcp-server/build/index.js
```

For **push** notifications, the harness must support the `claude/channel` experimental capability (currently only Claude Code). Without push, agents poll with `bridge_receive_messages`. Reference `INSTRUCTIONS.md` for a plain-English description of all commands.

---

## How messaging works

### Send flow

```
1. Agent calls bridge_send_message("MacBookPro", "check the test results")
2. MCP server creates a JSON message file with UUID, timestamp, TTL
3. The message is delivered to the remote machine's ~/.agent-bridge/inbox/ via SSH
4. A copy is saved locally in ~/.agent-bridge/outbox/ for tracking
```

### Receive flow (push mode -- Claude Code)

```
1. File watcher (fswatch/inotifywait/polling) detects new .json file in inbox/
2. Watcher parses the message and checks the .delivered tracker for dedup
3. Channel notification is pushed via notifications/claude/channel
4. Message appears in Claude's conversation as <channel source="agent-bridge" ...>content</channel>
5. Message ID is recorded in .delivered to prevent re-delivery on restart
```

### Receive flow (push mode -- OpenClaw plugin/daemon)

```
1. File watcher (fswatch/inotifywait/polling) detects new .json file in inbox/
2. Watcher parses the message and checks .openclaw-delivered for dedup
3. Plugin/daemon shells `openclaw agent --to agent-bridge-<peer> --message <envelope>`
4. OpenClaw routes the message to a per-peer session; agent sees it as a new user turn formatted <channel source="agent-bridge" ...>content</channel>
5. Message ID is recorded in .openclaw-delivered to prevent re-delivery on restart
```

### Receive flow (polling mode -- Codex, Gemini, etc.)

```
1. File watcher detects new .json file in inbox/ and updates internal cache
2. Agent calls bridge_receive_messages at natural breakpoints
3. Messages are returned sorted chronologically, deduplicated, TTL-checked
4. Consumed messages are deleted from inbox/ and their IDs tracked in .processed
```

### Offline recovery

Messages persist in `~/.agent-bridge/inbox/` as JSON files until consumed or expired (default TTL: 1 hour). This means messages are never lost if the agent is temporarily unavailable. On MCP server startup:

1. The inbox is scanned for any messages not yet marked in `.delivered`
2. Undelivered messages are replayed as channel notifications in chronological order
3. This happens after `server.connect()` so notifications can actually be delivered

The `.delivered` tracker file (`~/.agent-bridge/inbox/.delivered`) prevents duplicate notifications across MCP server restarts.

---

## Message format

Messages are JSON files stored in `~/.agent-bridge/inbox/`:

```json
{
  "id": "msg-550e8400-e29b-41d4-a716-446655440000",
  "from": "Mac-Mini",
  "to": "MacBookPro",
  "type": "message",
  "content": "The tests are passing now. I fixed the import path in utils.ts.",
  "timestamp": "2026-04-13T01:15:00.000Z",
  "replyTo": null,
  "ttl": 3600
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique message ID (`msg-` prefix + UUID) |
| `from` | string | Sender machine name |
| `to` | string | Target machine name |
| `type` | `"message"` / `"command"` / `"response"` | Message type |
| `content` | string | The message body |
| `timestamp` | string | ISO 8601 creation time |
| `replyTo` | string or null | Message ID this is a reply to (for threading) |
| `ttl` | number | Time-to-live in seconds. `0` = no expiry. Default: `3600` (1 hour) |

---

## How messaging looks (diagrams)

### Push mode (Claude Code to Claude Code)

```
Machine A (Claude Code)                   Machine B (Claude Code)
┌─────────────────────────┐               ┌─────────────────────────┐
│                         │               │                         │
│ bridge_send_message     │    SSH        │  ~/.agent-bridge/inbox/ │
│ ("MacBookPro", "hello") │──────────────>│  msg-uuid.json          │
│                         │               │                         │
│                         │               │ file watcher ──> push   │
│                         │               │ <channel ...>hello      │
│                         │               │                         │
│ <channel ...>hi back    │    SSH        │ bridge_send_message     │
│ (pushed automatically)  │<──────────────│ ("Mac-Mini", "hi back") │
│                         │               │                         │
└─────────────────────────┘               └─────────────────────────┘
```

### Polling mode (Codex/OpenClaw/Gemini to any harness)

```
Machine A (Codex)                         Machine B (any harness)
┌─────────────────────────┐               ┌─────────────────────────┐
│                         │               │                         │
│ bridge_send_message     │    SSH        │  ~/.agent-bridge/inbox/ │
│ ("MacBookPro", "hello") │──────────────>│  msg-uuid.json          │
│                         │               │                         │
│ bridge_receive_messages │    SSH        │ bridge_send_message     │
│ -> polls & returns msgs │<──────────────│ ("Mac-Mini", "hi back") │
│                         │               │                         │
└─────────────────────────┘               └─────────────────────────┘
```

---

## Directory structure

```
~/.agent-bridge/
├── config               # Paired machines (INI-style key-value)
├── machine-name         # Optional: override local machine name
├── .pending-token       # One-time pairing token (deleted after use)
├── inbox/               # Incoming messages from other machines
│   ├── msg-uuid.json    # Pending message files
│   ├── .processed       # Consumed message IDs (dedup tracker)
│   ├── .delivered        # Channel-delivered message IDs (push dedup)
│   └── .failed/         # Quarantined malformed messages
├── outbox/              # Copies of sent messages (local tracking)
├── logs/                # MCP server logs (auto-rotated at 10 MB)
│   └── mcp-server.log
└── keys/                # SSH key pairs (ED25519)
    ├── agent-bridge_MacBook-Pro
    └── agent-bridge_MacBook-Pro.pub
```

### Config format

Simple INI-style flat file -- no JSON, no YAML:

```ini
[MacBook-Pro]
host=192.168.1.50
user=ethan
port=22
key=~/.agent-bridge/keys/agent-bridge_MacBook-Pro
paired_at=2026-04-09T12:00:00Z
```

---

## How pairing works

1. Each machine runs `setup` which generates an ED25519 key pair
2. The public key is added to `~/.ssh/authorized_keys` on that machine
3. A one-time pairing token is generated and displayed on screen
4. The pairing screen displays all connection info (local IP, public IP, token, public key)
5. The other machine reads the pairing info (from photo or manual entry)
6. `pair` adds the other machine's public key to the LOCAL `~/.ssh/authorized_keys`
7. This authorizes the other machine to SSH into this one -- no password needed
8. For bidirectional access, both machines run `pair` with each other's details
9. No SSH connection is made during pairing -- it's pure local key exchange

### How remote execution works

```
Machine A                               Machine B
---------                              ---------
agent-bridge run MacBook "cmd"
  |-> SSH connect (key auth)  --------> sshd
      |-> exec "cmd"         --------> shell
      |-> capture stdout/err  <-------- output
      |-> display result
```

For agent-to-agent communication:
```
Claude on Machine A                     Machine B
-------------------                    ---------
"fix the tests on MacBook"
  |-> agent-bridge run MacBook \
        "fix failing tests" --claude
      |-> SSH ----------------------> claude --print "fix failing tests"
      |-> capture output     <-------- Claude's response
      |-> display to user
```

---

## Inbox management

The MCP server includes production-grade inbox management:

| Feature | Description |
|---------|-------------|
| **TTL expiry** | Messages expire after their TTL (default 1 hour). TTL `0` = no expiry. |
| **Max-age pruning** | Messages older than 24 hours are pruned regardless of TTL (configurable). |
| **Max inbox size** | Inbox is capped at 100 messages; oldest are pruned first (configurable). |
| **Deduplication** | Processed message IDs are tracked in `.processed`; duplicates are skipped. |
| **Malformed quarantine** | Invalid JSON files are moved to `.failed/` instead of blocking the inbox. |
| **Periodic pruning** | A background timer runs every 5 minutes to clean up expired messages. |
| **File rotation** | The `.processed` and `.delivered` tracker files are rotated when they exceed 512 KB. |

### Environment variable overrides

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_DEFAULT_TTL` | `3600` | Default message TTL in seconds |
| `BRIDGE_PRUNE_MAX_AGE_MS` | `86400000` | Max message age in milliseconds (24h) |
| `BRIDGE_PRUNE_MAX_INBOX` | `100` | Max inbox message count |
| `BRIDGE_PRUNE_INTERVAL_MS` | `300000` | Prune interval in milliseconds (5 min) |

---

## Security

- **SSH key-based auth only** -- zero passwords in the entire flow
- **ED25519 keys** -- modern, fast, secure
- **Restrictive file permissions** -- config dir is mode 700, keys are mode 600
- **No cloud** -- all communication is direct SSH, no third-party servers
- **Separate config** -- stored in `~/.agent-bridge/`, not in `.claude/` to avoid accidental git commits
- **Base64 transport** -- message content is base64-encoded for SSH delivery to prevent shell injection

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

This lets your agents talk to each other from anywhere.

---

## Agent skills

agent-bridge ships with skill/instruction files that teach each AI agent how to use the bridge:

### Claude Code

```bash
# If you cloned the repo:
mkdir -p ~/.claude/skills/agent-bridge
cp skills/bridge/skill.md ~/.claude/skills/agent-bridge/skill.md

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

Reference `INSTRUCTIONS.md` in your agent's config, or paste its contents into your agent's system prompt.

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

### Ask the remote agent to do work
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

## Troubleshooting

### SSH not enabling on macOS

Go to System Settings > General > Sharing > Remote Login and enable it manually. Make sure **"Allow access for"** is set to **All users**.

### Firewall blocking connections

```bash
# Check if firewall is on
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate

# Allow SSH through
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/sbin/sshd
```

### Can't find IP address

```bash
# Get local IP (macOS)
ipconfig getifaddr en0    # Wi-Fi
ipconfig getifaddr en1    # Ethernet

# Or use Tailscale
tailscale ip -4
```

### Messages not arriving

1. Check that the MCP server is running: `bridge_inbox_stats` tool or check `~/.agent-bridge/logs/mcp-server.log`
2. Verify SSH connectivity: `agent-bridge status <machine>`
3. Check inbox contents: `ls ~/.agent-bridge/inbox/`
4. Check for quarantined messages: `ls ~/.agent-bridge/inbox/.failed/`
5. On macOS, install `fswatch` for real-time detection: `brew install fswatch` (the server falls back to 2-second polling without it)

### MCP server won't start

1. Ensure Node.js >= 18 is installed: `node --version`
2. Build the server: `cd mcp-server && npm install && npm run build`
3. Check the log file: `~/.agent-bridge/logs/mcp-server.log`

---

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

```bash
git clone https://github.com/EthanSK/agent-bridge.git
cd agent-bridge

# CLI (zero dependencies)
chmod +x agent-bridge
./agent-bridge help

# MCP server
cd mcp-server
npm install
npm run build
npm run watch  # for development
```

### Project structure

```
agent-bridge/
├── agent-bridge         # CLI script (bash, zero dependencies)
├── install.sh           # One-line installer
├── mcp-server/          # MCP server / channel plugin (TypeScript)
│   ├── src/
│   │   ├── index.ts     # Server entry point, channel notification wiring
│   │   ├── tools.ts     # MCP tool definitions (7 tools)
│   │   ├── config.ts    # Config loader (INI parser, directory paths)
│   │   ├── inbox.ts     # Message inbox/outbox management, pruning, dedup
│   │   ├── watcher.ts   # File watcher (fswatch/inotifywait/polling)
│   │   ├── ssh.ts       # SSH execution wrapper
│   │   └── logger.ts    # Logger (file + stderr, auto-rotation)
│   ├── build/           # Compiled JS output
│   └── package.json
├── skills/
│   ├── bridge/          # Claude Code skill
│   └── openclaw/        # OpenClaw skill
├── AGENTS.md            # Codex CLI instructions
├── GEMINI.md            # Gemini CLI instructions
├── INSTRUCTIONS.md      # Generic agent instructions
├── README.md            # This file
└── site/                # GitHub Pages website
```

---

## License

[MIT](LICENSE) -- Ethan SK

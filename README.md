# claude-bridge

**Let your Claude Code instances talk to each other across machines.**

claude-bridge enables Claude-to-Claude communication between two computers. One machine is the "controller" (your main workstation), the other is the "target" (a secondary machine). The controller Claude can run commands, edit files, and even start Claude Code sessions on the target — all over SSH.

[Website](https://ethansk.github.io/claude-bridge/) · [GitHub](https://github.com/EthanSK/claude-bridge) · [npm](https://www.npmjs.com/package/claude-bridge)

---

## How it works

```
 CONTROLLER (Mac Mini)                      TARGET (MacBook Pro)
 ┌──────────────────────┐                  ┌──────────────────────┐
 │                      │                  │                      │
 │  Claude Code         │     SSH          │  Claude Code         │
 │  + controller skill  │ ◄──────────────► │  + target skill      │
 │                      │                  │                      │
 │  claude-bridge CLI   │                  │  claude-bridge CLI   │
 │                      │                  │                      │
 └──────────────────────┘                  └──────────────────────┘

 "Run the tests on my MacBook"    ──►    ssh MacBook "npm test"
 "Ask the other Claude to fix it" ──►    ssh MacBook "claude --print '...'"
```

### Three steps

1. **Setup** — Run `npx claude-bridge setup` on the target. It enables SSH, generates keys, and shows a pairing screen.
2. **Pair** — Photograph the pairing screen and send it to the controller Claude (via Telegram, chat, etc.). Claude reads the image and extracts the connection details. Or use the manual pairing command.
3. **Connect** — That's it. "Run X on my MacBook" just works.

---

## Installation

```bash
npm install -g claude-bridge
```

Or use directly with npx:

```bash
npx claude-bridge <command>
```

Requires Node.js 18+.

---

## Quick start

### On the target machine (the one you want to control remotely):

```bash
npx claude-bridge setup
```

This will:
- Enable SSH (Remote Login) if not already on
- Generate an SSH key pair
- Display a pairing screen with connection details and a QR code

### On the controller machine (your main workstation):

**Option A: Photo pairing (the magic way)**
1. Take a photo of the target's pairing screen
2. Send it to Claude Code (via Telegram or paste in chat)
3. Claude reads the image, extracts the details, and runs the pair command

**Option B: Manual pairing**
```bash
claude-bridge pair --manual \
  --name "MacBook-Pro" \
  --host 192.168.1.50 \
  --port 22 \
  --user ethan \
  --key ~/.claude-bridge/keys/claude-bridge_MacBook-Pro
```

**Option C: JSON file**
```bash
# Copy the pairing data to a file, then:
claude-bridge pair pairing.json
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
| `claude-bridge setup` | Run on TARGET. Enables SSH, generates keys, shows pairing screen. |
| `claude-bridge pair [photo]` | Run on CONTROLLER. Reads pairing photo/file or manual entry. |
| `claude-bridge connect <machine>` | Open an interactive SSH session. |
| `claude-bridge status [machine]` | Check if machine(s) are reachable. |
| `claude-bridge list` | List all paired machines. |
| `claude-bridge run <machine> "cmd"` | Run a command on a paired machine. |
| `claude-bridge run <machine> "prompt" --claude` | Run a Claude Code prompt on the remote machine. |
| `claude-bridge unpair <machine>` | Remove a pairing. |

### Setup options

```
--name <name>    Machine name (defaults to hostname)
--port <port>    SSH port (default: 22)
--no-qr          Skip QR code display
```

### Pair options

```
--manual         Manually enter connection details
--name <name>    Override machine name
--host <host>    Target hostname or IP
--port <port>    SSH port (default: 22)
--user <user>    SSH username
--key <key>      Path to SSH private key
--code <code>    One-time pairing code from target
```

---

## Claude Code skills

claude-bridge ships with Claude Code skills for both the controller and target machines. These teach Claude how to use the bridge automatically.

### Install the controller skill

On your main workstation, add to your Claude Code config:

```bash
# Copy the skill to your Claude config
cp -r node_modules/claude-bridge/skills/controller ~/.claude/skills/claude-bridge-controller
```

Or reference it in your CLAUDE.md:
```
When the user asks to run something on another machine, use claude-bridge:
- `claude-bridge list` to see paired machines
- `claude-bridge run <machine> "command"` to execute commands
- `claude-bridge run <machine> "prompt" --claude` to run Claude Code prompts remotely
```

### Install the target skill

On the remote machine:

```bash
cp -r node_modules/claude-bridge/skills/target ~/.claude/skills/claude-bridge-target
```

---

## Architecture

```
~/.claude-bridge/
├── config.json          # Paired machines (host, port, user, key path)
├── keys/                # SSH key pairs
│   ├── claude-bridge_MacBook-Pro
│   └── claude-bridge_MacBook-Pro.pub
└── pairing-code         # One-time pairing code (target only)
```

### How pairing works

1. Target runs `setup` which generates an ED25519 key pair
2. The public key is added to `~/.ssh/authorized_keys` on the target
3. The pairing screen displays all connection info + the private key embedded in a QR code
4. The controller reads the pairing info (from photo, file, or manual entry)
5. The private key is saved to `~/.claude-bridge/keys/` on the controller
6. The controller can now SSH into the target using key-based auth

### How remote execution works

```
Controller                              Target
────────                              ──────
claude-bridge run MacBook "cmd"
  └─► SSH connect (key auth)  ────────► sshd
      └─► exec "cmd"         ────────► shell
      └─► capture stdout/err  ◄──────── output
      └─► display result
```

For Claude-to-Claude communication:
```
Controller Claude                       Target
─────────────────                      ──────
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
- **One-time pairing codes** — codes are single-use
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
# On the controller, pair using the Tailscale address
claude-bridge pair --manual \
  --name "MacBook-Pro" \
  --host macbook-pro.tail12345.ts.net \
  --user ethan \
  --key ~/.claude-bridge/keys/claude-bridge_MacBook-Pro
```

This lets your Claudes talk to each other from anywhere.

---

## Examples

### Run a command on the remote machine
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
npm install
node bin/claude-bridge.js --help
```

---

## License

[MIT](LICENSE) -- Ethan SK

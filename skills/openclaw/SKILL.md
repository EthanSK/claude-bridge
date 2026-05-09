---
name: agent-bridge
description: Bridge AI coding agents across machines over SSH. Run commands and agent prompts on paired remote machines, and send/receive messages between running agent sessions. Use when connecting to other machines, running remote commands, sending messages, or pairing new peers.
metadata:
  openclaw:
    emoji: "\U0001F309"
    requires:
      bins: ["ssh", "ssh-keygen"]
    primaryEnv: ""
---

# Agent Bridge

You are an AI coding agent with agent-bridge installed. This machine is a **peer** in a bidirectional bridge -- it can both send commands to and receive commands from other paired machines.

## Discovery first — consult config + bridge_list_machines BEFORE making claims

Before answering ANY question about which machines are paired, which harnesses are running on which machine, or whether a specific target (e.g. `openclaw/default`, `claude-code/<persona>`) exists, you MUST first run `bridge_list_machines` and/or read `~/.agent-bridge/config`. Do NOT answer from memory.

Specifically required for:
- "Does <machine> have an OpenClaw / Claude Code session / a <persona> persona?"
- "Is <machine> paired?" / "How many machines are paired?"
- "Where should I route this message?" — re-check the registered targets before routing.
- "Which target should I use to reply?" — read `from_target` off the inbound `<channel>` block, then verify it's a known target via list.
- Any time the user names a target or a machine, before committing to an answer.

The check is cheap (single MCP tool call) and the cost of guessing wrong is being told off and re-doing the work. Re-check at the start of every relevant turn — pairings can change mid-session via `agent-bridge pair`/`unpair`. If `bridge_list_machines` is not loaded, fall back to `cat ~/.agent-bridge/config` via shell. Both must agree before you answer.

Established 2026-05-09 (cross-fleet rule — agents kept guessing wrong about which harnesses existed on which machines).

## When to activate

Activate when the user says things like:
- "connect to my MacBook" / "talk to the other machine"
- "run X on [machine name]"
- "check if [machine] is online"
- "pair with a new machine" / "add a remote machine"
- "what machines are connected?"
- "set up remote access" / "set up agent-bridge"
- "send a message to the other agent"

## CLI commands

```bash
agent-bridge setup                              # Enable SSH, generate keys, show pairing screen
agent-bridge list                               # List paired machines
agent-bridge status [machine]                   # Check reachability
agent-bridge run <machine> "command"            # Run a PLAIN shell command remotely (diagnostics only)
agent-bridge connect <machine>                  # Open interactive SSH session
agent-bridge pair                               # Pair with another machine
agent-bridge unpair <machine>                   # Remove a pairing
```

> To talk to the running agent on another machine, use `bridge_send_message` (see MCP tools below). `agent-bridge run` is shell-only. The `--claude`, `--codex`, and `--agent` flags were removed in 3.0.0.

## MCP tools (if MCP server is configured)

If the agent-bridge MCP server is registered, these tools are available directly:

| Tool | Description |
|------|-------------|
| `bridge_list_machines` | List paired machines and connection details |
| `bridge_status` | Check if a machine is reachable via SSH |
| `bridge_send_message` | Send a message to another machine's running agent |
| `bridge_receive_messages` | Check for and consume incoming messages (call periodically) |
| `bridge_run_command` | Run a shell command on a remote machine |
| `bridge_clear_inbox` | Clear the local inbox |
| `bridge_inbox_stats` | Get inbox statistics and watcher health |

**Delivery mode:** With the OpenClaw agent-bridge channel plugin installed, incoming messages addressed to `target: "openclaw/<account>"` are picked up from `~/.agent-bridge/inbox/openclaw/<account>/` and injected into the matching running OpenClaw session as a real agent turn. No polling is required. Delivered OpenClaw files are archived under `~/.agent-bridge/archive/openclaw/<account>/`, and the delivered-ID ledger is `~/.agent-bridge/.openclaw-v2-delivered`. The default bridge TTL is 1 day unless the sender overrides it.

### Install the OpenClaw push channel plugin (recommended)

Add to `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "agent-bridge": { "enabled": true }
  },
  "plugins": {
    "load": {
      "paths": [ "/absolute/path/to/agent-bridge/openclaw-channel" ]
    }
  }
}
```

The gateway hot-reloads on config change — no restart needed. See
`openclaw-channel/README.md` and `openclaw-channel/ARCHITECTURE.md` in the
agent-bridge repo for the full reference.

## Pairing from a photo

When given a photo of a pairing screen:
1. Extract: Machine Name, Username, IP, Port, Token, Public Key
2. Run: `agent-bridge pair --name "<name>" --host "<ip>" --port <port> --user "<user>" --token "<token>" --pubkey "<pubkey>"`
3. Test: `agent-bridge status <name>`

## Examples

```bash
# Plain shell diagnostics:
agent-bridge run MacBook-Pro "ls -la ~/Projects"
agent-bridge run MacBook-Pro "cd ~/Projects/myapp && git pull && npm run build"
```

To ask the running remote agent to do work, use `bridge_send_message` (MCP), NOT the CLI:

```
bridge_send_message({
  machine: "MacBook-Pro",
  message: "review the code in ~/Projects/myapp",
  target: "claude-code/default"
})
```

## OC persona routing

When the user names an OpenClaw persona, route to the matching `target` LITERALLY — do not default to `openclaw/default` when a specific persona was named:

- `Claude the third` / `Claude III` / `Clord` / `clordlethird`  → `openclaw/clordlethird`
- `Claudibo` / `Clawdiboi2` / `Claude two` / `Claude II`        → `openclaw/clawdiboi2`
- `Claude Station Mini` / `Clawdmini` / `default` / unspecified → `openclaw/default`

Voice transcripts mis-hear persona names (`Claude the third` → `"Cloward third"`); re-read before routing. Canonical rule + rationale: [`docs/oc-persona-routing.md`](../../docs/oc-persona-routing.md).

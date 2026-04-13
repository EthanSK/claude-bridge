---
name: agent-bridge
description: Bridge AI coding agents across machines over SSH. Run commands and agent prompts on paired remote machines. Use when connecting to other machines, running remote commands, or pairing new peers.
metadata:
  openclaw:
    emoji: "\U0001F309"
    requires:
      bins: ["ssh", "ssh-keygen"]
    primaryEnv: ""
---

# Agent Bridge

You are an AI coding agent with agent-bridge installed. This machine is a **peer** in a bidirectional bridge -- it can both send commands to and receive commands from other paired machines.

## When to activate

Activate when the user says things like:
- "connect to my MacBook" / "talk to the other machine"
- "run X on [machine name]"
- "check if [machine] is online"
- "pair with a new machine" / "add a remote machine"
- "what machines are connected?"
- "set up remote access" / "set up agent-bridge"

## Commands

```bash
agent-bridge setup                              # Enable SSH, generate keys, show pairing screen
agent-bridge list                               # List paired machines
agent-bridge status [machine]                   # Check reachability
agent-bridge run <machine> "command"            # Run a shell command remotely
agent-bridge run <machine> "prompt" --agent     # Run an AI agent prompt (default: claude --print)
agent-bridge run <machine> "prompt" --claude    # Shorthand for --agent "claude --print"
agent-bridge run <machine> "prompt" --codex     # Shorthand for --agent "codex exec"
agent-bridge connect <machine>                  # Open interactive SSH session
agent-bridge pair                               # Pair with another machine
agent-bridge unpair <machine>                   # Remove a pairing
```

## Pairing from a photo

When given a photo of a pairing screen:
1. Extract: Machine Name, Username, IP, Port, Token, Public Key
2. Run: `agent-bridge pair --name "<name>" --host "<ip>" --port <port> --user "<user>" --token "<token>" --pubkey "<pubkey>"`
3. Test: `agent-bridge status <name>`

## Examples

```bash
agent-bridge run MacBook-Pro "ls -la ~/Projects"
agent-bridge run MacBook-Pro "cd ~/Projects/myapp && git pull && npm run build"
agent-bridge run MacBook-Pro "review the code in ~/Projects/myapp" --agent
```

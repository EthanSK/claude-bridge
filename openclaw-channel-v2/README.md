# @agent-bridge/openclaw-channel-v2

A first-class OpenClaw channel plugin for [agent-bridge](https://github.com/EthanSK/agent-bridge).

Registers `agent-bridge` as a native messaging channel — same tier as the
built-in Telegram / Slack / iMessage channels — so cross-machine messages
flow through OpenClaw's normal inbound/outbound pipelines instead of the
v1.3.0 hack that shelled out to `openclaw agent --to ...` per message.

## How it differs from v1.3.0

| | v1.3.0 (`openclaw-plugin/`) | v2 (this module) |
| --- | --- | --- |
| Registration | Extension plugin only | `ChannelPlugin` via `api.registerChannel()` |
| Inbound delivery | `spawn("openclaw agent --to ... --message ...")` per message | `enqueueSystemEvent(...)` from the plugin-sdk |
| Outbound replies | Hijacks the configured `deliveryChannel` (e.g. telegram) | Native `ChannelOutboundAdapter.sendText` that SCPs a reply BridgeMessage back to the sender |
| Appears in `openclaw channels list` | No | Yes |
| Fan-out to Telegram + bridge sender | Config-level kludge | Core routing handles it |

v1.3.0 is kept intact at `../openclaw-plugin/` so existing installs keep
working during migration. When v2 is enabled the user should set
`plugins.entries["agent-bridge"].enabled = false` so the v1 CLI shell-out
stops running.

## Install

```bash
# In ~/.openclaw/openclaw.json:
{
  "channels": {
    "agent-bridge": { "enabled": true }
  },
  "plugins": {
    "entries": {
      "agent-bridge": { "enabled": false }
    },
    "load": {
      "paths": [
        "/path/to/agent-bridge/openclaw-channel-v2"
      ]
    }
  }
}
```

The gateway auto-reloads on config change — no restart required.

## Runtime

- Watches `~/.agent-bridge/inbox/*.json` every 2000ms.
- Parses each `BridgeMessage`, formats it as a `<channel source="agent-bridge" ...>` block (parity with the Claude Code channel plugin), and injects it into the running agent session via `enqueueSystemEvent`.
- When the agent replies, the outbound adapter SCPs a reply `BridgeMessage` to `<remote>:~/.agent-bridge/inbox/<id>.json` using the pairing's SSH key at `~/.agent-bridge/keys/agent-bridge_<remote-name>`.

## No dependencies

Node builtins only (`fs`, `path`, `os`, `child_process`, `crypto`). Uses the
host's bundled SSH and SCP for outbound delivery.

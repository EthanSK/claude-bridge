# OpenClaw plugin routing — ADR

Status: 2026-04-19, accepted with v1.2.0 of `@agent-bridge/openclaw-channel`.

## Problem

When the agent-bridge inbox watcher receives a `BridgeMessage` from a peer
machine, it needs to surface that message to the user. There are three
plausible "delivery primitives" in OpenClaw 2026.4.x:

1. **`openclaw message send`** — posts a message into a chat channel from a
   bot account. Useful for relaying the bridge envelope into Telegram, but
   doesn't trigger the agent.
2. **`openclaw agent --deliver --reply-channel ...`** — runs a real agent
   turn with the bridge envelope as input, and routes the agent's reply to
   a chat channel. This is "OpenClaw actually responds."
3. **Channel Plugin SDK** — proper bidirectional channel implementation.
   Out of scope for this pass (multi-week project).

The user (Ethan) runs three Telegram bots on the Mac Mini
(`default`, `clawdiboi2`, `clordlethird`). Each is a distinct chat with
its own persona / context. The plugin needs to be able to dispatch a
bridge message to a specific bot, not just dump everything into one.

## Decision

### Delivery modes

The plugin supports four `deliveryMode` values:

| Mode | What happens | When to use |
|------|--------------|-------------|
| `log-only` *(default)* | Parse + verify + archive. No agent invocation. | Default safe mode. The MCP tools path (`bridge_send_message` etc.) handles bidirectional agent-to-agent traffic; the inbox watcher just drains. |
| `message-send` | Shell out to `openclaw message send --channel <ch> --account <acc> --target <chat>`. | Relay bridge traffic into a chat without triggering an agent turn. Cheap, fast, no LLM cost. |
| `agent-turn` | Shell out to `openclaw agent --agent <id> --message <envelope> --deliver --reply-channel <ch> --reply-account <acc> --reply-to <chat>`. | True "agent responds." The agent processes the envelope and posts its reply to the configured chat. Costs an agent turn per inbound message. |
| `agent` *(legacy)* | The original `openclaw agent --to <slug>` path. Flaky — kept for backward compat only. Don't use in new setups. | Never. |

### Routing model

A BridgeMessage doesn't natively carry routing fields, so the plugin
supports three layered ways to specify the target chat / account / agent:

1. **Top-level `route` field on the message JSON** (preferred when the sender
   controls the format):
   ```json
   {
     "id": "msg-...",
     "from": "MacBookPro",
     "content": "actual body",
     "route": {
       "target_chat_id": "6164541473",
       "target_account": "clawdiboi2",
       "target_agent": "main",
       "target_channel": "telegram"
     }
   }
   ```
2. **Inline `@@route` header on the first line of `content`** (handy when
   the sender is a stock `bridge_send_message` and you can only set the
   text body):
   ```
   @@route target_chat_id=6164541473 target_account=clordlethird

   actual message body here
   ```
   Recognised keys: `target_chat_id` / `chat_id` / `to`,
   `target_account` / `account` / `bot`,
   `target_agent` / `agent`,
   `target_channel` / `channel`.
   The header is stripped from the envelope before injection.
3. **Plugin-config defaults** — `deliveryAccount`, `deliveryTarget`,
   `targetAgent`, `deliveryChannel`. These fill in any field not set by
   (1) or (2). A `chatIdToAccount` map can resolve account from chat id
   when only the chat is specified.

### Defaults

- `deliveryMode`: `log-only` (no behaviour change for existing installs)
- `deliveryChannel`: `telegram`
- `targetAgent`: `main`
- `deliveryAccount`: `default` (the original Telegram bot)
- `deliveryTarget`: not set; must be configured for `agent-turn` /
  `message-send` to do anything when the message has no explicit route.

### Why this shape

- **`log-only` stays default.** Existing installs don't suddenly start
  burning tokens when they upgrade. Opt-in only.
- **`agent-turn` is what the spec actually means.** "OpenClaw responds"
  requires a real LLM turn with `--deliver`, otherwise we're just relaying
  text. Making it explicit (vs the old single-mode plugin) lets users
  choose the cheaper `message-send` mode if they just want a relay.
- **Per-message routing wins over plugin config.** A single watcher can
  serve all three Telegram bots — no need for three plugin instances.
- **`@@route` header is the lowest-friction sender API.** The sender
  doesn't need to know the agent-bridge MCP schema; they can just prepend
  one line. The MCP `bridge_send_message` tool is unchanged.

## Consequences

- **`openclaw agent` invocations are heavyweight.** Each `agent-turn` runs
  a full agent turn (10–60s, costs tokens). Don't enable it unless you
  want the bridge to be a real conversational channel.
- **No way to reload plugin without gateway restart** in OpenClaw 2026.4.15.
  Code changes pulled into the symlinked plugin path are picked up next
  gateway start. Use the standalone daemon
  (`bin/agent-bridge-openclaw-inbox.js`) for testing without restart.
- **Future: real channel plugin.** The proper long-term fix is a Channel
  Plugin SDK implementation that injects a user turn into the running
  session without shelling out. See `PLAN.md` "What's still missing."

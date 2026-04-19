# agent-bridge OpenClaw parity — plan and current state

Status: 2026-04-19, investigation + targeted fix for v3.2.0.

## What worked before this pass

1. **MCP tools path (outbound / diagnostic) — functional.**
   The shared `mcp-server/build/index.js` is registered with OpenClaw via
   `openclaw mcp set agent-bridge …` (confirmed with `openclaw mcp show
   agent-bridge`). Any running OpenClaw agent can call `bridge_send_message`,
   `bridge_status`, `bridge_list_machines`, `bridge_run_command`,
   `bridge_receive_messages`, `bridge_clear_inbox`, `bridge_inbox_stats`.
   End-to-end confirmed 2026-04-19 18:42:27 BST when the OpenClaw agent on
   Mac Mini posted a natural-language reply back to MBP (visible in
   `~/.openclaw/logs/gateway.log`).

2. **OpenClaw plugin loads.**
   `openclaw plugins list | grep agent-bridge` shows `loaded`, source
   `~/Projects/agent-bridge/openclaw-plugin/src/index.js`, version 1.0.0.
   The inbox watcher starts with fswatch: `[agent-bridge] fswatch active on
   /Users/ethansk/.agent-bridge/inbox` + `inbox bridge ready`.

3. **Message ingestion detection works.**
   When a peer delivers a `BridgeMessage` over SSH into
   `~/.agent-bridge/inbox/`, the plugin sees it and logs
   `delivering msg-<id> from=<peer> target=agent-bridge-<peer>`.

## What was broken

**Channel-push delivery to a running OpenClaw agent.**

The original design shelled out to `openclaw agent --to agent-bridge-<peer>
--message <envelope>` to inject a user turn. In practice this:

- Times out after 45s on the Gateway path (the gateway already holds a lock
  on the default session file `~/.openclaw/agents/main/sessions/*.jsonl`).
- Falls back to the embedded agent, which also can't acquire the session
  file lock (same pid).
- Both model fallbacks fail with `session file locked`.
- The plugin never reaches `recordDeliveredId`, so the message sits in the
  inbox and is re-attempted on every gateway restart (we saw
  `msg-d0a529ab-...` retried three times within one restart cycle).

The `.openclaw-delivered` file confirms the blast radius: only 5 messages
have ever been recorded as successfully delivered via this path since the
plugin was installed (two unique IDs, each duplicated from retries).

`openclaw agent --to` is also conceptually wrong: `--to` is documented to
accept an E.164 phone number (WhatsApp/Signal routing). A non-E.164 slug
like `agent-bridge-MacBookPro.lan` falls through to the default session,
which is exactly the one the gateway is holding.

## What a "proper" channel plugin would need

OpenClaw has a documented Channel Plugin SDK
(https://docs.openclaw.ai/plugins/sdk-channel-plugins) with a full contract:
DM policy, pairing, outbound send, thread routing, mention gating, etc.
Implementing that is weeks of work and duplicates the Telegram/iMessage
plugins' structure. Out of scope for this pass.

## What we shipped in v3.2.0 (this pass)

Two targeted fixes to `openclaw-plugin/src/inbox-bridge.js`:

1. **Replace the broken delivery primitive with `openclaw message send`.**
   `openclaw message send --channel <channel> --target <target> --message
   <envelope>` is a non-blocking, single-shot primitive that posts a message
   into an existing channel stream. The message arrives in the running
   OpenClaw agent's context via its normal channel watcher (the same way
   Telegram/Discord/iMessage messages arrive).

   **Gated behind config** to avoid bridge-spam by default. A new
   `deliveryMode` field in `openclaw.plugin.json` config:
   - `"log-only"` (default): parse + verify + mark delivered + remove file,
     but do not invoke any agent path. MCP tools path is the primary
     bidirectional channel. The inbox file is preserved under
     `~/.agent-bridge/inbox/.delivered/` for audit.
   - `"message-send"`: shell out to
     `openclaw message send --channel <cfg.deliveryChannel> --target
     <cfg.deliveryTarget> --message <envelope>`. Opt-in.
   - `"agent"` (legacy): the old `openclaw agent --to` path, left in for
     backward compat but no longer the default — documented as flaky.

2. **Always remove delivered message files from the inbox.**
   On successful delivery (or explicit log-only ack), the file is moved to
   `~/.agent-bridge/inbox/.delivered/` so it doesn't re-trigger on restart.
   This stops the infinite-retry loop regardless of deliveryMode.

## What's still missing (followups)

- **Real channel push.** Implementing a proper OpenClaw channel plugin that
  injects user turns into the running agent's session without blocking on
  the file lock is the right long-term fix. Needs docs reading + prototype.
- **packages/core refactor.** The original plan called for moving
  SSH/inbox/path-cache into a shared `packages/core` used by both
  `mcp-server/` and `openclaw-plugin/`. The two plugins are already
  architecturally independent (inbox watching is duplicated in each, SSH
  is only in `mcp-server/`). The refactor is genuinely worthwhile for
  long-term maintenance, but isn't a prerequisite for OpenClaw parity —
  deferred to a follow-up PR.
- **CLI wiring.** `agent-bridge` CLI has no OpenClaw-specific subcommand
  (e.g. `agent-bridge openclaw install`). Users still run
  `openclaw plugins install --link`. Good enough for now.

## Deployment

- Commit v3.2.0, push `origin/main`.
- `ssh ethansk@100.126.23.86 'cd ~/Projects/agent-bridge && git pull'`.
- `mcp-server` didn't change, no rebuild needed on Mac Mini.
- Restart the OpenClaw gateway:
  `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`.
- Verify: `openclaw plugins list | grep agent-bridge` → `loaded`.
- Drain the stuck inbox on Mac Mini:
  `mv ~/.agent-bridge/inbox/msg-*.json ~/.agent-bridge/inbox/.delivered/`.

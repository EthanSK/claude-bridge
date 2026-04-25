# `agent-bridge-channel` — Claude Code channel plugin (3.6.0+)

Long-lived, session-scoped Claude Code plugin that owns the inbound side of agent-bridge's cross-machine messaging:

- Holds the watcher lease at `~/.agent-bridge/locks/claude-code.watcher-lock.json`.
- Polls `~/.agent-bridge/inbox/claude-code/` at 2 s intervals.
- Pushes new messages from paired machines into the running Claude Code session as `notifications/claude/channel`, which Claude renders as `<channel source="agent-bridge" from="..." ...>...</channel>` blocks.
- Survives `/reload-plugins`, sibling MCP spawns, and idle reaping — the lifetime model mirrors the Telegram channel plugin's session-scoped MCP server.

The companion plugin is **`agent-bridge`** (the tools-only MCP server in `../mcp-server/`), which exposes the outbound `bridge_*` tools (`bridge_send_message`, `bridge_run_command`, etc). The two plugins coordinate exclusively via the filesystem; they do not talk to each other at runtime.

## Why a separate plugin?

Pre-3.6.0 the channel watcher lived inside the same MCP stdio child as the tools. Claude Code's plugin host is allowed to reap, restart, or re-pipe stdio MCP children between tool turns — and does. Each death path required a new `mcp-server` patch (3.4.9–3.5.5). The 3.6.0 split moves channel ownership into a process whose lifetime matches the Claude Code session, not the tool turn.

The full design rationale lives at [`../docs/3.6.0-channel-plugin-migration.md`](../docs/3.6.0-channel-plugin-migration.md).

## Layout

```
claude-code-channel/
├── package.json
├── package-lock.json
├── tsconfig.json
├── .claude-plugin/
│   └── plugin.json            # Claude Code plugin manifest
├── .mcp.json                  # MCP server registration (node build/index.js)
├── src/
│   ├── index.ts               # entry point — Patches A/B/C/D/E/F + MCP transport
│   ├── config.ts              # shared paths/target validation (copy of mcp-server)
│   ├── log.ts                 # NDJSON appender to ~/.agent-bridge/logs/agent-bridge.log
│   ├── inbox.ts               # delivered/processed ledgers + cache
│   └── watcher.ts             # polling watcher + lease + channel-notify
├── build/                     # tsc output (committed)
└── README.md                  # ← you are here
```

## Lifecycle patches (mirror of Telegram's `server.ts`)

`src/index.ts` adopts the same five lifecycle patches the Telegram plugin uses:

- **Patch B** — persistent stderr tee → `~/.agent-bridge/logs/claude-code-channel-stderr.log`. 5 MiB rotation. Mirrors Telegram's stderr→server.log tee.
- **Patch C** — single `shutdown(reason)` funnel reachable from every teardown trigger (SIGINT/SIGTERM/SIGHUP, fatal transport exits, orphan watchdog).
- **Patch D** — 60 s heartbeat to stderr (and through Patch B, to file). REFED — the channel host MUST keep the loop alive between idle bursts. mcp-server's heartbeat is unref'd for the opposite reason.
- **Patch E** — handle/request dump at shutdown entry. Reveals what kept the loop alive at teardown.
- **Patch A** — 3-poll orphan watchdog (5 s × 3 = 15 s confirmation across `ppid != bootPpid` OR `stdin.destroyed` OR `stdin.readableEnded`). Stdin events alone don't reliably fire when the parent chain is severed mid-process; the watchdog covers that case.

Plus **Patch F** — heartbeat-recency guard against parallel subagent spawns murdering the parent poller. Uses the watcher lease's `updatedAt` as the recency signal (instead of stderr-log mtime); same intent as Telegram's check.

## Install

```bash
cd ~/Projects/agent-bridge/claude-code-channel
npm install
npm run build

# from the repo root, register the local marketplace if you haven't already
claude plugin marketplace add ~/Projects/agent-bridge

# install BOTH plugins
claude plugin install agent-bridge@agent-bridge          # tools (mcp-server)
claude plugin install agent-bridge-channel@agent-bridge  # channel host (this package)
```

Verify with `claude plugin list`. After `/reload-plugins`, you should see two `agent-bridge`-prefixed entries in `claude mcp list`.

## Validation

A long-lived channel host should:

- Acquire the watcher lease at startup. `cat ~/.agent-bridge/locks/claude-code.watcher-lock.json` shows `pid` matching this process and `role: "channel-owner"`.
- Emit `[heartbeat] uptime=Ns ...` lines once per minute to `~/.agent-bridge/logs/claude-code-channel-stderr.log`.
- Survive `/reload-plugins`. The mcp-server tools child rotates, but THIS pid remains stable.
- Push `notifications/claude/channel` for any inbound message in `inbox/claude-code/`. Confirm via the unified log:
  ```bash
  jq -c 'select(.component=="claude-code-channel" and .event=="message.pushed_to_channel")' \
    ~/.agent-bridge/logs/agent-bridge.log | tail
  ```

## License

MIT — see [`../LICENSE`](../LICENSE).

# Mac-Mini agent-bridge MCP disconnect investigation — 2026-05-03

**Investigator:** Claude (subagent), main session `e59a29af-...` on `Ethans-Mac-mini`
**Trigger:** Ethan voice 6155 — "Why the fuck was BridgeMCP offline? That's bad." Voice 6156 — instructed subagent to read the logs.
**Scope:** Window 2026-05-02 evening → 2026-05-03 mid-day (current session uptime).

## TL;DR

The disconnects today were **not a single bug** but the cumulative effect of **two known kill paths interacting with three external triggers**. The dominant cause is the `SessionStart` hook that runs `scripts/update.sh --auto` on every `claude` session boot — including subagent boots — which during a version-bump window will let Patch F's stale-version peer-kill SIGTERM/SIGKILL the running channel-owner that this main session is connected to.

There is no bug in Patch F per se. The bug is in **session-fanout amplification**: subagent boots are being treated as version-migration events.

## Disconnect inventory (Mac-Mini, last ~16h)

Pulled from `~/.agent-bridge/logs/mcp-server-sync-exit.log` + `~/.agent-bridge/logs/agent-bridge.log`. Each row = one running channel-owner MCP child losing its lease. The **session** column is the parent claude PID (the one Ethan typed into).

| # | Time (UTC)             | Owner PID | Parent PID | Cause                                                  | Mechanism                          |
|---|------------------------|-----------|------------|--------------------------------------------------------|------------------------------------|
| 1 | 2026-05-02 20:01:37    | 87354     | 39755      | Auto-update SessionStart on subagent (3.13.0 → 3.14.2) | Patch F SIGTERM + SIGKILL          |
| 2 | 2026-05-02 22:50:02    | 87354     | 39755      | Stale-lease GC after parent died (delayed reaping)     | watcher.lease_stolen by pid 2097   |
| 3 | 2026-05-02 23:22:28→38 | 2097      | 39755      | Parent claude died (`ESRCH`) + stdin destroyed         | orphan-watchdog (clean self-exit)  |
| 4 | 2026-05-03 00:11:32    | 10823     | 10654      | Auto-update SessionStart on subagent (3.14.2 → 3.14.3) | Patch F SIGTERM + SIGKILL          |
| 5 | 2026-05-03 11:12:41    | 10823 (already dead) | — | Stale-lease GC by current owner            | watcher.lease_stolen by pid 62445  |

5 channel-owner-loss events in ~15h. **Two were Patch F peer-version kills** (events 1 and 4). Two were post-mortem cleanup of leases left behind by earlier kills (events 2 and 5). One was a clean orphan-watchdog shutdown after the parent claude actually died (event 3).

The two events Ethan FELT as "BridgeMCP offline" map to **events 4 and 5** (within his current session, parent PID 10654 spawned at ~11:00 BST and tooling broke around 00:11 + 11:12 UTC — those map to ~01:11 BST and ~12:12 BST). Events 1 and 2 are from a previous session and only relevant as context.

## Why the version bump window is the killer

`scripts/update.sh --auto` runs as a SessionStart hook on every claude boot:

```json
// settings.json:43
{ "command": "bash \"$HOME/Projects/agent-bridge/scripts/update.sh\" --auto", "timeout": 60 }
```

`--auto` does `git pull --ff-only` and (when commits arrive) `npm install && npm run build`. The build bumps `mcp-server/package.json` -> `MCP_SERVER_VERSION` constant in the new `build/index.js`.

Now the failure sequence on every subagent boot during a fresh-version window:

1. The currently-running channel-owner MCP child (e.g. PID 10823, version 3.14.2) holds the lease. It is healthy, responding to tool calls in the main session.
2. Ethan dispatches a subagent via the Task tool. Claude Code spawns a **new** claude process. That new process fires SessionStart hooks. The hook runs `update.sh --auto`. If origin/main is ahead, it pulls 3.14.3 and rebuilds.
3. The **new** claude process also spawns its own agent-bridge MCP child from the freshly-built bundle. That child is 3.14.3.
4. The 3.14.3 child runs the Patch F preamble (`mcp-server/src/index.ts:162-347`). It reads the lease file: holder=10823, version=3.14.2. **3.14.2 < 3.14.3 ⇒ peer is older.**
5. Patch F unconditionally **SIGTERMs the older peer**, waits 2s, then **SIGKILLs** if it didn't exit (mcp-server/src/index.ts:208-273):

```
[2026-05-03T00:11:32.168Z] patch_f.peer_version_kill peer_pid=10823 peer_version=3.14.2 our_version=3.14.3 pid=24640
[2026-05-03T00:11:32.202Z] signal.received pid=10823 SIGTERM (handler ignores it because parent is alive)
[2026-05-03T00:11:34.215Z] patch_f.peer_version_sigkill (SIGKILL — uncatchable)
```

6. The main session's MCP child (10823) is now dead. The main session's stdio MCP transport was wired to that PID. Claude Code's MCP host detects EOF on the JSON-RPC pipe and surfaces the deferred-tool warning Ethan saw:

```
The following deferred tools are no longer available (their MCP server disconnected). Do not search for them — ToolSearch will return no match: mcp__plugin_agent-bridge_agent-bridge__bridge_*
```

7. The newly-spawned 3.14.3 child becomes the new lease holder (in the subagent process), but it is **stdio-wired to the subagent**, not to Ethan's main session. The main session has no MCP child until Ethan runs `/reload-plugins`.

This is the dominant disconnect mechanism. It triggers exactly when:

- A version bump landed on origin/main since the last subagent dispatch
- AND a subagent is dispatched (every subagent dispatch boots a fresh claude that runs SessionStart hooks)
- AND the subagent's claude actually picks up the new version (build succeeds in <60s, npm cache warm)

We shipped 3.14.0 → 3.14.1 → 3.14.2 → 3.14.3 in rapid succession across the last ~24h, so the version-bump window has effectively been "always" today. Each subagent dispatch = one Patch F kill of the parent session's channel-owner.

## Why Patch F is doing the right thing in isolation

Patch F's design intent is to force `/reload-plugins`-style migrations through cleanly when a single user explicitly bumps version. The 3.6.x — 3.10.x design memo (`mcp-server/src/index.ts:114-143`) was written for the case "Ethan ran `/reload-plugins` after a manual update; the new MCP child should evict the old one so users immediately get the new code." In that single-session world, the user already accepted the disconnect (they typed `/reload-plugins`).

The break is that **subagent SessionStart hooks now boot fresh MCP children invisibly**, and those children participate in Patch F as if they were a manual `/reload-plugins`. The kill is correct in mechanics; the trigger is wrong.

## Other disconnect mechanisms observed (not dominant today, but in the soup)

### Orphan-watchdog (event 3) — working as intended

```
[2026-05-02T23:22:38.471Z] shutdown.enter pid=2097 ppid=1 reason="orphan-watchdog: parent dead (pid 39755 ESRCH) | stdin destroyed"
```

Parent claude PID 39755 died. The MCP child correctly detected reparenting to PID 1 + ESRCH on the original parent, ran `ORPHAN_CONFIRMATION_POLLS` confirmations, and shut down cleanly. This is healthy behavior — no fix needed.

### Sibling-detected handoff (multiple, ongoing)

`patch_f.backoff_standby` events at 23:01, 23:05, 23:10 (×2), 23:13, 23:15 etc. These are 5-minute-cadence subagent or `/reload-plugins`-spawned siblings that correctly entered standby instead of evicting the same-version channel-owner. **No disconnect**, this is the path Patch F's 3.7.1 revision was supposed to optimize for, and it works.

### Stale-lease cleanup (events 2, 5)

When a peer dies (orphan-watchdog or hard-kill), its lease file lingers up to 90s before another child notices and removes it (`tryAcquireWatcherLease` → `Watcher: removed stale lease`). These are bookkeeping events, not user-facing disconnects.

## Root cause statement

**SessionStart auto-update + Patch F peer-version-kill = subagent dispatches assassinate the parent session's MCP child during version-bump windows.**

## Recommended fix (small, ≤30 LOC) — DO NOT KILL DURING SUBAGENT-INITIATED VERSION MIGRATIONS

The simplest, lowest-blast-radius fix: **make Patch F's peer-version-kill conditional on the existing peer's lease being stale OR the new child explicitly being the user-spawned `/reload-plugins` migration trigger.**

Concretely, replace the unconditional kill in `mcp-server/src/index.ts` lines 198-280 with:

```ts
if (holderAlive) {
  const versionCompare = peerVersion ? compareSemver(peerVersion, MCP_SERVER_VERSION) : null;
  const peerIsOlder = versionCompare !== null && versionCompare < 0;
  // 3.14.4 — only kill the older peer if its heartbeat is ALSO stale, OR if the
  // user explicitly opted in to forced migration via env var. A fresh
  // heartbeat means the older version is actively serving JSON-RPC for some
  // running session — killing it disconnects that session's MCP tools.
  // Subagent SessionStart auto-update creates exactly this surprise kill,
  // so default to "stand by until the older peer's session ends naturally".
  const peerHeartbeatAgeMs = Date.now() - updatedAt;
  const peerHeartbeatStale = peerHeartbeatAgeMs > 30_000;
  const forceKillEnv = process.env.AGENT_BRIDGE_FORCE_VERSION_MIGRATION === '1';
  const shouldKill = peerIsOlder && (peerHeartbeatStale || forceKillEnv);
  if (shouldKill) {
    // ...existing SIGTERM + 2s grace + SIGKILL block, unchanged...
  } else if (peerIsOlder) {
    // Older peer with a fresh heartbeat — fall through to standby + retry.
    // The older session will end naturally (user closes claude, or runs
    // /reload-plugins which sets AGENT_BRIDGE_FORCE_VERSION_MIGRATION=1).
    logEvent({
      event: 'patch_f.older_peer_standby',
      level: 'warn',
      msg: 'Older-version peer holds a fresh lease; deferring kill to avoid disconnecting active session',
      context: { holder, peer_version: peerVersion, our_version: MCP_SERVER_VERSION,
                 heartbeat_age_ms: peerHeartbeatAgeMs, pid: process.pid },
    });
    // ... fall through to existing standby + retry path ...
  } else {
    // existing same-version standby path, unchanged
  }
}
```

That's ~25 LOC of conditional + branch. Estimate **30 LOC including a test fixture in `mcp-server/test/unified-channel.test.mjs`** mirroring the existing `older-version peer kill` test but flipped to the fresh-heartbeat case.

The user-side knob: the `self-reload-plugins` skill (or whatever the user uses to opt in to a migration) sets `AGENT_BRIDGE_FORCE_VERSION_MIGRATION=1` in the env when it spawns the new MCP child via `/reload-plugins`. Or — simpler — just leave the env var off and let the user's session end naturally; the next session boot picks up the new version. That's how everyone else's plugin-update flow works.

### Alternative (smaller): don't run update.sh on EVERY SessionStart

The truly minimal fix is to gate the SessionStart hook so it doesn't run on subagent boots. In `~/.claude/settings.json` change:

```json
{ "command": "bash \"$HOME/Projects/agent-bridge/scripts/update.sh\" --auto", "timeout": 60 }
```

to:

```json
{ "command": "[ -z \"$CLAUDE_SUBAGENT\" ] && bash \"$HOME/Projects/agent-bridge/scripts/update.sh\" --auto || true", "timeout": 60 }
```

(or whatever env var Claude Code sets to distinguish subagent boots from main-session boots — needs verification). This is a 1-line `settings.json` edit, no agent-bridge code change.

**Recommendation:** Ship BOTH. The Patch F change is the right defense-in-depth (subagent boots aren't the only future source of "unexpected version-bump-during-active-session" — manual fleet rollouts, cron-triggered updates, etc., will reproduce the same symptom). The settings.json change is the immediate workaround that stops the bleeding right now.

## Other hypotheses ruled OUT

- **stdio buffer / EPIPE** — no `fatal_transport_exit.*` events in any log today. JSON-RPC transport is fine.
- **OOM / FD exhaustion** — `rss_mb=39-46` across all heartbeats. No memory pressure.
- **Auto-update probe rebuild** — `auto_update_runner.plugin_registry_*` events show `idempotent:true, changed:false` consistently. The probe is not the trigger; it's the SessionStart hook (which uses the same update.sh script).
- **Chrome / chrome-devtools-mcp / cdp-browser-mcp SessionStart hooks** — these scripts manage Chrome processes, not agent-bridge processes. `patch-chrome-devtools-mcp.sh` just sed-edits a file. None of them touch `~/.agent-bridge/locks/` or send signals to node processes.
- **Telegram parseMode sed hook** — only touches Telegram plugin source, not agent-bridge.

## Workaround for users right now (before any fix ships)

While waiting for the proper fix, you can:

1. **Disable the auto-update SessionStart hook temporarily.** In `~/.claude/settings.json`, comment out or remove the `update.sh --auto` entry from the SessionStart hooks array. Auto-update probe (every 3h, in-process) still runs and will catch new versions on a slower cadence without spawning fresh MCP children mid-session.
2. **Pin a single version.** If you're not actively shipping, pin everything to e.g. 3.14.3 and don't push for a few hours. The version-mismatch kill path needs an actual delta.
3. **`/reload-plugins` after disconnect.** This is what's been happening — once the kill lands, `/reload-plugins` (or the `self-reload-plugins` skill) spawns a fresh MCP child connected to the live session. It works, it's just annoying.
4. **Don't spawn subagents during a known version-bump window.** Once you've pushed `mcp-server/package.json` → npm to origin/main and before peers fetch+rebuild, every subagent dispatch on this machine will trigger the kill.

## Open questions for Ethan

1. Does Claude Code expose `CLAUDE_SUBAGENT` (or similar) env var at SessionStart so the hook can no-op for subagents? If yes, the settings.json one-liner is the cheapest fix. If no, we need the agent-bridge-side fix.
2. The `self-reload-plugins` skill is documented as not actually respawning the channel-owner (CLAUDE.md "/reload-plugins is NOT a hot-reload" rule). Should the proper fix path be: (a) keep the older peer alive, (b) on the user's next SESSION restart pick up the new version naturally? That's what the suggested code change does, but I want to verify it matches Ethan's mental model before applying.
3. Are there cases where Ethan WANTS the subagent's version-bump to instantly take over the parent session? I think no — the parent session is already wedged into stale tools the moment that happens. Better to defer.

## Files referenced

- `~/Projects/agent-bridge/mcp-server/src/index.ts:114-347` — Patch F (preamble lease check + peer-version-kill)
- `~/Projects/agent-bridge/mcp-server/src/index.ts:1289-1377` — SIGTERM/SIGINT/SIGHUP handler (Patch G)
- `~/Projects/agent-bridge/mcp-server/src/index.ts:1500-1650` — orphan-watchdog + sibling-detected
- `~/Projects/agent-bridge/scripts/update.sh:1-60` — SessionStart `--auto` updater
- `~/.agent-bridge/logs/mcp-server-sync-exit.log` — durable death-path breadcrumbs (NDJSON)
- `~/.agent-bridge/logs/mcp-server-stderr.log` — Patch F's `older than our` warnings + `existing watcher heartbeat fresh` standbys
- `~/.agent-bridge/logs/agent-bridge.log` — `signal.evidence`, `patch_f.peer_version_*`, `watcher.lease_*` events
- `~/.claude/settings.json:42-44` — the SessionStart hook firing `update.sh --auto`

## Appendix — the key log lines proving the cause

```
# Event 4 — the disconnect Ethan felt at 01:11 BST
[2026-05-03T00:11:32.168Z] patch_f.peer_version_kill peer_pid=10823 peer_version=3.14.2 our_version=3.14.3 pid=24640
[2026-05-03T00:11:32.197Z] signal.received pid=10823 ppid=10654 SIGTERM (parent alive — handler ignored)
[2026-05-03T00:11:32.207Z] signal.ignored_channel_owner pid=10823 (Patch G)
[2026-05-03T00:11:34.215Z] patch_f.peer_version_sigkill (uncatchable kill landed)
[2026-05-03T00:11:34.576Z] server.starting version=3.14.3 pid=24640 — but ppid=62545 = OPENCLAW gateway, not Ethan's session

# Event 5 — stale-lease cleanup Ethan felt at 12:12 BST when his session resumed
[2026-05-03T11:12:41.239Z] Watcher: removed stale lease for claude-code held by pid=10823 (it was already SIGKILLed at 00:11:34)
[2026-05-03T11:12:41.240Z] watcher.lease_acquired pid=62445 ppid=10654 — this is the new MCP child wired to the current session
```

10823 is the stale lease that survived from event 4 until this session resumed and a fresh MCP child grabbed it. From Ethan's POV those two were two distinct disconnect-and-reload cycles even though they're cause+effect.

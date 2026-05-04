# Operations: stale in-memory plugin code & the OC↔CC mutual-restart dance

**Canonical reference for keeping a running fleet on fresh agent-bridge code.** Auto-update reliably refreshes the bytes on disk; what it cannot do is rip code out of an already-running process. This doc covers why that gap exists, what you can and cannot fix without restarting, every workaround currently in the toolbox, and the orchestrated double-restart used to bring both sides of a paired Claude Code (CC) ↔ OpenClaw (OC) host back to current code without the dance fighting itself.

If you are reading this fresh on a new harness, **read [`docs/auto-update.md`](auto-update.md) first** — that doc describes how new code gets onto disk. This doc picks up where that one ends: how to actually load it.

---

## Why the problem exists

Node.js maintains a **permanent in-process module cache**. Once a plugin's `require()` / `import` graph resolves, those module records stay in memory for the lifetime of the process. There is no first-class "unload + reload" primitive in the platform — you can mutate `require.cache` keys, but plugin code that captured references at load time keeps holding the old objects regardless. In practice the only reliable way to load fresh code is to exit the process and start a new one.

Both supported harnesses sit on top of that constraint, and each one stacks an additional cache layer on top:

- **Claude Code's MCP supervisor** spawns plugin children as long-lived stdio-attached subprocesses. The slash command `/reload-plugins` reloads plugin **manifests, skills, hooks, and slash commands**, and may spawn a new MCP child to claim the channel-owner lease — but the lease-coordination logic prefers continuity. If a healthy channel-owner is already running, the newly-spawned child becomes a standby instead of evicting the existing owner. Net result: the running MCP child keeps its OLD code in memory regardless of how many `/reload-plugins` invocations fire.
- **OpenClaw's bundled-entry loader** layers its own permanent `loadedModuleExports` Map on top of Node's. Even the gateway's config-driven `reloadPlugins` trigger doesn't bust this cache for already-loaded modules — it re-reads config and re-registers descriptors, but the in-memory exports map keeps the previously-loaded plugin code.

The combined effect: **disk gets fresh code via auto-update; the running processes stay frozen on whatever version they booted with**. Until the OS process exits, that's what the runtime executes.

A common corollary, called out repeatedly in the auto-update doc: `/reload-plugins` is **not** a hot-reload for MCP child code. It refreshes descriptors. Re-spawning the child requires a full Claude Code restart.

---

## What you CAN change without restart

Auto-update self-heals everything that lives on disk and isn't pinned in process memory:

- **`git pull` of the bridge dev clone** (Layer 1 in-process probe at 3 h cadence + Layer 2 OS-level periodic updater at 10 min cadence). New tip-of-main bytes land in `mcp-server/` etc.
- **`npm install && npm run build`** to produce fresh `mcp-server/build/index.js`, the actual file the MCP child will run **next time it spawns**.
- **`plugin-registry-rewire`** — fixes stale `installPath` entries in `~/.claude/plugins/installed_plugins.json` and stale `plugins.load.paths[]` entries in `~/.openclaw/openclaw.json`. Idempotent. Runs automatically as part of every auto-update; also exposed via `agent-bridge plugin-registry-rewire`.
- **Plugin manifests, hooks, skills, slash commands** loaded by the harness itself (via `/reload-plugins` on Claude Code, gateway config reload on OpenClaw). These descriptors are read from disk at reload time, so once disk is fresh they pick up the change.

If your fix lives in any of those layers, you do not need to restart anything.

---

## What REQUIRES a restart

Anything that lives in **MCP-child process memory** or **OpenClaw gateway in-process memory**:

- The `mcp-server` JavaScript that the channel plugin's MCP child loaded at boot.
- The `openclaw-channel` JavaScript that the OpenClaw gateway loaded at startup.
- Any module that any of those captured references to during initialization (event handlers, target adapters, retry counters, lease state machines, etc.).

The set of things that fall in this bucket is unfortunately the same set of things you most often want to fix: bridge protocol changes, channel-plugin behavior, ack semantics, watcher-lease logic, target-routing edge cases. Plan for a restart whenever you touch those.

---

## Workaround inventory

Every lever currently in the toolbox, what it solves, what it doesn't, and how fragile it is. Pick the lightest one that actually addresses your specific staleness.

| Workaround                                      | What it solves                                                                                | What it does NOT solve                                                                                                | Fragility                                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Full Claude Code restart** (exit + relaunch with `--resume <session>`) | Stale MCP child code on Claude Code. The only reliable way to pick up `mcp-server` changes.    | OpenClaw gateway code; it doesn't share processes.                                                                    | Low. Requires user-level interactive restart of the harness. Loses any in-flight tool calls in the active session.                          |
| **`openclaw gateway restart`**                  | Stale OC channel/plugin code in the OpenClaw gateway's in-process module cache.               | Claude Code MCP child code.                                                                                            | Low. Safe to invoke; preserves env files. Note: `openclaw install` (NOT `restart`) regenerates env and may strip `NODE_OPTIONS`.            |
| **OC↔CC mutual-restart dance** (see below)      | Both sides stale on the same host; coordinate without dropping mid-restart connectivity.      | Cross-host coordination — only operates on a single host; mirror the dance per host as needed.                         | Medium. Needs an external driver (a peer host's CC, or a non-stale local skill) so the mid-restart machine doesn't have to drive itself.    |
| **Patch F stale-version peer-kill**             | Auto-evicts a stale MCP child when a fresh one boots with a NEWER version on `/reload-plugins`. | Same-version code drift (e.g. you rebuilt without bumping the version). The peer-kill compares versions, not hashes.   | Medium. Only fires on actual version bumps. If you ship a same-version rebuild, the eviction never triggers.                                |
| **Manual SIGTERM of the stale MCP child**       | Forces the channel-owner lease to release; harness's MCP supervisor will respawn a fresh child. | Anything other than the MCP child. Not a substitute for restarting the harness when the harness itself is stale.       | High. Brute force. Race-prone if multiple stale children exist. Easy to kill the wrong PID. Use only after confirming PID via `ps` + status. |
| **`plugin-registry-rewire`**                    | Stale `installPath` entries pointing at archived/cached paths instead of the live dev clone.   | In-memory code drift. Fixes the *next* spawn's path; running process is unaffected until restart.                      | Low. Idempotent. Backups every JSON edit. Built into auto-update.                                                                           |
| **mcp-server auto-update probe (3 h, in-process)** | Disk freshness when a harness is alive. Triggers receiver-driven `update.sh`.                  | In-memory code drift. Disk-only fix.                                                                                   | Low. Sentinel-deduped; coord-locked. Only runs while a harness is alive.                                                                    |
| **Periodic LaunchAgent / Scheduled Task (10 min)** | Disk freshness even when no harness is alive. Survives reboots, logouts, off-overnight Macs.   | In-memory code drift. Disk-only fix.                                                                                   | Low. OS-level scheduled job. Per-checkout lock prevents concurrent runs.                                                                    |
| **OC heap-fix watchdog** (separate LaunchAgent) | OC gateway OOMing under load. Re-asserts `NODE_OPTIONS=--max-old-space-size=...` after install strips it. | Code drift of any kind. Strictly a heap-size guardrail.                                                                | Low. Independent of bridge auto-update; runs on its own cadence.                                                                            |
| **`self-reload-plugins` skill**                 | Manifest / hook / skill descriptor refresh on Claude Code via AppleScript-driven `/reload-plugins`. | MCP child code (see "Why the problem exists" — `/reload-plugins` is not a hot-reload). The skill's name oversells it. | Medium. Useful for descriptor-only changes; misleading for code changes. Document the limitation wherever you reference it.                  |
| **SessionStart Telegram parseMode patch**       | Specific known-bug patch for the Telegram channel plugin's `parseMode: undefined` default.    | Anything outside that one bug.                                                                                         | Low. Pin-targeted. Re-runs every session start so plugin updates can't quietly undo the fix.                                                |

**Decision rule:** if your fix is in disk artifacts or registry entries, auto-update + rewire handles it. If your fix is in code that an MCP child or the OC gateway has already loaded into memory, you are restarting something. Pick: restart just CC, restart just OC, or do the dance for both.

---

## The OC↔CC mutual-restart dance

Use this when both Claude Code and OpenClaw on the **same host** need to pick up fresh code, and you want a single coordinated procedure that doesn't fight itself mid-restart.

### Generalized framing

- **Phase A — restart Claude Code from outside Claude Code.** A skill or external driver invokes Claude Code's `/quit` and relaunches the harness with a session-resume flag. The new CC parent + a freshly-spawned MCP child boot from current disk; in-memory drift on the MCP-child layer is gone.
- **Phase B — restart OpenClaw from inside the freshly-restarted Claude Code.** The new CC, now running fresh code, drives `openclaw gateway restart`. The OC gateway exits and respawns; its in-process module cache is gone, so OC plugins reload from current disk.
- **Coordination requirement.** Drive the dance from a process that **isn't on the host being restarted**. If Claude Code on Host-A drives its own restart, the AppleScript / shell automation it spawned dies with the parent. Two safe driver options:
  - **Peer-host driver.** Have Host-B's Claude Code (still running fresh code) bridge a command into Host-A's OC, which has a "drive a Claude Code restart" skill. Host-A's CC dies and respawns; Host-A's CC then drives `openclaw gateway restart` for Phase B.
  - **OS-level driver on the same host.** A LaunchAgent / Scheduled Task running independently of any harness can also drive Phase A, but most fleets don't have that wired up. The peer-host pattern is more common.

After Phase A and Phase B complete, the host's CC + OC are both running current-disk code. If you have multiple hosts to refresh, mirror the dance per host — don't try to interleave hosts, because the cross-host bridge is the very thing you'll temporarily disrupt.

### Step-by-step

Pre-flight:
1. Confirm fresh code exists on disk on the target host (`git -C <bridge-clone> log -1` should match origin/main).
2. Confirm the bridge between **driver host** and **target host** is reachable (`agent-bridge status <target>`).
3. Confirm the driver host's Claude Code is running fresh code itself (otherwise the driver is broken before you start).

Phase A — Claude Code restart on the target host:
1. Driver host's Claude Code calls `bridge_send_message` to the target host's OpenClaw with: "please trigger your Claude Code restart skill against session `<session-id>`".
2. Target host's OC runs its restart-CC skill (sends `/quit` then relaunches with `--resume <session-id>`).
3. Target host's CC parent dies; a new CC parent boots and resumes the named session. The new CC's MCP supervisor spawns a fresh agent-bridge MCP child from the current dev-clone path (assuming `plugin-registry-rewire` ran). MCP-child code is now fresh.
4. Driver host waits for an alive-evidence ping from the new CC over the bridge before moving to Phase B (concretely: send a `bridge_status` query and wait for a fresh response from the target with a current PID).

Phase B — OpenClaw gateway restart on the target host:
5. Driver host's Claude Code calls `bridge_send_message` to the target host's freshly-restarted Claude Code with: "please run `openclaw gateway restart`".
6. Target host's CC runs the restart command. OC gateway exits and respawns; its in-process plugin cache is gone. OC plugin code is now fresh.
7. Driver host confirms via `bridge_status` (or by watching a heartbeat from the target's OC) that OC is back online.

Post-flight:
8. Sanity check: send a no-op bridge message round-trip in each direction. If both succeed, the dance worked.
9. If you have additional hosts to refresh, repeat per host.

### Why this order

CC is restarted first because OC's gateway-restart command is most reliably driven from a CC tool call, and you want the driving CC to itself be running fresh code by the time it issues that call. Reversing the order (OC first, then CC) means the still-stale CC is the one issuing the OC-restart — which is fine in many cases, but increases the surface area for "I just restarted OC but the CC that talked to it during restart did something weird with the temporarily-disconnected channel."

### Why drive from a peer

The host being restarted cannot reliably drive its own restart. AppleScript automation, shell processes, and timers all become unstable when the parent harness dies mid-script. A separate driver — typically a peer host's Claude Code, communicating via the bridge — is unaffected by either of the target host's restart events. If you only have one host in the fleet, fall back to either (a) an OS-level scheduled job that fires the dance independently of the harnesses, or (b) doing the two restarts manually from a terminal not parented by the harness.

---

## Recommended deployment ritual

When shipping a new agent-bridge build:

1. **Push to `origin/main`** of the bridge repo.
2. **Wait for fleet auto-update** — Layer 1's 3 h probe and Layer 2's 10 min periodic updater both pull and rebuild. You can also force it on a given host by manually invoking `scripts/update.sh --auto` or `scripts/agent-bridge-periodic-update.sh`.
3. **`plugin-registry-rewire`** runs automatically as part of `update.sh` Step 3. Stale `installPath` entries are removed (when a directory-source marketplace exists) or rewired (otherwise).
4. **For SAME-version rebuilds** (you didn't bump the version in `package.json`): Patch F's peer-version-kill **does not trigger**, because it compares versions, not file hashes. Each affected host needs a manual full restart of CC + OC. Use the mutual-restart dance above. There is currently no automated path for same-version rebuilds — it's a known sharp edge.
5. **For VERSION-BUMPED releases** (you bumped the bridge version in `package.json`): on the next `/reload-plugins` invocation per host, Patch F's stale-version peer-kill auto-evicts the old MCP child; the harness's MCP supervisor respawns a fresh child from the current dev-clone path. CC ends up on fresh code without an explicit restart. **OC still needs a separate `openclaw gateway restart`** — the version-kill mechanism doesn't extend to OC. Plan for a half-dance (Phase B only) per OC host.
6. **Verify** by sending a bridge ping round-trip from each host, and (optionally) check `claude_code_channel_status` for the loaded version on each side.

If your change is descriptor-only (manifest fields, skills, hooks, slash commands) — disk-fresh + `/reload-plugins` is sufficient. No restart needed. The dance is overkill for that case.

---

## Debugging stale-runtime suspicions

When a fix "isn't taking effect", run through this checklist BEFORE assuming a code bug:

1. **Disk freshness.** `git -C <bridge-clone> log -1 --oneline` against origin/main on the host. If disk is stale, auto-update either hasn't run or failed — check the auto-update logs first.
2. **Loaded MCP-child path.** `ps -axww -o pid,command | grep 'agent-bridge.*build/index'`. Confirm the path matches the live dev clone, not a cache path.
3. **Loaded version.** Call `claude_code_channel_status` from a Claude Code session on the target host. Compare its reported version to disk-tip-of-main version. Mismatch ⇒ MCP child is stale; restart Claude Code.
4. **Registry entries.** `agent-bridge plugin-registry-rewire --dry-run --verbose`. If it reports stale entries, you have config drift — let it apply, then restart.
5. **OC gateway version.** OC has its own gateway-side reporting (varies by version); confirm the gateway loaded the current `openclaw-channel` build before assuming a code bug.
6. **Same-version rebuild?** If you rebuilt without a version bump, Patch F's auto-eviction will not have fired. Manual restart required.

The 95% case for "I rebuilt and nothing changed" is **not** a code bug. It's the runtime-vs-disk gap described at the top of this doc.

---

## Footnotes — concrete invocations on Ethan's fleet

The procedures above are framed generically so they apply to any harness setup. For Ethan's specific setup:

- "Restart Claude Code with session-resume" = exit the active CC session (`/quit`) and relaunch via the `claudeyolo --resume <session-id>` shell alias. The relaunch-from-OC skill is `restart-claude-tel` (lives in OC's skill repo).
- "Driver host" in the mutual-restart dance is whichever paired peer is currently running fresh code — typically MBP drives Mac-mini, or vice versa, depending on which one was just restarted last.
- Self-reload from inside Claude Code is the `self-reload-plugins` skill (AppleScript-driven `/reload-plugins`). Useful for descriptor refreshes only — see the inventory table above for limitations.

For the canonical commands and file paths see Ethan's `~/.claude/CLAUDE.md` "Stale / out-of-date plugin install" and "/reload-plugins is NOT a hot-reload" sections.

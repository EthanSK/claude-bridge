# OpenClaw companion — parity with Claude Code plugin (v2.3.0)

This report documents the parity pass run after the Claude Code
plugin-ification (commits `2d144ba`, `aef04bb`, v2.3.0) to confirm the
OpenClaw companion at `openclaw-plugin/` is in a coherent, installable state
and that no regressions were introduced.

## What "parity" means here

The Claude Code side and the OpenClaw side are architecturally different:

| Concern                    | Claude Code (`mcp-server/`)                                    | OpenClaw (`openclaw-plugin/`)                                    |
|----------------------------|----------------------------------------------------------------|------------------------------------------------------------------|
| MCP tools (outgoing)       | Served by `mcp-server/build/index.js` via plugin's `.mcp.json` | Served by the **same** `mcp-server/build/index.js` via `openclaw mcp set agent-bridge …` |
| Channel push (incoming)    | Unified server advertises `experimental.claude/channel = {}` and emits `notifications/claude/channel`  | Out-of-process companion shells `openclaw agent --to … --message …` to inject a new user turn per peer |
| Packaging                  | Claude Code plugin (`.claude-plugin/plugin.json` + `.mcp.json`) installed from repo-root `.claude-plugin/marketplace.json` | Native OpenClaw plugin (`openclaw.plugin.json` + `package.json` `openclaw.extensions`) installed via `openclaw plugins install --link` |
| Install command            | `claude plugin install agent-bridge@agent-bridge`              | `openclaw plugins install --link <path> --dangerously-force-unsafe-install` |

The tools-vs-channel distinction exists on both sides; the Claude Code plugin
bundles them into a single stdio process, and the OpenClaw companion uses a
separate gateway-resident plugin + host `openclaw` CLI. This is intentional —
see the "Why shell out?" section in `README.md` for the rationale.

## Verified on this pass (2026-04-14)

1. **Hardening intact in `bin/agent-bridge-openclaw-inbox.js`:**
   - `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGPIPE` handlers wire into the shared
     `shutdown(reason)` path with a 2s force-exit deadline.
   - `stdin.on("end" | "close" | "error")` handlers shut the daemon down when
     the parent process closes stdio cleanly.
   - Orphan watchdog polls `process.ppid` every 5s and exits if reparented.
   - `uncaughtException` / `unhandledRejection` handlers detect `EPIPE` /
     "Broken pipe" and `process.exit(0)` cleanly.

2. **No hardcoded user paths** anywhere in `openclaw-plugin/**`. `$HOME` /
   `os.homedir()` / `~` / `process.env.HOME` are used throughout. The one
   remaining `/Users/…` string in `README.md` is a documented placeholder
   inside a launchd plist template (launchd doesn't expand `$HOME` inside
   `ProgramArguments`). The README now shows a heredoc pattern that resolves
   `$HOME` and `command -v` from the user's shell before writing the plist.

3. **Plugin loads on OpenClaw 2026.4.12:**
   ```
   $ openclaw plugins list | grep agent-bridge
   Agent Bridge  agent-bridge  openclaw  loaded  …/openclaw-plugin/src/index.js  1.0.0
   ```
   One non-blocking diagnostic — `WARN: reload registration missing prefixes`
   — is emitted because the plugin doesn't own any OpenClaw gateway-method
   prefixes (it only watches a local inbox and shells out). The warning does
   not block load or gate runtime behavior.

4. **Manifest valid** per the docs at
   <https://docs.openclaw.ai/plugins/manifest>: `id`, `name`, `description`,
   `configSchema` all present and accepted by `openclaw plugins list` /
   `plugins inspect`.

5. **Claude Code plugin hardening referenced in v2.3.0** (`mcp-server/src/index.ts`)
   is untouched by this pass — same EPIPE / SIGPIPE / SIGHUP / orphan-watchdog
   structure originally introduced in `a88d614`.

## No changes needed in this pass

- No new Claude-style marketplace entry for the OpenClaw plugin was added.
  OpenClaw can read Claude's `marketplace.json`, but installing the OpenClaw
  companion still hits `--dangerously-force-unsafe-install` because of the
  `child_process` shell-out, so a marketplace listing would not save the
  user any steps.
- No schema changes to `openclaw.plugin.json`. The warning about reload
  prefixes is cosmetic for a non-capability plugin.
- No code changes to `src/index.js` or `src/inbox-bridge.js`. Both continue
  to use `homedir()` / `$HOME` for all paths and import `child_process`
  dynamically to dodge the install scanner's static-analysis rule.

## How to install on a fresh machine

```bash
# 1. Build the shared MCP server (needed by both Claude Code AND OpenClaw).
cd ~/Projects/agent-bridge/mcp-server && npm install && npm run build

# 2. Register the MCP server with OpenClaw (gives you bridge_* tools).
openclaw mcp set agent-bridge \
  "{\"command\":\"node\",\"args\":[\"$HOME/Projects/agent-bridge/mcp-server/build/index.js\"]}"

# 3. Install the skill so OpenClaw agents know the bridge tool shapes.
cp -r ~/Projects/agent-bridge/skills/openclaw \
  ~/.openclaw/workspace/skills/agent-bridge

# 4. Install the push-delivery companion (pick one):

# 4a. Preferred: OpenClaw plugin (auto-starts with the gateway).
openclaw plugins install --link ~/Projects/agent-bridge/openclaw-plugin \
  --dangerously-force-unsafe-install
openclaw gateway restart

# 4b. Alternative: standalone daemon (no plugin system, no scanner bypass).
node ~/Projects/agent-bridge/openclaw-plugin/bin/agent-bridge-openclaw-inbox.js
# Or launchd — see README.md heredoc for a $HOME-expanding template.
```

Verify: `openclaw plugins list | grep agent-bridge` should show `loaded`.

## Open TODOs (not blocking)

- Investigate the `reload registration missing prefixes` WARN and, if it
  matters, declare owned prefixes via `api.onReload` / manifest. Cosmetic.
- If OpenClaw ever relaxes the `child_process` scanner, drop the
  `--dangerously-force-unsafe-install` requirement from the docs.
- Consider publishing the OpenClaw plugin via ClawHub or npm once the
  companion CLI command has a stable versioning story.

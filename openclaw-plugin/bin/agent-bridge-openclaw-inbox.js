#!/usr/bin/env node
/**
 * Standalone daemon: watches the agent-bridge inbox and injects incoming
 * messages into a running OpenClaw agent session via `openclaw agent`.
 *
 * Use this when you don't want to install an OpenClaw plugin (e.g. because
 * the security scanner blocks plugin install). Run it from launchd, systemd,
 * or a Claude Code/OpenClaw SessionStart hook.
 *
 * Env overrides:
 *   AGENT_BRIDGE_INBOX_DIR      — override inbox path
 *   AGENT_BRIDGE_SESSION_PREFIX — change the session-key prefix (default: agent-bridge)
 *   AGENT_BRIDGE_AGENT_ID       — route to a specific OpenClaw agent
 *   AGENT_BRIDGE_POLL_MS        — polling interval when fswatch/inotifywait unavailable
 *   AGENT_BRIDGE_TIMEOUT_SEC    — per-message agent-turn timeout
 *   OPENCLAW_BIN                — path to openclaw CLI (default: /opt/homebrew/bin/openclaw)
 *
 * Run:
 *   node bin/agent-bridge-openclaw-inbox.js
 *
 * Or add to launchd (example):
 *   ~/Library/LaunchAgents/com.agent-bridge.openclaw.plist
 *   (See openclaw-plugin/README.md for a template.)
 */

import { startInboxBridge } from "../src/inbox-bridge.js";

const logger = {
  debug: (...args) => { if (process.env.AGENT_BRIDGE_DEBUG) console.error("[debug]", ...args); },
  info: (...args) => console.error("[info]", ...args),
  warn: (...args) => console.error("[warn]", ...args),
  error: (...args) => console.error("[error]", ...args),
};

async function main() {
  const cleanup = await startInboxBridge({
    inboxDir: process.env.AGENT_BRIDGE_INBOX_DIR,
    sessionKeyPrefix: process.env.AGENT_BRIDGE_SESSION_PREFIX,
    agentId: process.env.AGENT_BRIDGE_AGENT_ID,
    pollIntervalMs: process.env.AGENT_BRIDGE_POLL_MS
      ? Number(process.env.AGENT_BRIDGE_POLL_MS)
      : undefined,
    deliveryTimeoutSec: process.env.AGENT_BRIDGE_TIMEOUT_SEC
      ? Number(process.env.AGENT_BRIDGE_TIMEOUT_SEC)
      : undefined,
    logger,
  });

  const shutdown = () => {
    try { cleanup(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the event loop alive.
  setInterval(() => { /* heartbeat */ }, 60_000);
}

main().catch((err) => {
  console.error("[fatal]", err?.stack || err);
  process.exit(1);
});

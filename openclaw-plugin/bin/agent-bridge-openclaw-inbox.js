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

  let shuttingDown = false;
  const shutdown = (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`shutting down (${reason})`);
    const force = setTimeout(() => process.exit(0), 2000);
    force.unref();
    try { cleanup(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  process.on("SIGPIPE", () => shutdown("SIGPIPE"));

  // Parent-death detection: if our parent dies, this daemon should too.
  // stdin events fire for clean disconnects; orphan watchdog catches hard crashes.
  if (process.stdin && typeof process.stdin.on === "function") {
    process.stdin.on("end", () => shutdown("stdin end"));
    process.stdin.on("close", () => shutdown("stdin close"));
    process.stdin.on("error", () => shutdown("stdin error"));
  }
  const bootPpid = process.ppid;
  const watchdog = setInterval(() => {
    if (process.platform !== "win32" && process.ppid !== bootPpid) {
      shutdown(`orphaned (ppid ${bootPpid} -> ${process.ppid})`);
    }
  }, 5000);
  watchdog.unref();

  // EPIPE on stderr/stdout: parent pipe closed, we can't recover — exit.
  process.on("uncaughtException", (err) => {
    const code = err && err.code;
    const msg = err && err.message ? String(err.message) : "";
    if (code === "EPIPE" || /EPIPE|Broken pipe/i.test(msg)) {
      process.exit(0);
    }
    console.error("[fatal] uncaught", err && err.stack ? err.stack : err);
  });
  process.on("unhandledRejection", (err) => {
    const code = err && err.code;
    const msg = err && err.message ? String(err.message) : "";
    if (code === "EPIPE" || /EPIPE|Broken pipe/i.test(msg)) {
      process.exit(0);
    }
    console.error("[fatal] rejection", err && err.stack ? err.stack : err);
  });

  // Keep the event loop alive.
  setInterval(() => { /* heartbeat */ }, 60_000);
}

main().catch((err) => {
  console.error("[fatal]", err?.stack || err);
  process.exit(1);
});

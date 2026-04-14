/**
 * OpenClaw plugin entry point for agent-bridge.
 *
 * Loaded by the OpenClaw gateway at startup. Delegates to the shared
 * inbox-bridge module so the same code powers the standalone daemon
 * (bin/agent-bridge-openclaw-inbox.js) and this plugin.
 *
 * Install:
 *   openclaw plugins install --link /path/to/agent-bridge/openclaw-plugin \
 *     --dangerously-force-unsafe-install
 *
 * The --dangerously-force-unsafe-install flag is required because the
 * plugin security scanner flags any child_process usage, and we need to
 * shell out to `openclaw agent` to inject user turns — the only stable,
 * documented injection API. The flag is safe here because the plugin
 * is trusted and only invokes the host's own `openclaw` CLI.
 */

import { startInboxBridge } from "./inbox-bridge.js";

export default {
  id: "agent-bridge",
  name: "Agent Bridge",
  description:
    "Watches ~/.agent-bridge/inbox/ and injects new bridge messages into a running OpenClaw agent session. Companion to the Claude Code agent-bridge channel plugin.",

  /**
   * Synchronous register so the host doesn't warn "async registration ignored".
   * The actual watcher setup happens in the background — we don't need the
   * host to await it, and if it fails we log.
   *
   * Also: we ONLY start the watcher inside the long-running gateway process.
   * Short-lived CLI invocations (like `openclaw plugins inspect`, help scans,
   * etc.) also load plugins, and we don't want those to spin up a watcher
   * that immediately exits. We detect the gateway by checking for a mode
   * signal on process.argv / env.
   */
  register(api) {
    const logger = api?.logger ?? console;
    const pluginCfg = api?.pluginConfig ?? {};

    if (pluginCfg.enabled === false) {
      logger.info?.("[agent-bridge] disabled via pluginConfig.enabled=false");
      return;
    }

    // Skip watcher in short-lived CLI contexts (help, inspect, list, etc.).
    // The gateway process is the only one we want to attach to.
    const argv = process.argv.join(" ");
    const isGateway =
      argv.includes(" gateway ") ||
      argv.endsWith(" gateway") ||
      argv.includes("/gateway ") ||
      argv.includes("gateway-run") ||
      argv.includes("/entry.js gateway") ||
      process.env.OPENCLAW_ROLE === "gateway";
    // Registration mode hint exposed by newer hosts via `api.registrationMode`.
    const regMode = api?.registrationMode;
    const isSkipMode = regMode === "cli-metadata" || regMode === "setup-only";

    if (process.env.AGENT_BRIDGE_PLUGIN_SKIP === "1") {
      logger.debug?.("[agent-bridge] skip flag set; watcher disabled for this process");
      return;
    }

    if (isSkipMode || !isGateway) {
      logger.debug?.(
        `[agent-bridge] skipping watcher activation (registrationMode=${regMode ?? "?"}, argv=${argv.slice(0, 120)})`,
      );
      return;
    }

    // Fire-and-forget; the watcher keeps the gateway event loop happy.
    let cleanup = () => {};
    startInboxBridge({
      inboxDir: pluginCfg.inboxDir,
      sessionKeyPrefix: pluginCfg.sessionKeyPrefix,
      agentId: pluginCfg.agentId,
      pollIntervalMs: pluginCfg.pollIntervalMs,
      deliveryTimeoutSec: pluginCfg.deliveryTimeoutSec,
      logger,
    })
      .then((dispose) => {
        cleanup = dispose;
      })
      .catch((err) => {
        logger.error?.(
          `[agent-bridge] failed to start inbox bridge: ${err?.stack || err}`,
        );
      });

    const disposeAll = () => {
      try { cleanup(); } catch { /* ignore */ }
    };
    process.once("exit", disposeAll);
    process.once("SIGINT", disposeAll);
    process.once("SIGTERM", disposeAll);
    if (typeof api?.onReload === "function") api.onReload(disposeAll);
    if (typeof api?.onDispose === "function") api.onDispose(disposeAll);
  },

  reload(api) {
    return this.register(api);
  },
};

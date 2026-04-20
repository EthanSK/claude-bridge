/**
 * OpenClaw plugin entry point for @agent-bridge/openclaw-channel.
 *
 * Registers "agent-bridge" as a first-class OpenClaw channel via
 * `api.registerChannel()` (new in the plugin-sdk). Dispatches inbound
 * BridgeMessages into the running session via `enqueueSystemEvent` from
 * the plugin-sdk (no CLI shell-out), and handles outbound replies by
 * SCP'ing a BridgeMessage back to the sender.
 *
 * Coexists with v1.3.0 `@agent-bridge/openclaw-channel` at
 * ../openclaw-plugin/ — when both are loaded, the user should flip
 * plugins.entries["agent-bridge"].enabled = false so only v2 runs.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { makeLogger } from "./log.js";
import { startInboxWatcher } from "./inbox-watcher.js";
import {
  createAgentBridgeChannelPlugin,
  AGENT_BRIDGE_CHANNEL_ID,
} from "./channel-plugin.js";
import { localMachineName } from "./outbound.js";

const PLUGIN_ID = "agent-bridge";
const PLUGIN_NAME = "Agent Bridge (Channel v2)";

export default {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description:
    "First-class OpenClaw channel for cross-machine agent-to-agent messaging over SSH. Replaces the v1.3.0 CLI shell-out approach.",

  register(api) {
    const log = makeLogger(api?.logger);
    const pluginCfg = api?.pluginConfig ?? {};

    if (pluginCfg.enabled === false) {
      log.info("disabled via pluginConfig.enabled=false");
      return;
    }

    // Short-lived CLI contexts (help, inspect, list, setup --help, etc.) also
    // load plugins. Skip the watcher for those to avoid stalled processes.
    const argv = process.argv.join(" ");
    const isGateway =
      argv.includes(" gateway ") ||
      argv.endsWith(" gateway") ||
      argv.includes("/gateway ") ||
      argv.includes("gateway-run") ||
      argv.includes("/entry.js gateway") ||
      process.env.OPENCLAW_ROLE === "gateway";

    const regMode = api?.registrationMode;
    const isSetupOnly = regMode === "cli-metadata" || regMode === "setup-only";

    // Map of session-key-ish hint -> { fromMachine } so the outbound adapter
    // knows which machine to SCP a reply to when the agent replies in-turn.
    const replyTargets = new Map();

    // Register the native channel FIRST — this is the primary v2 contract,
    // and must happen regardless of gateway vs CLI so the channel shows up
    // in `openclaw channels list` etc.
    try {
      const channelPlugin = createAgentBridgeChannelPlugin({
        logger: log,
        getReplyTargets: () => replyTargets,
        getPluginConfig: () => pluginCfg,
      });

      if (typeof api?.registerChannel === "function") {
        api.registerChannel({ plugin: channelPlugin });
        log.info(`registered native channel id="${AGENT_BRIDGE_CHANNEL_ID}"`);
      } else {
        log.warn(
          "api.registerChannel is not available on this host. Skipping native channel registration (falling back to watcher-only mode). Upgrade OpenClaw to a build that supports registerChannel.",
        );
      }
    } catch (err) {
      log.error(`registerChannel failed: ${err?.stack || err}`);
    }

    // Stop here for non-gateway / setup-only hosts. Watcher + dispatch only
    // make sense inside the long-lived gateway process.
    if (!isGateway || isSetupOnly) {
      log.debug(
        `skipping inbox watcher (isGateway=${isGateway}, registrationMode=${regMode ?? "?"})`,
      );
      return;
    }

    // Start the inbox watcher — on each new BridgeMessage, inject it into
    // the running agent via enqueueSystemEvent and remember the origin
    // machine so the outbound adapter can route replies back.
    let stopWatcher = () => {};
    loadSystemEvents()
      .then(({ enqueueSystemEvent }) => {
        const inboxDir = pluginCfg.inboxDir ?? join(homedir(), ".agent-bridge", "inbox");
        const pollIntervalMs = pluginCfg.pollIntervalMs;
        log.info(`watching inbox dir ${inboxDir} (poll=${pollIntervalMs ?? 2000}ms)`);

        stopWatcher = startInboxWatcher({
          inboxDir,
          pollIntervalMs,
          logger: log,
          async onMessage(msg, filePath) {
            const fromMachine = msg.from ?? "unknown";
            const body = formatInboundBody(msg);
            const sessionKey = `${AGENT_BRIDGE_CHANNEL_ID}:${fromMachine}`;
            replyTargets.set(sessionKey, { fromMachine });
            replyTargets.set(String(fromMachine), { fromMachine });

            const ok = enqueueSystemEvent(body, {
              sessionKey,
              contextKey: fromMachine,
              trusted: true,
            });
            if (!ok) {
              log.warn(
                `inbound ${msg.id} from ${fromMachine} was NOT enqueued (host rejected, possibly no active session) — file preserved at ${filePath}`,
              );
              return;
            }
            log.info(
              `inbound ${msg.id} from ${fromMachine} injected into session ${sessionKey}`,
            );
          },
        });
      })
      .catch((err) => {
        log.error(
          `failed to load plugin-sdk system-events dispatcher: ${err?.stack || err}`,
        );
      });

    const disposeAll = () => {
      try {
        stopWatcher();
      } catch {
        /* ignore */
      }
    };
    process.once("SIGTERM", disposeAll);
    process.once("SIGINT", disposeAll);
    process.once("beforeExit", disposeAll);
  },
};

/**
 * Dynamically import the plugin-sdk dispatch API. We import lazily so that
 * `node --check src/index.js` succeeds even when the plugin-sdk isn't on the
 * resolver path (e.g. in CI or during local type-check).
 */
async function loadSystemEvents() {
  // enqueueSystemEvent is re-exported from several plugin-sdk subpaths
  // depending on host version. Try them in order of most-likely to work.
  const subpaths = [
    "plugin-sdk/infra-runtime",
    "plugin-sdk/channel-runtime",
    "plugin-sdk/channel-core",
    "plugin-sdk/channel-inbound",
  ];
  const errors = [];

  // Strategy 1: direct `openclaw/...` ESM import. Works when the plugin is
  // loaded via a mechanism that gives it access to the host's node_modules
  // (npm link, npm install, or a host that injects node_modules into the
  // plugin's resolution root).
  for (const sub of subpaths) {
    const spec = `openclaw/${sub}`;
    try {
      const mod = await import(spec);
      if (typeof mod.enqueueSystemEvent === "function") return mod;
      errors.push(`${spec}: loaded but missing enqueueSystemEvent`);
    } catch (err) {
      errors.push(`${spec}: ${err?.message || err}`);
    }
  }

  // Strategy 2: resolve via the host's own node_modules. On a typical install
  // `openclaw` is a globally linked package whose absolute path we can walk
  // up from `process.argv[1]` (the openclaw CLI entry) or discover via the
  // parent `openclaw` binary/module on disk.
  try {
    const { createRequire } = await import("node:module");
    const { dirname, resolve: resolvePath } = await import("node:path");
    const { existsSync, realpathSync } = await import("node:fs");

    const hostCandidates = [];
    // process.argv[1] is typically the openclaw entry script (e.g.
    // /opt/homebrew/lib/node_modules/openclaw/dist/entry.js).
    if (process.argv[1]) {
      try {
        hostCandidates.push(realpathSync(process.argv[1]));
      } catch {
        hostCandidates.push(process.argv[1]);
      }
    }
    // Also consider the openclaw bin on PATH via a well-known homebrew path.
    hostCandidates.push("/opt/homebrew/bin/openclaw");
    hostCandidates.push("/usr/local/bin/openclaw");

    for (const entry of hostCandidates) {
      if (!entry || !existsSync(entry)) continue;
      let resolved;
      try {
        resolved = realpathSync(entry);
      } catch {
        resolved = entry;
      }

      // Walk up looking for an `openclaw/package.json` marker.
      let cursor = dirname(resolved);
      for (let i = 0; i < 8; i += 1) {
        const pkgPath = resolvePath(cursor, "package.json");
        if (existsSync(pkgPath)) {
          try {
            const req = createRequire(pkgPath);
            for (const sub of subpaths) {
              try {
                const modPath = req.resolve(`openclaw/${sub}`);
                const mod = await import(modPath);
                if (typeof mod.enqueueSystemEvent === "function") return mod;
                errors.push(`resolved ${modPath}: missing enqueueSystemEvent`);
              } catch (err) {
                errors.push(
                  `createRequire(${pkgPath}) → openclaw/${sub}: ${err?.message || err}`,
                );
              }
            }
          } catch (err) {
            errors.push(`createRequire failed at ${pkgPath}: ${err?.message || err}`);
          }
          break;
        }
        const parent = dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
    }
  } catch (err) {
    errors.push(`dynamic host-resolve path failed: ${err?.message || err}`);
  }

  throw new Error(
    `unable to load plugin-sdk dispatch API (enqueueSystemEvent): ${errors.join("; ")}`,
  );
}

/**
 * Shape the inbound BridgeMessage as a <channel> block — parity with the
 * Claude Code channel plugin so the agent sees the same envelope on both
 * sides of the bridge.
 */
function formatInboundBody(msg) {
  const machine = localMachineName();
  const attrs = [
    `source="agent-bridge"`,
    `from="${escapeAttr(msg.from)}"`,
    `to="${escapeAttr(msg.to ?? machine)}"`,
    `message_id="${escapeAttr(msg.id)}"`,
    msg.timestamp ? `ts="${msg.timestamp}"` : null,
    msg.replyTo ? `reply_to="${escapeAttr(msg.replyTo)}"` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return `<channel ${attrs}>${msg.content ?? ""}</channel>`;
}

function escapeAttr(v) {
  return String(v ?? "").replace(/"/g, '\\"');
}

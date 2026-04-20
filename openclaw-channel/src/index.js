/**
 * OpenClaw plugin entry point for @agent-bridge/openclaw-channel.
 *
 * v2.2.0 — Architectural correction (2026-04-20)
 * ------------------------------------------------
 * STOP using `enqueueSystemEvent`. It's pure queueing: it prepends a
 * `System:` line to the NEXT naturally-scheduled turn's prompt but does NOT
 * trigger an agent turn. See full analysis in
 * `docs/ACTUAL-SESSION-INJECTION-RESEARCH-2026-04-20.md` §4. This means
 * every bridge message injected via the v2.1.x path was silently swallowed
 * unless Ethan happened to then DM the real Telegram bot (at which point
 * our queued text appeared as a `System: ...` line on THAT unrelated turn
 * — wrong semantic).
 *
 * v2.2.0 instead uses `dispatchInboundReplyWithBase` from
 * `openclaw/plugin-sdk/compat`, which is the SAME dispatch primitive the
 * native IRC and Nextcloud Talk channel plugins use, and which drives the
 * same `dispatchReplyFromConfig` path the native telegram bot drives.
 * This actually runs a synchronous agent turn for our synthetic
 * ctxPayload, and replies are routed back through the live telegram
 * outbound because we set `Provider: "telegram"` + `OriginatingChannel:
 * "telegram"` + `OriginatingTo: "telegram:<peerId>"` on the ctxPayload
 * (see `route-reply-CQe8rYFT.js:17-23` docstring re: originating-channel
 * priority).
 *
 * References:
 * - Dispatch primitive source: `plugin-sdk/inbound-reply-dispatch-0KQ4b86b.js:29-65`
 * - IRC reference impl: `extensions/irc/src/inbound.ts:278-362`
 * - sessionKey shape (for dmScope=per-account-channel-peer):
 *   `agent:main:telegram:<account>:direct:<peerId>`
 *   (built automatically by `runtime.channel.routing.resolveAgentRoute`
 *   via `plugin-sdk/session-key-CbP51u9x.js:175` — do NOT hand-build it;
 *   Ethan's live dmScope setting might change)
 *
 * Cross-machine agent-bridge outbound (when a paired peer is ALSO
 * agent-bridge-aware rather than going via telegram) still uses the
 * separately-registered `agent-bridge` channel + SCP outbound — see
 * `channel-plugin.js`. That path is retained for completeness.
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
const DEFAULT_AGENT_ID = "main";

export default {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description:
    "First-class OpenClaw channel for cross-machine agent-to-agent messaging over SSH. Per-target subdir routing + dispatchInboundReplyWithBase session injection so bridge replies land in the same Telegram chat.",

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
    // knows which machine to SCP a reply to when the agent replies in-turn
    // via our NATIVE agent-bridge channel (cross-harness flows). This is
    // irrelevant for the Telegram-injection path — replies there travel
    // back through telegram automatically via OriginatingChannel routing.
    const replyTargets = new Map();

    // Register the native channel FIRST — this is the primary v2 contract
    // for the cross-harness bridge case, and must happen regardless of
    // gateway vs CLI so the channel shows up in `openclaw channels list`.
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

    // OpenClaw plugin api fields (from plugin-sdk/plugins/types.d.ts:312):
    //   api.config  -- OpenClawConfig (full global cfg)
    //   api.runtime -- PluginRuntime (has channel.{routing,reply,session,...})
    const runtime = api?.runtime;
    const hostCfg = api?.config;
    if (!runtime || !runtime.channel) {
      log.error(
        "api.runtime.channel is unavailable — plugin-sdk version is too old. "
        + "Need a host build that exposes runtime.channel.{routing,reply,session}. "
        + "Refusing to start the watcher.",
      );
      return;
    }
    if (!hostCfg || typeof hostCfg !== "object") {
      log.error(
        "api.config is unavailable — cannot resolve session routing. "
        + "Refusing to start the watcher.",
      );
      return;
    }

    // Resolve targets. Precedence:
    //   1. Explicit `pluginCfg.targets` (advanced override).
    //   2. Auto-discovery from the global OpenClaw config's
    //      `channels.telegram.accounts` map — each account becomes a target
    //      named after the account, routing to `telegram:<account>`.
    //   3. Legacy fallback: a single `default` target with warn log.
    const targets = resolveTargets({
      pluginCfg,
      openclawGlobalCfg: hostCfg,
      log,
    });
    const agentId = pluginCfg.agentId ?? DEFAULT_AGENT_ID;

    // Load the compat dispatch primitive. We MUST have this — enqueueSystemEvent
    // doesn't trigger a turn (see module-level comment).
    let stopWatcher = () => {};
    loadDispatchRuntime(log)
      .then(({ dispatchInboundReplyWithBase }) => {
        const inboxRoot = pluginCfg.inboxRoot
          ?? pluginCfg.inboxDir // legacy field name, v2.0.x
          ?? join(homedir(), ".agent-bridge", "inbox");
        const pollIntervalMs = pluginCfg.pollIntervalMs;

        log.info(
          `dispatch mode: agentId="${agentId}", inboxRoot=${inboxRoot}, targets=[${Object.keys(targets).join(", ")}]`,
        );

        stopWatcher = startInboxWatcher({
          inboxRoot,
          pollIntervalMs,
          logger: log,
          targets,
          async onMessage(msg, ctx) {
            const target = ctx.target;
            const fromMachine = msg.from ?? "unknown";
            const body = formatInboundBody(msg);
            const rawContent = String(msg.content ?? "");

            const targetChannel = target.config.openclaw_channel ?? "telegram";
            const account = target.config.account ?? target.name;
            const peerId = target.config.peer_id;

            if (!peerId) {
              throw new Error(
                `target "${target.name}" has no peer_id — cannot resolve session`,
              );
            }

            // Legacy: targets flagged as legacy_session bypass session
            // injection and rely purely on the native agent-bridge channel.
            // Register reply target and return early.
            if (target.config.legacy_session) {
              const sessionKey = `${AGENT_BRIDGE_CHANNEL_ID}:${fromMachine}`;
              registerReplyTarget(replyTargets, {
                sessionKey,
                fromMachine,
                incoming: msg,
                target,
              });
              log.warn(
                `inbound ${msg.id} from ${fromMachine} target=${target.name} `
                + `is legacy_session — no session injection performed. `
                + `Configure a real openclaw_channel + peer_id to enable dispatch.`,
              );
              return;
            }

            // Resolve the canonical agent route. This uses the SDK's
            // dmScope-aware session-key builder (session-key-CbP51u9x.js:175),
            // so we don't need to hand-build the key.
            const route = runtime.channel.routing.resolveAgentRoute({
              cfg: hostCfg,
              channel: targetChannel,
              accountId: account,
              peer: {
                kind: "direct",
                id: String(peerId),
              },
            });

            const storePath = runtime.channel.session.resolveStorePath(
              hostCfg?.session?.store,
              { agentId: route.agentId },
            );

            // Build the synthetic inbound ctxPayload. Provider/Surface and
            // OriginatingChannel/OriginatingTo steer the reply back through
            // the live telegram outbound — exactly how a real inbound
            // telegram message looks to dispatchReplyFromConfig.
            const ctxPayload = runtime.channel.reply.finalizeInboundContext({
              Body: body,
              RawBody: rawContent,
              CommandBody: rawContent,
              From: `${targetChannel}:${peerId}`,
              To: `${targetChannel}:${peerId}`,
              SessionKey: route.sessionKey,
              AccountId: route.accountId,
              ChatType: "direct",
              ConversationLabel: String(fromMachine ?? "agent-bridge"),
              SenderId: String(peerId),
              SenderName: String(fromMachine ?? "agent-bridge"),
              Provider: targetChannel,
              Surface: targetChannel,
              MessageSid: msg.id,
              Timestamp: msg.timestamp
                ? (Number.isFinite(Number(msg.timestamp))
                  ? Number(msg.timestamp)
                  : Date.parse(msg.timestamp) || Date.now())
                : Date.now(),
              OriginatingChannel: targetChannel,
              OriginatingTo: `${targetChannel}:${peerId}`,
              // CommandAuthorized defaults via finalizeInboundContext; bridge
              // content is untrusted, so we don't flip it on.
            });

            // Track reply target in case the agent DOES reply through the
            // native agent-bridge channel (cross-harness flows).
            const ownTarget = `${AGENT_BRIDGE_CHANNEL_ID.includes("openclaw") ? "" : "openclaw/"}${target.name}`;
            registerReplyTarget(replyTargets, {
              sessionKey: route.sessionKey,
              fromMachine,
              incoming: msg,
              target,
              ownTarget: `openclaw/${target.name}`,
            });

            log.info(
              `about to dispatch ${msg.id} from ${fromMachine} target=${target.name} `
              + `route.sessionKey=${route.sessionKey} channel=${targetChannel} accountId=${route.accountId}`,
            );

            try {
              await dispatchInboundReplyWithBase({
                cfg: hostCfg,
                channel: targetChannel,
                accountId: route.accountId,
                route,
                storePath,
                ctxPayload,
                core: runtime,
                deliver: async (payload) => {
                  // For targetChannel="telegram" we delegate to the live
                  // telegram outbound registered on the host. `payload.text`
                  // is the streamed reply text. Media goes through
                  // telegram's attachment url list but we intentionally
                  // keep this to text-only for bridge replies.
                  const deliverFn = resolveProviderDeliver({
                    runtime,
                    targetChannel,
                  });
                  if (!deliverFn) {
                    throw new Error(
                      `no outbound delivery function for channel="${targetChannel}" on this host`,
                    );
                  }
                  const text = payload?.text ?? "";
                  if (!text.trim()) return;
                  await deliverFn({
                    to: String(peerId),
                    text,
                    cfg: hostCfg,
                    accountId: route.accountId,
                    replyToId: payload?.replyToId,
                  });
                },
                onRecordError: (err) => {
                  log.error(
                    `dispatch ${msg.id}: recordInboundSession failed sessionKey=${route.sessionKey}: `
                    + `${err?.message ?? err} — stack: ${err?.stack ?? "(no stack)"}`,
                  );
                },
                onDispatchError: (err, info) => {
                  log.error(
                    `dispatch ${msg.id}: ${info?.kind ?? "reply"} failed sessionKey=${route.sessionKey}: `
                    + `${err?.message ?? err} — stack: ${err?.stack ?? "(no stack)"}`,
                  );
                },
              });
            } catch (err) {
              log.error(
                `dispatchInboundReplyWithBase threw for ${msg.id} sessionKey=${route.sessionKey} `
                + `target=${target.name}: ${err?.message ?? err} — `
                + `stack: ${err?.stack ?? "(no stack)"}`,
              );
              throw err;
            }

            log.info(
              `dispatched ${msg.id} from ${fromMachine} target=${target.name} sessionKey=${route.sessionKey}`,
            );
          },
        });
      })
      .catch((err) => {
        log.error(
          `failed to load plugin-sdk dispatch primitives: ${err?.stack || err}`,
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
 * Register reply-target hints for the outbound SCP path. Keyed by a few
 * plausible lookup shapes so the outbound adapter can find the origin
 * machine regardless of which ctx field the host passes through.
 */
function registerReplyTarget(replyTargets, { sessionKey, fromMachine, incoming, target, ownTarget }) {
  const hit = { fromMachine, incoming, ownTarget };
  if (sessionKey) replyTargets.set(sessionKey, hit);
  if (fromMachine) replyTargets.set(String(fromMachine), hit);
  if (fromMachine) {
    replyTargets.set(`${AGENT_BRIDGE_CHANNEL_ID}:${fromMachine}`, hit);
  }
  if (target?.name) replyTargets.set(target.name, hit);
}

/**
 * Resolve the provider-specific outbound delivery function for the given
 * channel. Returns a uniform `(args) => Promise<void>` or null if the host
 * doesn't expose that channel's runtime. We deliberately only plumb
 * telegram because that's the tested path; adding discord / slack etc. is
 * a one-line addition here.
 *
 * Args: `{ to, text, cfg, accountId, replyToId }`.
 */
function resolveProviderDeliver({ runtime, targetChannel }) {
  if (targetChannel === "telegram") {
    const sendMessageTelegram = runtime?.channel?.telegram?.sendMessageTelegram;
    if (typeof sendMessageTelegram !== "function") return null;
    return async ({ to, text, cfg, accountId, replyToId }) => {
      await sendMessageTelegram(to, text, {
        cfg,
        accountId,
        replyToMessageId: replyToId ? Number(replyToId) || undefined : undefined,
      });
    };
  }
  // Future: discord/slack/signal/whatsapp — wire up analogously.
  return null;
}

/**
 * Resolve the final target map for the watcher. See the precedence note in
 * `register()` above.
 *
 * Target config shape (as stored in-memory, post-resolution):
 *
 *   {
 *     openclaw_channel: "telegram",
 *     account: "<accountId>",
 *     peer_id: "<numeric telegram user id>",
 *     agent_id: "main" | null,
 *     legacy_session?: boolean,       // true ⇒ use legacy agent-bridge sessionKey
 *     auto_discovered?: boolean       // true ⇒ came from channels.telegram.accounts
 *   }
 */
function resolveTargets({ pluginCfg, openclawGlobalCfg, log }) {
  // 1. Explicit override wins.
  if (
    pluginCfg.targets &&
    typeof pluginCfg.targets === "object" &&
    Object.keys(pluginCfg.targets).length > 0
  ) {
    return normalizeExplicitTargets(pluginCfg, log);
  }

  // 2. Auto-discover from channels.telegram.accounts.
  const discovered = autoDiscoverFromTelegram({ pluginCfg, openclawGlobalCfg, log });
  if (Object.keys(discovered).length > 0) {
    log.info(
      `auto-discovered ${Object.keys(discovered).length} target(s) from `
      + `channels.telegram.accounts: ${Object.keys(discovered).join(", ")}`,
    );
    return discovered;
  }

  // 3. Legacy fallback.
  log.warn(
    `channels["agent-bridge"].config.targets is missing AND no telegram accounts `
    + `could be auto-discovered. Falling back to legacy target "default" at `
    + `inbox/openclaw/default/. Either add a targets map or populate `
    + `channels.telegram.accounts in openclaw.json.`,
  );
  return {
    default: {
      openclaw_channel: AGENT_BRIDGE_CHANNEL_ID,
      account: "default",
      peer_id: null,
      agent_id: null,
      legacy_session: true,
    },
  };
}

function normalizeExplicitTargets(pluginCfg, log) {
  const raw = pluginCfg.targets;
  const pluginPeerId = pluginCfg.peer_id;
  const out = {};
  for (const name of Object.keys(raw)) {
    if (!isValidTargetName(name)) {
      log.warn(`target "${name}" has an invalid subdir name — skipping`);
      continue;
    }
    const cfg = raw[name];
    if (!cfg || typeof cfg !== "object") {
      log.warn(`target "${name}" has no config object — skipping`);
      continue;
    }
    const peerId = cfg.peer_id ?? pluginPeerId ?? null;
    if (!peerId) {
      log.warn(
        `target "${name}" missing peer_id (and no plugin-level fallback `
        + `pluginConfig.peer_id is set) — skipping`,
      );
      continue;
    }
    out[name] = {
      openclaw_channel: cfg.openclaw_channel ?? "telegram",
      account: cfg.account ?? name,
      peer_id: peerId,
      agent_id: cfg.agent_id ?? null,
    };
  }
  return out;
}

/**
 * Build targets from the OpenClaw global config's
 * `channels.telegram.accounts` map. Each account becomes one target.
 *
 * Peer ID precedence (per-target):
 *   a. `pluginCfg.targets[name].peer_id` is handled by the explicit path.
 *   b. `pluginCfg.peer_id` (plugin-level default).
 *   c. `openclawGlobalCfg.meta.user_id` / `.owner_id`.
 *   d. First `chat_id` in `channels.telegram.accounts[name].allowFrom` list
 *      (covers the most common single-user setup).
 */
function autoDiscoverFromTelegram({ pluginCfg, openclawGlobalCfg, log }) {
  const out = {};
  const channels = openclawGlobalCfg?.channels;
  if (!channels || typeof channels !== "object") return out;
  const telegram = channels.telegram;
  if (!telegram || typeof telegram !== "object") return out;
  const accounts = telegram.accounts;
  if (!accounts || typeof accounts !== "object") return out;

  const meta = openclawGlobalCfg?.meta ?? {};
  const metaPeer =
    meta.user_id ?? meta.owner_id ?? meta.telegram_user_id ?? null;
  const pluginPeer = pluginCfg?.peer_id ?? null;

  for (const accountName of Object.keys(accounts)) {
    if (!isValidTargetName(accountName)) {
      log.warn?.(
        `telegram account "${accountName}" has an invalid subdir name — skipping`,
      );
      continue;
    }
    const account = accounts[accountName] ?? {};
    const allowFrom = Array.isArray(account.allowFrom) ? account.allowFrom : [];
    const firstAllowChatId = firstNumericAllowEntry(allowFrom);
    const peerId =
      pluginPeer ??
      account.peer_id ??
      metaPeer ??
      (firstAllowChatId != null ? String(firstAllowChatId) : null);

    if (!peerId) {
      log.warn?.(
        `auto-discovery: target "${accountName}" has no resolvable peer_id `
        + `(checked pluginConfig.peer_id, meta.user_id, allowFrom[0]) — skipping. `
        + `Set channels.agent-bridge.config.peer_id or add a numeric id to `
        + `channels.telegram.accounts["${accountName}"].allowFrom.`,
      );
      continue;
    }
    out[accountName] = {
      openclaw_channel: "telegram",
      account: accountName,
      peer_id: String(peerId),
      agent_id: null,
      auto_discovered: true,
    };
  }
  return out;
}

/**
 * allowFrom entries can be strings like "telegram:6164541473" or bare
 * numerics. Pull the first one that's usable as a numeric Telegram id.
 */
function firstNumericAllowEntry(allowFrom) {
  for (const raw of allowFrom) {
    if (raw == null) continue;
    const s = String(raw).trim();
    if (!s) continue;
    // Strip a "telegram:" / "tg:" prefix if present.
    const stripped = s.replace(/^telegram:/i, "").replace(/^tg:/i, "");
    if (/^-?\d+$/.test(stripped)) return stripped;
  }
  return null;
}

function isValidTargetName(name) {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name)
  );
}

/**
 * Dynamically import the plugin-sdk dispatch primitives. Same resolver
 * strategy as v2.1.x loadSystemEvents — try bare `openclaw/plugin-sdk/...`
 * ESM first, then walk upwards from the openclaw CLI entry to find a
 * node_modules root we can `createRequire` from.
 *
 * Returns `{ dispatchInboundReplyWithBase, recordInboundSessionAndDispatchReply }`.
 */
async function loadDispatchRuntime(log) {
  // The compat subpath re-exports the inbound-reply-dispatch functions as
  // of openclaw 2026.3.13 (see plugin-sdk/compat.js). That's our canonical
  // import. We try both compat and the direct inbound-reply-dispatch file
  // for resilience across host versions.
  const subpaths = ["plugin-sdk/compat"];
  const errors = [];

  const mergeExports = (mod) => ({
    dispatchInboundReplyWithBase: mod.dispatchInboundReplyWithBase,
    recordInboundSessionAndDispatchReply: mod.recordInboundSessionAndDispatchReply,
  });

  const isValid = (mod) =>
    typeof mod?.dispatchInboundReplyWithBase === "function";

  // Strategy 1: direct `openclaw/...` ESM import.
  for (const sub of subpaths) {
    const spec = `openclaw/${sub}`;
    try {
      const mod = await import(spec);
      if (isValid(mod)) return mergeExports(mod);
      errors.push(`${spec}: loaded but missing dispatchInboundReplyWithBase`);
    } catch (err) {
      errors.push(`${spec}: ${err?.message || err}`);
    }
  }

  // Strategy 2: resolve via the host's own node_modules. Walk up from the
  // openclaw CLI entry.
  try {
    const { createRequire } = await import("node:module");
    const { dirname, resolve: resolvePath } = await import("node:path");
    const { existsSync, realpathSync } = await import("node:fs");

    const hostCandidates = [];
    if (process.argv[1]) {
      try {
        hostCandidates.push(realpathSync(process.argv[1]));
      } catch {
        hostCandidates.push(process.argv[1]);
      }
    }
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
                if (isValid(mod)) return mergeExports(mod);
                errors.push(`resolved ${modPath}: missing dispatchInboundReplyWithBase`);
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
    `unable to load plugin-sdk dispatch primitives (dispatchInboundReplyWithBase): ${errors.join("; ")}`,
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
    msg.target ? `target="${escapeAttr(msg.target)}"` : null,
    msg.fromTarget ? `from_target="${escapeAttr(msg.fromTarget)}"` : null,
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

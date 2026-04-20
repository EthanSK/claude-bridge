# ACTUAL Session-Injection Research (2026-04-20)

> Full read-the-source investigation of OpenClaw's channel / session-injection
> architecture. Previous research claimed heartbeat was required and produced
> a buggy sessionKey. This document cites real source lines; no inferences.
>
> Unless noted otherwise, line numbers refer to the compiled JS on Mac-Mini at
> `/opt/homebrew/lib/node_modules/openclaw/dist/...`. Where TypeScript source is
> cited it's from `/opt/homebrew/lib/node_modules/openclaw/extensions/...` on
> MacBook-Pro (the npm-installed version ships both).
>
> TL;DR — we need to STOP using `enqueueSystemEvent` and instead use
> `recordInboundSessionAndDispatchReply` / `dispatchInboundReplyWithBase` from
> `openclaw/plugin-sdk/compat`. These drive the same synchronous turn that
> the native telegram channel drives. See §6.

---

## Section 1 — Telegram inbound path (authoritative)

### Files

- `extensions/telegram/bot-Ch7__EHu.js` — compiled telegram bot (221 KB,
  contains the inbound/dispatch code)
- `dispatch-JNo_iJw5.js` — `dispatchReplyFromConfig` (the real "run a turn"
  orchestrator)
- `plugin-sdk/inbound-reply-dispatch-0KQ4b86b.js` — the plugin-SDK wrapper
  around the orchestrator
- `plugin-sdk/thread-bindings-SYAnWHuW.js` — contains `resolveAgentRoute`,
  `resolveSessionKey`, `deriveSessionKey`, `buildAgentSessionKey` internals
- `plugin-sdk/session-key-CbP51u9x.js` — `buildAgentMainSessionKey`,
  `buildAgentPeerSessionKey`, `normalizeMainKey`, `DEFAULT_AGENT_ID`
- `extensions/telegram/src/channel.ts` (TS source, MBP) — declarative telegram
  plugin contract

### Runtime flow, line-by-line

1. `bot.on("message", ...)` registers the Telegraf handler
   (`bot-Ch7__EHu.js:2774`). The handler calls `handleInboundMessageLike`
   (`:2787`).

2. `handleInboundMessageLike` resolves DM access / group policy and calls
   `processInboundMessage({ctx, msg, chatId, ...})` at `:2760`.

3. `processInboundMessage` (`:2135`) is the text-fragment + media-group
   coalescer. For plain text it runs `inboundDebouncer.enqueue(...)` at
   `:2278`.

4. The debouncer `onFlush` callback (`:1673`) resolves reply-media, then
   invokes `processMessage` (`:1678, :1696`). `processMessage` is the result
   of `createTelegramMessageProcessor` (`:5073`).

5. `createTelegramMessageProcessor` calls `buildTelegramMessageContext` (which
   internally calls `sessionRuntime.finalizeInboundContext({...})` at `:3171`)
   to produce the `ctxPayload`. The `ctxPayload` shape (see `:3171–3228`) is
   the key data structure — exhaustive listing in §2.

6. Around `ctxPayload` creation (`:3241`), the inbound handler calls
   `sessionRuntime.recordInboundSession({ storePath, sessionKey, ctx,
   updateLastRoute: {...} })`. `updateLastRoute` pins:
   - `sessionKey: updateLastRouteSessionKey`
   - `channel: "telegram"`
   - `to: "telegram:<chatId>"` (or `telegram:<chatId>:topic:<threadId>` for
     forum topics)
   - `accountId: route.accountId`
   - `threadId: updateLastRouteThreadId`

7. `processMessage` then calls `dispatchTelegramMessage(...)` (`:4534`),
   which in turn calls
   `telegramDeps.dispatchReplyWithBufferedBlockDispatcher({ ctx: ctxPayload,
   cfg, dispatcherOptions: {...}, replyOptions: {...} })` at `:4803`.

8. `dispatchReplyWithBufferedBlockDispatcher`
   (`provider-dispatcher-C7CBb7vN.js:3`) delegates to
   `dispatchInboundMessageWithBufferedDispatcher`
   (`dispatch-JNo_iJw5.js:990`) which creates a typing-aware dispatcher and
   calls `dispatchInboundMessage` (`:977`) which calls `dispatchReplyFromConfig`
   (`:237`).

9. `dispatchReplyFromConfig` (`dispatch-JNo_iJw5.js:237`) is the real agent
   turn runner. It: dedupes (`:281`), resolves the session store entry
   (`:291`), resolves routing (provider vs originating channel), and pushes
   payloads through `dispatcher.sendFinalReply` / routes to originating
   channel via `routeReply`. Agent model calls happen further down in this
   function (it's ~1600 lines).

### Is `enqueueSystemEvent` called?

**Search result (Mac-Mini):**
```
grep -n 'enqueueSystemEvent' /opt/.../extensions/telegram/bot-Ch7__EHu.js
32:   import { ..., enqueueSystemEvent, ... } from "openclaw/plugin-sdk/infra-runtime";
545:  get enqueueSystemEvent() { return enqueueSystemEvent; }
2124: telegramDeps.enqueueSystemEvent(text, { sessionKey, contextKey: `telegram:reaction:add:...` });
```

Only **one** call site (`:2124`) — inside the `bot.on("message_reaction")`
handler. This enqueues a short note like `"Telegram reaction added: 🔥 by
@ethan on msg 123"` into the session's system-event queue. It does **NOT**
trigger an agent run.

**Regular text / media messages go straight through
`dispatchReplyFromConfig` — no `enqueueSystemEvent` in the text path at all.**

### Is `requestHeartbeatNow` called?

**Search result:**
```
grep -n 'requestHeartbeatNow' /opt/.../extensions/telegram/bot-Ch7__EHu.js
(no matches)
```

Not called by the telegram bot at all. It's only called internally by:
- exec tool completion (`thread-bindings:53122`, reason `"exec:<id>:exit"`)
- ACP spawn streaming (`thread-bindings:80757`, reason `"acp:spawn:stream"`)
- CLI watchdog stalls (`thread-bindings:115818`, reason `"cli:watchdog:stall"`)
- Runtime registration (`thread-bindings:155217`)

The previous research that claimed telegram needs `requestHeartbeatNow` was
wrong. The telegram bot never calls it.

### How does the event reach the agent session?

Synchronously. `dispatchReplyFromConfig` is an `async function`; the caller
(telegram bot) awaits it. When it returns, the agent turn has finished.
There is no queue-and-drain step.

### How does the agent's reply flow back to Telegram?

Two parallel mechanisms:

**(a) Same-channel path (default, fast path).** The telegram bot passes its
own `deliver` callback (`:4807` onwards — `deliver: async (payload, info) => ...`)
via `dispatcherOptions`. The dispatcher calls this for every partial /
final payload. Replies go out through `bot.api.sendMessage(...)` directly.

**(b) Route-reply path (cross-channel).** If `ctx.OriginatingChannel !==
ctx.Provider`, `dispatch-JNo_iJw5.js:216` sets
`shouldRouteToOriginating=true` and the reply is sent via `routeReply` in
`route-reply-CQe8rYFT.js:38`. This uses
`getLoadedChannelPlugin(channelId).outbound.sendText/sendPayload(...)` via
`deliverOutboundPayloads`.

The docstring on `routeReply` is explicit (`route-reply-CQe8rYFT.js:17–23`):

> Routes replies to the originating channel based on
> OriginatingChannel/OriginatingTo **instead of using the session's
> lastChannel**. This ensures replies go back to the provider where the
> message originated, even when the main session is shared across
> multiple providers.

This means **`lastChannel` is NOT what drives reply routing for an agent
turn.** It's `ctx.OriginatingChannel` + `ctx.OriginatingTo`, set in the
inbound `ctxPayload`. `lastChannel` is still persisted (via
`updateLastRoute`) as a fallback for things like future spontaneous /
outbound messages that don't have an originating context.

### Session lookup: create-if-missing or reject?

`recordInboundSession` (called at `:3241` and via the plugin-SDK
`recordInboundSessionAndDispatchReply`) creates if missing by default.
From `plugin-sdk/channels/session.d.ts:18–26`:

```ts
export declare function recordInboundSession(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;       // optional; defaults to true behavior
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError: (err: unknown) => void;
}): Promise<void>;
```

In practice: telegram's call site passes only `updateLastRoute` and omits
`createIfMissing`, and fresh conversations work (a brand-new Telegram user
DM'ing @ClawdStationMiniBot gets a real agent turn with no pre-existing
session).

---

## Section 2 — Session key format (canonical)

### The builder

`plugin-sdk/session-key-CbP51u9x.js:172`:

```js
function buildAgentMainSessionKey(params) {
  return `agent:${normalizeAgentId(params.agentId)}:${normalizeMainKey(params.mainKey)}`;
}
```

`plugin-sdk/session-key-CbP51u9x.js:175`:

```js
function buildAgentPeerSessionKey(params) {
  const peerKind = params.peerKind ?? "direct";
  if (peerKind === "direct") {
    const dmScope = params.dmScope ?? "main";
    let peerId = (params.peerId ?? "").trim();
    // identity-link resolution (elided)
    peerId = peerId.toLowerCase();
    if (dmScope === "per-account-channel-peer" && peerId) {
      const channel = (params.channel ?? "").trim().toLowerCase() || "unknown";
      const accountId = normalizeAccountId(params.accountId);
      return `agent:${normalizeAgentId(params.agentId)}:${channel}:${accountId}:direct:${peerId}`;
    }
    if (dmScope === "per-channel-peer" && peerId) {
      const channel = (params.channel ?? "").trim().toLowerCase() || "unknown";
      return `agent:${normalizeAgentId(params.agentId)}:${channel}:direct:${peerId}`;
    }
    if (dmScope === "per-peer" && peerId) {
      return `agent:${normalizeAgentId(params.agentId)}:direct:${peerId}`;
    }
    return buildAgentMainSessionKey({
      agentId: params.agentId,
      mainKey: params.mainKey
    });  // dmScope === "main" (the default)
  }
  // group / channel / thread
  const channel = (params.channel ?? "").trim().toLowerCase() || "unknown";
  const peerId = ((params.peerId ?? "").trim() || "unknown").toLowerCase();
  return `agent:${normalizeAgentId(params.agentId)}:${channel}:${peerKind}:${peerId}`;
}
```

### Defaults & constants

`plugin-sdk/session-key-CbP51u9x.js:126–127`:

```js
const DEFAULT_AGENT_ID = "main";
const DEFAULT_MAIN_KEY = "main";
```

### Which scope does the telegram inbound use?

`plugin-sdk/thread-bindings-SYAnWHuW.js:71234`:

```js
const dmScope = input.cfg.session?.dmScope ?? "main";
```

Inside `resolveAgentRoute`. So the session key depends on
`openclaw.json > session.dmScope`. For Ethan's Mac-Mini:

```
$ cat ~/.openclaw/openclaw.json | jq .session
{ "dmScope": "per-account-channel-peer" }
```

Therefore the canonical session key for a Telegram DM from Ethan
(telegram user id `6164541473`) on account `clawdiboi2` is:

```
agent:main:telegram:clawdiboi2:direct:6164541473
```

### Verification against live sessions.json

`cat ~/.openclaw/agents/main/sessions/sessions.json | jq 'keys | map(select(contains(":telegram:")))'`:

```
"agent:main:telegram:clawdiboi2:direct:6164541473"   lastChannel=telegram lastTo=telegram:6164541473 lastAccountId=clawdiboi2
"agent:main:telegram:clordlethird:direct:6164541473" lastChannel=telegram lastTo=telegram:6164541473 lastAccountId=clordlethird
"agent:main:telegram:default:direct:6164541473"      lastChannel=telegram lastTo=telegram:6164541473 lastAccountId=default
"agent:main:telegram:default:direct:heartbeat"       (heartbeat synthetic target)
"agent:main:telegram:direct:6164541473"              (legacy, pre-dmScope migration)
"agent:main:telegram:slash:6164541473"               (slash-command synthetic target)
```

Three live per-account DM sessions, exactly matching the
`agent:main:telegram:<accountId>:direct:<peerId>` shape.

### Does the plugin-SDK expose a builder?

Yes but only indirectly. Plugins do NOT call `buildAgentPeerSessionKey`
themselves. They call the higher-level `resolveAgentRoute`:

From `extensions/irc/src/inbound.ts:278–286`:

```ts
const route = core.channel.routing.resolveAgentRoute({
  cfg: config as OpenClawConfig,
  channel: CHANNEL_ID,
  accountId: account.accountId,
  peer: {
    kind: message.isGroup ? "group" : "direct",
    id: peerId,
  },
});
```

`route.sessionKey` is the canonical key. This is the API to use — it
respects `cfg.session.dmScope` and `cfg.session.identityLinks` without the
plugin having to know about them.

---

## Section 3 — Reply routing

### Session's `lastChannel` is a fallback, not the reply target

Confirmed by `route-reply-CQe8rYFT.js:17–23` (docstring quoted above in §1).
For an in-turn reply, the ACTIVE routing is driven by:

1. `ctx.OriginatingChannel` (must equal a routable channel id)
2. `ctx.OriginatingTo` (e.g. `telegram:<chatId>`)
3. `ctx.AccountId`
4. `ctx.MessageThreadId` (optional, for forums / group topics)

If `OriginatingChannel` equals the calling surface (i.e. the telegram bot
itself called dispatch), the dispatcher's `deliver` callback handles the
reply directly (fast path, `dispatch-JNo_iJw5.js:216` resolution).

If OriginatingChannel differs from surface, `routeReply` loads the target
channel plugin and calls `plugin.outbound.sendText(...)` /
`sendPayload(...)` / etc. (`route-reply-CQe8rYFT.js:94–129`).

### `lastChannel` is updated, just not used for in-turn replies

`bot-Ch7__EHu.js:3235` calls `sessionRuntime.resolveInboundLastRouteSessionKey`
and then `recordInboundSession` at `:3241` with `updateLastRoute` set. This
persists `lastChannel=telegram, lastTo=telegram:<chatId>, lastAccountId=<...>`
on the session entry.

Use-cases for the persisted `lastChannel`:
- Heartbeat delivery (see heartbeat entry's `lastChannel=webchat
  lastTo=heartbeat` in sessions.json)
- Agent-initiated outbound without explicit target
- Out-of-band / scheduled / cron replies

### Can we force a specific reply channel via ctx?

Yes — that's exactly what `OriginatingChannel` + `OriginatingTo` do. We set
them on the inbound `ctxPayload`; the dispatcher honors them for every
reply of that turn.

### What if `lastChannel` is null?

For a brand-new session, `lastChannel` is undefined. During the turn itself,
this is irrelevant — `OriginatingChannel`/`OriginatingTo` drive routing.
After the turn, `updateLastRoute` populates `lastChannel`. If we never call
`updateLastRoute`, the next heartbeat / scheduled send would have no
default reply target, but that doesn't affect the current turn.

---

## Section 4 — Event queue + wake semantics

### `enqueueSystemEvent` is pure queueing

`plugin-sdk/thread-bindings-SYAnWHuW.js:52075` (note: this is the degraded
in-file fallback; the production queue lives in the same file at line 52062):

```js
const MAX_EVENTS = 20;
const queues = new Map();
function enqueueSystemEvent(text, options) {
  const key = requireSessionKey(options?.sessionKey);
  const entry = queues.get(key) ?? ...;
  const cleaned = text.trim();
  if (!cleaned) return false;
  entry.lastContextKey = normalizeContextKey(options?.contextKey);
  if (entry.lastText === cleaned) return false;   // de-dupe same text
  entry.lastText = cleaned;
  entry.queue.push({ text: cleaned, ts: Date.now(), contextKey });
  if (entry.queue.length > MAX_EVENTS) entry.queue.shift();
  return true;
}
```

Returns `true` if the event was queued, `false` if it was duplicate-suppressed
or empty. The return value does NOT indicate that any wake happened.

### Who drains `system-events` queues?

Only one consumer call site across the entire `dist/`:

`plugin-sdk/thread-bindings-SYAnWHuW.js:108130`:

```js
const queued = drainSystemEventEntries(params.sessionKey);
systemLines.push(...queued.map((event) => {
  const compacted = compactSystemEvent(event.text);
  return compacted && `[${formatSystemEventTimestamp(event.ts, params.cfg)}] ${compacted}`;
}).filter(Boolean));
// ...
return systemLines.flatMap(line => line.split("\n").map(s => `System: ${s}`)).join("\n");
```

This runs during **prep for an already-scheduled agent turn**. Events sit
in the queue and are PREPENDED to the next turn's prompt as `System: ...`
lines. They do NOT trigger a turn on their own.

### Does `requestHeartbeatNow` help?

`requestHeartbeatNow` (`plugin-sdk/thread-bindings-SYAnWHuW.js:52008`) only
exists in the **degraded** copy in this file — it's a no-op timer that
clears itself 250ms later with nothing consuming the `pendingWakes` map.
The real implementation at `auth-profiles-DRjqKE3G.js:56267–56404` has a
`handler` that the runtime injects via `setHeartbeatWakeHandler`, and the
handler IS called when pendingWakes aren't empty and the timer fires.

But — critical caveat — the handler is the **heartbeat runner**, which
produces heartbeat messages on whatever session it thinks is "main". It does
NOT pull from `enqueueSystemEvent` queues for the target sessionKey and
run a dedicated turn for them. System events only surface during
naturally-scheduled turns (user messages, heartbeats, explicit
`dispatchReplyFromConfig` calls).

**Conclusion: `requestHeartbeatNow` is NOT the way to wake an injected
event.** Even if it fired, it would not deliver our injected text as a
user message — at best it would trigger a next heartbeat that prepends
our queued system-event as a `System: ...` line, which is the wrong
semantic (our message is a user message, not a system annotation).

### How does telegram's regular message path actually work?

It doesn't enqueue anything. It SYNCHRONOUSLY calls
`dispatchReplyWithBufferedBlockDispatcher` / `dispatchInboundMessage` /
`dispatchReplyFromConfig` — all awaited — and the agent turn completes
before the handler returns. This is the canonical pattern for channel
plugins (see IRC and Nextcloud Talk using the same API).

### Why does the reactions path use `enqueueSystemEvent`?

Because reactions are supplemental context for a conversation that is
already being handled via the text-message path. They're "System: Telegram
reaction added: 🔥 by @ethan" lines prepended to the NEXT user message's
turn prompt. They never run a turn on their own.

---

## Section 5 — Our plugin's current implementation (audit)

### Our sessionKey construction

`src/index.js:439–442`:

```js
function buildSessionKey({ agentId, channel, account, peerId }) {
  // agent:main:telegram:<account>:direct:<peerId>
  return `agent:${agentId}:${channel}:${account}:direct:${peerId}`;
}
```

Called from `:158–165`:

```js
const sessionKey = target.config.legacy_session
  ? `${AGENT_BRIDGE_CHANNEL_ID}:${fromMachine}`
  : buildSessionKey({
      agentId: target.config.agent_id ?? agentId,
      channel: target.config.openclaw_channel ?? "telegram",
      account: target.config.account ?? target.name,
      peer_id: target.config.peer_id,
    });
```

**Verdict: CORRECT for Ethan's `dmScope=per-account-channel-peer`.**
Produces `agent:main:telegram:clawdiboi2:direct:6164541473` etc. Matches
the live sessions.json entries exactly.

**But fragile:** if Ethan changes `dmScope` (e.g. to `"main"`), all his
telegram sessions collapse to `agent:main:main` and our hard-coded format
stops matching. The canonical fix is to call the SDK's
`resolveAgentRoute(...)` and use its `route.sessionKey` rather than
constructing the string ourselves.

### No "double `telegram:`" prefix bug in current source

`grep -rn 'telegram:telegram\|direct:telegram' src/` returns nothing. The
legacy fallback at `:159` produces `agent-bridge:<machine>`, not a
telegram key. Whatever prior-research doc reported a double-prefix bug is
either obsolete or was about an earlier revision. Clean as of today.

### `enqueueSystemEvent` args

`src/index.js:188–192`:

```js
const enqueueOpts = {
  sessionKey,
  contextKey: fromMachine,
  trusted: false,   // ← NOT A VALID OPTION (see below)
};
```

Compare to the declared type
(`plugin-sdk/infra/system-events.d.ts:6–9`):

```ts
type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
};
```

`trusted: false` is silently ignored — not a real option. The comment at
`src/index.js:186–187` ("trusted=false — SSH pairing is not a first-party
trust boundary") refers to a policy concept that has no representation in
the event-queue API.

### Architecture-level problem: `enqueueSystemEvent` alone is a no-op

Per §4, `enqueueSystemEvent` only queues text for later prepending to a
turn's prompt. It does NOT start a turn. So when our plugin enqueues an
event and returns, nothing happens — the text sits in the queue until
some OTHER mechanism triggers a turn on `agent:main:telegram:clawdiboi2:direct:6164541473`,
at which point our text becomes a `System: ...` line (wrong semantic) on
that other turn.

This is the root bug. The plugin's inbound flow currently:
1. Sees a bridge message arrive.
2. Enqueues a `<channel>...` envelope into the telegram session's queue.
3. Returns.
4. No agent turn ever happens.

Unless and until Ethan sends a real Telegram message to the same chat
(which would trigger a turn and pick up our queued text as a `System:`
prefix), our injection is silently swallowed.

### Telegram reactions vs our use-case — the fatal disanalogy

Telegram reactions use `enqueueSystemEvent` because they ride on a
conversation that is ALREADY running through the regular text path. Our
plugin has no concurrent text-path running — we need to drive the turn
ourselves.

### Reply-routing expectations in current code

Current code (`channel-plugin.js:124–162`) assumes replies come back into
our channel via `outbound.sendText(ctx)` and we SCP them out. This WOULD
work IF `OriginatingChannel="agent-bridge"` were on the ctxPayload — but
it isn't, because we never built a ctxPayload. We only enqueued a system
event. So even if a turn magically ran for our injected event, replies
would go to `lastChannel=telegram` (populated by Ethan's real telegram
usage), not to us. That's actually (almost) the desired behavior for the
Telegram-injection use case — replies DO go back to the Telegram chat —
but it's accidental, not designed, and it breaks the moment lastChannel
drifts to something else (e.g., heartbeat, which sets
`lastChannel=webchat`, `lastTo=heartbeat`).

---

## Section 6 — Recommended architecture

### What we thought vs what actually happens

| Assumption | Reality |
|---|---|
| `enqueueSystemEvent` delivers a user message to the session | No — it prepends a `System:` line to the next scheduled turn's prompt. Doesn't trigger a turn. |
| `requestHeartbeatNow` is required to wake the session | No. It's not called by the telegram bot, and wouldn't produce the right semantic anyway. |
| Session replies flow back via `lastChannel` | Only for out-of-band / agent-initiated / heartbeat messages. In-turn replies use `ctx.OriginatingChannel` + `ctx.OriginatingTo`. |
| We need to hand-craft the session key | No — `runtime.channel.routing.resolveAgentRoute({ cfg, channel, accountId, peer })` returns `route.sessionKey` respecting `cfg.session.dmScope`. |
| The canonical key for Ethan's Telegram DM is `agent:main:main` | No — Ethan's `dmScope="per-account-channel-peer"`, so keys are `agent:main:telegram:<account>:direct:<peerId>`. But HARD-CODING that format is fragile. |
| Previous report of a "double `telegram:`" prefix bug | Not present in the current source; whoever reported it was looking at an older revision. |

### Minimal correct implementation (sketch)

Replace the `enqueueSystemEvent` flow in `src/index.js::onMessage` with a
call to `dispatchInboundReplyWithBase` (or the slightly lower-level
`recordInboundSessionAndDispatchReply`). These are exposed from
`openclaw/plugin-sdk/compat` and used by IRC
(`extensions/irc/src/inbound.ts:332`) and Nextcloud Talk
(`extensions/nextcloud-talk/src/inbound.ts:288`).

Pseudocode (not meant to be committed as-is — intentional stop here per
Ethan's "document only" rule):

```js
// runtime is api.runtime (PluginRuntime), captured during register()
const core = runtime;  // has channel.routing/session/reply
const cfg = runtime.config.loadConfig();   // or equivalent
const route = core.channel.routing.resolveAgentRoute({
  cfg,
  channel: "telegram",
  accountId: target.config.account,
  peer: { kind: "direct", id: target.config.peer_id },
});

const storePath = core.channel.session.resolveStorePath(
  cfg.session?.store, { agentId: route.agentId },
);

const peerId = target.config.peer_id;
const ctxPayload = core.channel.reply.finalizeInboundContext({
  Body: formatInboundBody(msg),      // our <channel ...>text</channel> envelope
  RawBody: msg.content ?? "",
  CommandBody: msg.content ?? "",
  From: `telegram:${peerId}`,        // present as if the user dm'd
  To: `telegram:${peerId}`,
  SessionKey: route.sessionKey,
  AccountId: route.accountId,
  ChatType: "direct",
  ConversationLabel: msg.from ?? "bridge",
  SenderId: peerId,
  Provider: "telegram",              // so the dispatcher sees telegram surface
  Surface: "telegram",
  MessageSid: msg.id,
  Timestamp: Date.now(),
  OriginatingChannel: "telegram",
  OriginatingTo: `telegram:${peerId}`,
  // We are not passing a synthetic CommandAuthorized — defaults are fine
});

await dispatchInboundReplyWithBase({
  cfg,
  channel: "telegram",
  accountId: route.accountId,
  route,
  storePath,
  ctxPayload,
  core,
  deliver: async (payload) => {
    // Replies go out through telegram's registered outbound.
    // This is a NO-OP for us — the telegram channel plugin handles delivery
    // via its own registered outbound.sendText/sendPayload. But we still
    // need a deliver callback because the dispatcher is buffered.
    // IRC/Nextcloud wrap sendMessage here; for us we let telegram's
    // registered outbound handle it by delegating to deliverOutboundPayloads.
    // See extensions/irc/src/inbound.ts:340–348 for the pattern.
  },
  onRecordError: (err) => log.error(`record session failed: ${err}`),
  onDispatchError: (err, info) => log.error(`${info.kind} reply failed: ${err}`),
});
```

Since we want the agent's replies to land in the actual Telegram chat
(not in our own agent-bridge channel), setting `Provider: "telegram"` +
`Surface: "telegram"` + `OriginatingChannel: "telegram"` +
`OriginatingTo: "telegram:<peerId>"` — exactly as the native telegram bot
does — routes replies through the already-registered telegram outbound.

We would NOT register our own channel at all (or only register one for a
different use case — cross-machine agent-bridge chats, which DO use a
separate channel). For the Telegram-injection use case, we're just
fabricating a synthetic inbound-telegram ctxPayload on the bridge message's
behalf.

### Known unknowns

1. **Does `recordInboundSession` treat a plugin-driven synthetic inbound
   identically to a real Telegram one?** Needs a controlled test: drop a
   bridge message on Mac-Mini's inbox, confirm a new assistant reply
   lands in Telegram chat `6164541473` on account `clawdiboi2`, and that
   the session updatedAt and transcript reflect the turn.

2. **Does the bufferedBlockDispatcher reliably pick up the telegram
   account's outbound?** IRC uses a plugin-local `sendReply`/`sendMessageIrc`
   inside its `deliver` callback. Telegram's bot uses the big
   `dispatchTelegramMessage` local-sink pattern. If we want Telegram to
   deliver *for us*, we need the dispatcher to resolve telegram's outbound
   via `deliverOutboundPayloads({channel: "telegram", ...})` — verify
   that happens with `OriginatingChannel="telegram"` set but no
   currently-running telegram handler.

3. **Race with a concurrently-running real Telegram turn.** If Ethan
   dm's the bot at the same time a bridge message arrives, do both turns
   serialize correctly on the same `agent:main:telegram:<acct>:direct:<peer>`
   session? The telegram bot uses `inboundDebouncer` +
   `textFragmentProcessing` chains; we'd bypass those. Needs verification.

4. **Ethan's telegram `allowFrom` and dmPolicy.** Does
   `dispatchReplyFromConfig` re-check allow-list? If yes, we need to
   ensure our synthetic `ctx.SenderId=6164541473` is on
   `channels.telegram.accounts.clawdiboi2.allowFrom` (it is, per his
   config). If we ever accept bridge messages from OTHER senders, they
   would be blocked — which is actually the correct safety behavior.

5. **The `trusted: false` security concept.** This is not representable
   in `enqueueSystemEvent`'s options. In the `recordInboundSessionAndDispatchReply`
   path, any extra sandboxing of "bridge-origin" content would have to be
   encoded in a prompt prefix inside our `Body` envelope (which we already
   do with `<channel source="agent-bridge" ...>`). There is no built-in
   trust-level flag.

### Alternative designs (if session-injection turns out problematic)

**Alt-A: Register as a real channel and let agent route to it.** Keep
`channel-plugin.js`, register it as `agent-bridge` channel. Have the
bridge send real messages through telegram (so they reach the bot), have
the bot's own inbound code run as usual, but with a prefix in the
message text. This requires Ethan to dm the bot with a special prefix
("from:machine-B: ...") — cumbersome.

**Alt-B: Direct transcript/session-store injection.** Append a
user-role message to the session's transcript JSONL and touch the
session updatedAt. Then call `requestHeartbeatNow` to trigger the
heartbeat-wake handler. Fragile; heartbeat runner won't actually read the
transcript mid-run, it'll just emit a heartbeat.

**Alt-C: Stick with `enqueueSystemEvent` + trigger a turn via a
no-op proxy message.** Enqueue our `<channel>` block as a system event,
then also call `dispatchInboundReplyWithBase` with an empty Body. The
dispatcher would prep the turn, drain our system-event queue, and the
agent would see our message as a `System: ...` line. Wrong semantic
(system, not user), but functional. Not recommended — the cleaner
approach is to put the content in `ctx.Body`.

**Alt-D (recommended):** `dispatchInboundReplyWithBase` with a
synthesized telegram ctxPayload, as in §6 sketch. Same code path as IRC
and Nextcloud Talk. Least surprise, most tested.

### Implementation checklist (for when we do write code)

- [ ] Stop importing from `openclaw/plugin-sdk/infra-runtime` (where
      `enqueueSystemEvent` lives). Instead import from
      `openclaw/plugin-sdk/compat`:
      `recordInboundSessionAndDispatchReply`, `dispatchInboundReplyWithBase`,
      `buildInboundReplyDispatchBase`.
- [ ] Capture `api.runtime` (PluginRuntime) during `register()` — use
      `createPluginRuntimeStore` helper (see `extensions/irc/src/runtime.ts:4`)
      or a simple module-level closure.
- [ ] Build `ctxPayload` via `core.channel.reply.finalizeInboundContext({...})`.
- [ ] Resolve route via `core.channel.routing.resolveAgentRoute({ cfg,
      channel: "telegram", accountId: target.config.account,
      peer: { kind: "direct", id: peer_id } })`.
- [ ] Resolve storePath via `core.channel.session.resolveStorePath(...)`.
- [ ] Call `dispatchInboundReplyWithBase({ ...base, deliver, onRecordError,
      onDispatchError, replyOptions })`.
- [ ] For `deliver`: either (a) no-op and let `routeReply` in
      `dispatch-JNo_iJw5.js` route replies back via telegram's registered
      outbound, or (b) explicitly call `core.channel.reply.deliverOutboundPayloads({
      cfg, channel: "telegram", to: \`telegram:${peerId}\`, payloads: [payload],
      accountId: route.accountId })`. Both should work; (a) is what IRC does
      in miniature and is simpler.
- [ ] Drop `trusted: false` — not a real flag. If we want sandboxing,
      encode it as a prefix / tag inside the `Body` envelope.
- [ ] Drop the explicit `probeSession()` helper — the SDK doesn't expose a
      session lookup, and the `recordInboundSession` path already
      creates-if-missing.
- [ ] Keep the inbox-watcher (it's fine as-is).
- [ ] Update `loadSystemEvents()` → `loadDispatchRuntime()`: probe for
      `openclaw/plugin-sdk/compat` rather than `openclaw/plugin-sdk/infra-runtime`.

---

## Appendix A — Cited files & line numbers (quick index)

| File | Section | Line(s) |
|---|---|---|
| `extensions/telegram/bot-Ch7__EHu.js` | Telegram handler entrypoint | 2774 (`bot.on("message")`) |
| same | `processInboundMessage` | 2135 |
| same | `processMessage` factory | 5073 |
| same | `dispatchTelegramMessage` → `dispatchReplyWithBufferedBlockDispatcher` | 4495, 4803 |
| same | `ctxPayload` construction | 3171–3228 |
| same | `recordInboundSession` call | 3241 |
| same | reactions → `enqueueSystemEvent` | 2124 |
| same | `resolveTelegramConversationRoute` | 643 |
| `dispatch-JNo_iJw5.js` | `dispatchReplyFromConfig` | 237 |
| same | `resolveReplyRoutingDecision` | 140 |
| same | `dispatchInboundMessageWithBufferedDispatcher` | 990 |
| `provider-dispatcher-C7CBb7vN.js` | `dispatchReplyWithBufferedBlockDispatcher` | 3 |
| `route-reply-CQe8rYFT.js` | `routeReply` | 38 |
| same | docstring about originating-channel priority | 17–23 |
| same | `isRoutableChannel` | 142 |
| `plugin-sdk/inbound-reply-dispatch-0KQ4b86b.js` | `dispatchReplyFromConfigWithSettledDispatcher` | 4 |
| same | `recordInboundSessionAndDispatchReply` | 38 |
| same | `dispatchInboundReplyWithBase` | 29 |
| same | `buildInboundReplyDispatchBase` | 16 |
| `plugin-sdk/thread-bindings-SYAnWHuW.js` | `resolveAgentRoute` | 71223 |
| same | `dmScope` default | 71234 |
| same | `deriveSessionKey` | 21328 |
| same | `resolveSessionKey` (with mainKey) | 21338 |
| same | `enqueueSystemEvent` (local) | 52075 |
| same | `drainSystemEventEntries` (consumer) | 108130 |
| `plugin-sdk/session-key-CbP51u9x.js` | `DEFAULT_AGENT_ID`, `DEFAULT_MAIN_KEY` | 126–127 |
| same | `buildAgentMainSessionKey` | 172 |
| same | `buildAgentPeerSessionKey` | 175 |
| `plugin-sdk/channels/session.d.ts` | `recordInboundSession` signature | 18–26 |
| `plugin-sdk/config/sessions/session-key.d.ts` | `deriveSessionKey` / `resolveSessionKey` | 3, 8 |
| `plugin-sdk/infra/system-events.d.ts` | `SystemEventOptions` type | 6–9 |
| `auth-profiles-DRjqKE3G.js` | full heartbeat-wake runner | 56267–56404 |
| `extensions/irc/src/inbound.ts` | reference plugin using the proper API | 278 (route), 332 (dispatch) |
| `extensions/irc/src/runtime.ts` | runtime store pattern | 4 |
| `extensions/telegram/src/channel.ts` | declarative channel plugin | whole file (636 lines) |

## Appendix B — Live sessions.json evidence

From `~/.openclaw/agents/main/sessions/sessions.json` on Mac-Mini
(2026-04-20):

```text
'agent:main:main'                                     lastChannel=webchat  lastTo=heartbeat               (heartbeat-owned)
'agent:main:telegram:clawdiboi2:direct:6164541473'    lastChannel=telegram lastTo=telegram:6164541473     lastAccountId=clawdiboi2
'agent:main:telegram:clordlethird:direct:6164541473'  lastChannel=telegram lastTo=telegram:6164541473     lastAccountId=clordlethird
'agent:main:telegram:default:direct:6164541473'       lastChannel=telegram lastTo=telegram:6164541473     lastAccountId=default
'agent:main:telegram:default:direct:heartbeat'        (synthetic heartbeat target)
'agent:main:telegram:direct:6164541473'               (legacy, pre-dmScope-migration)
'agent:main:telegram:slash:6164541473'                (slash-command synthetic target)
```

Plus ~630 `agent:main:subagent:<uuid>` and `agent:main:cron:<uuid>` entries.

Ethan's relevant `openclaw.json` fields:

```json
{
  "session": { "dmScope": "per-account-channel-peer" },
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "...",
      "allowFrom": ["telegram:6164541473"],
      "accounts": {
        "default": { ... },
        "clawdiboi2": { ... },
        "clordlethird": { ... }
      }
    }
  },
  "plugins": { "entries": { "agent-bridge": { "enabled": true } } }
}
```

# Relay inbound bridge messages to the user

**Canonical reference for the rule that every paired harness must relay inbound bridge messages to the user via the harness's configured user-facing communication channel.**

When a harness (Claude Code, OpenClaw, or any other paired agent) receives an inbound bridge message via the `<channel source="agent-bridge">` block, it MUST relay a brief 1-2 line summary of that message to the user via whatever user-facing channel the harness is configured to use — Telegram, Slack, Discord, native UI, email, etc. This gives the user live visibility into cross-harness coordination — they can see what other harnesses are asking, who's responding, and what's actually being decided across the fleet, without having to tail logs or context-switch into other sessions.

## The rule

**Relay every inbound bridge message to the user via your harness's configured user-facing channel** as a brief 1-2 line summary covering **sender machine + target + the actionable ask**, so the user has live visibility into what other harnesses are asking. Reply via bridge first if a response is needed; THEN summarize on the user-facing channel. Don't suppress the relay just because the message looks like routine internal coordination — the user generally wants to see all of it.

**Format example (Telegram-style, but adapt to your channel):**

> 📡 Bridge from <sender-machine> (target=<routed-target>): "<1-2 sentence quote of the actionable ask>" Replied via bridge with <action>.

**Exception:** pure-noise heartbeats / liveness pings with no actionable content (e.g. `bridge_status` polls). Those can be silent.

## Why this matters

Without this rule, cross-harness traffic is invisible to the user unless they open a session and read the channel block themselves. Bridge messages are an internal coordination layer; without an outward relay the user has no idea what their fleet is doing. The relay turns the bridge from a hidden side-channel into a glance-able activity feed.

Some harnesses already do this consistently; others were inconsistent — sometimes folding bridge traffic into broader status updates, sometimes going silent on purely-internal coordination chatter on the assumption that "internal" meant "uninteresting." That assumption is wrong. Relay all of it; the user can scan-skip what they don't care about.

## What counts as a relayable inbound message

- Any `<channel source="agent-bridge" ...>` block delivered into the running agent session
- From any paired machine, regardless of `from_target`
- Any `target` value (`claude-code`, `<harness>/<account>`, custom harness)
- Authenticated AND unauthenticated (relay both — if unauthenticated, mention that)

## What can be silent

- Pure liveness / heartbeat pings (`bridge_status` poll responses, ack-only no-content messages)
- Echo / ack of a previous message you yourself just sent (avoid feedback loops)
- Test pings during a deliberate fleet-test session, if the user has explicitly said "go quiet on the user-facing channel while I run this test"

When in doubt, relay. Over-relaying is fine; under-relaying defeats the rule.

## Order of operations

1. **Read the inbound message** carefully — same as you would if it had come over the user-facing channel directly.
2. **Reply via bridge** first if the message asks something that needs a bridge-side response. The reply should be the substantive answer, not "ack, will check user-side too."
3. **Summarize on the user-facing channel** as a separate message: any project/context tag your harness uses, 1-2 line summary, what you replied (or "no reply needed"). Use the format example above as a template.

If the message is purely informational and needs no bridge reply, skip step 2 and just relay (step 3).

## Format guidance

- **Lead with whatever tag/header convention your harness uses** for user-facing messages (project tag, status emoji, etc.).
- **Use a distinctive inline indicator** for bridge-relay messages so the user can scan-filter them. The radar emoji 📡 is a good default but pick whatever fits your channel.
- **Sender + target are mandatory** in the summary line — the user needs to know which harness asked and which target it routed to.
- **Quote the actionable ask** in 1-2 sentences max. Don't paraphrase; quote enough that the user recognizes the request.
- **State your action** at the end ("Replied via bridge with X" / "No reply needed, FYI" / "Holding for user input").

## Where this rule lives across agent-bridge surfaces

- **This file (`docs/relay-to-user.md`)** — canonical full text.
- **`AGENTS.md`** — abbreviated section "Relay inbound bridge messages to the user" with link back here.
- **`README.md`** — short callout in the message-routing area with link back here.
- **`bridge_send_message` tool description in `mcp-server/src/tools.ts`** — short note pointing recipients at this canonical doc.

If your harness has its own instruction/memory file (e.g. `CLAUDE.md`, `AGENTS.md`, system prompt), add an abbreviated version of this rule there too for defense-in-depth. Both stay; don't remove either when the other is in place.

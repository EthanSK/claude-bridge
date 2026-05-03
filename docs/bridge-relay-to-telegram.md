# Bridge message relay to Ethan via Telegram

**Canonical reference for the rule that every paired harness must relay inbound bridge messages to Ethan via Telegram.**

When a harness (Claude Code, OpenClaw, or any other paired agent) receives an inbound bridge message via the `<channel source="agent-bridge">` block, it MUST relay a brief 1-2 line summary of that message to Ethan over Telegram. This gives Ethan live visibility into cross-harness coordination from his phone — he can see what other harnesses are asking, who's responding, and what's actually being decided across his fleet, without having to tail logs or context-switch into other sessions.

## The rule

**Relay every inbound bridge message to Ethan via Telegram** as a brief 1-2 line summary (sender machine + target + the actionable ask), so Ethan has live visibility into what other harnesses are asking. Reply via bridge first if a response is needed; THEN summarize on Telegram. Don't suppress the relay just because the message looks like routine internal coordination — Ethan wants to see all of it.

**Format example:**

> 📡 Bridge from MBP-Claude (target=claude-code): "Diagnostic — please check OC xhigh thinking on Mini..." Replied via bridge with findings.

**Exception:** pure-noise heartbeats / liveness pings with no actionable content (e.g. `bridge_status` polls). Those can be silent.

Established 2026-05-03 (Ethan voice 6181 + 6186, applies to all paired harnesses).

## Why this matters

Without this rule, cross-harness traffic is invisible to Ethan unless he opens a session and reads the channel block himself. OpenClaw already does this correctly. Claude Code (Mini and MBP) was inconsistent — sometimes folding bridge traffic into broader status updates, sometimes going silent on purely-internal coordination chatter (like MBP xhigh diagnostics) on the assumption that "internal" meant "uninteresting." Ethan's voice 6181 ask: *"Do you have in your instructions to relay any agent-bridge messages you get to Telegram? OpenClaw does correctly. I want to know if Claude Code does that."* — confirms he wants ALL of it, not a curated subset.

Ethan voice 6186: *"this rule should live in agent-bridge docs (so it travels with the plugin and shows up in setup instructions for any harness installing agent-bridge)."* That's why the canonical lives here, not just in `~/.claude/CLAUDE.md`. Mini's CLAUDE.md still carries an abbreviated version for defense-in-depth — both stay.

## What counts as a relayable inbound message

- Any `<channel source="agent-bridge" ...>` block delivered into the running agent session
- From any paired machine, regardless of `from_target`
- Any `target` value (`claude-code`, `openclaw/<account>`, custom harness)
- Authenticated AND unauthenticated (relay both — if unauthenticated, mention that)

## What can be silent

- Pure liveness / heartbeat pings (`bridge_status` poll responses, ack-only no-content messages)
- Echo / ack of a previous message you yourself just sent (avoid feedback loops)
- Test pings during a deliberate fleet-test session if Ethan has explicitly said "go quiet on Telegram while I run this test"

When in doubt, relay. Over-relaying is fine; under-relaying defeats the rule.

## Order of operations

1. **Read the inbound message** carefully — same as you would if it had come over Telegram directly.
2. **Reply via bridge** first if the message asks something that needs a bridge-side response. The reply should be the substantive answer, not "ack, will check Telegram-side too."
3. **Summarize on Telegram** as a separate message: project tag, 1-2 line summary, what you replied (or "no reply needed"). Use the format example above as a template.

If the message is purely informational and needs no bridge reply, skip step 2 and just relay (step 3).

## Format guidance

- **Always lead with the project tag** per the standard Telegram reply format (`[<projects>]`).
- **Use the radar emoji 📡** as the inline indicator for bridge-relay messages so Ethan can scan-filter them in his chat list.
- **Sender + target** are mandatory in the summary line — Ethan needs to know which harness asked and which target it routed to.
- **Quote the actionable ask** in 1-2 sentences max. Don't paraphrase; quote enough that Ethan recognizes the request.
- **State your action** at the end ("Replied via bridge with X" / "No reply needed, FYI" / "Holding for Ethan input").

## Where this rule lives across agent-bridge surfaces

- **This file (`docs/bridge-relay-to-telegram.md`)** — canonical full text.
- **`AGENTS.md`** — abbreviated section "Bridge message relay to Ethan" with link back here.
- **`README.md`** — short callout in the "Common usage" / message-routing area with link back here.
- **`bridge_send_message` tool description in `mcp-server/src/tools.ts`** — 4-6 line note pointing recipients at this canonical doc.

## Where this rule also lives outside agent-bridge

- **`~/.claude/CLAUDE.md`** on Mini (and any other Claude Code harness) — abbreviated bullet under "Telegram reply rules" for defense-in-depth. dot-claude carries the rule for any Claude Code session regardless of agent-bridge install state; agent-bridge carries it for any new harness / fleet machine that picks up the plugin without a dot-claude sync.

Both stay. Don't remove either when the other is in place.

# OC persona routing

**Canonical reference for mapping spoken / written OpenClaw persona names to `bridge_send_message` `target` values.**

When the user names an OpenClaw persona, route to the matching target literally. **Never** default to `openclaw/default` when a specific persona was named — that's a routing bug, not a fallback.

## Persona → target map

| Spoken / written name(s)                                                                      | `target`                  |
|-----------------------------------------------------------------------------------------------|---------------------------|
| `Claude the third` / `Claude III` / `Clord` / `clordlethird` / `Clord Le Third`               | `openclaw/clordlethird`   |
| `Claudibo` / `Clawdiboi2` / `Claudibo2` / `Claude two` / `Claude II`                          | `openclaw/clawdiboi2`     |
| `Claude Station Mini` / `Clawdmini` / `default` / unspecified                                 | `openclaw/default`        |

Add more rows as new OpenClaw Telegram accounts are provisioned (each `channels.telegram.accounts.<name>` in `~/.openclaw/openclaw.json` becomes its own routing target).

## Routing rule

When the user names ANY persona above (or a clear voice-transcribed variant), match LITERALLY before falling back to `openclaw/default`. Re-read the source twice if a persona name is involved.

**Voice transcripts are noisy on persona names.** AssemblyAI and Deepgram both regularly mis-hear:

- `Claude the third` → `"Cloward third"`, `"Cloud the third"`, `"clouded third"`, `"Crowd the third"`
- `Claudibo` → `"Cloudy boy"`, `"Cloudy bot"`, `"Cloudy bow"`, `"Claude E. Bo"`
- `Clord` → `"Chord"`, `"Cord"`, `"Lord"`, `"Clawed"`
- `Open Claw` → `"Open Core"`, `"Open Crawl"`, `"OpenClaw"` (one word), `"Open Claude"`

If a voice note seems ambiguous, prefer the explicit-persona reading over the default. Ask Ethan to confirm if the transcript is genuinely unparseable.

## Why this matters

OpenClaw runs **multiple parallel Telegram bot accounts** on the same machine, each with its own running agent session, persona, system prompt, and chat history. Routing a directive intended for "Claude the third" to `openclaw/default` injects it into the wrong session — the message lands in the wrong chat, the wrong agent answers, and the named persona never sees the work. Cross-persona contamination is hard to debug after the fact because the wrong session does respond, just incorrectly.

## Background — the routing-mistake incident

Established 2026-05-03 after Mini-Claude received a `[ETHAN-AUTHED]` directive over Agent Bridge — paraphrased: *"have Claude the third do X"* — and routed it to `openclaw/default` instead of `openclaw/clordlethird`. The directive came from voice 6172 via the Mac-Mini OpenClaw harness; the persona name was unambiguous in the transcript ("Claude the third") but Mini-Claude defaulted to `openclaw/default` because it hadn't been instructed on the persona-name → target mapping.

Ethan voice 6176: *"this routing rule should be in agent bridge. It shouldn't just be patched in Mini's CLAUDE.md — agent-bridge should have these instructions so that we set it up properly in the future."*

This file is the canonical home for the rule. Other agent-bridge surfaces (the `bridge_send_message` tool description, AGENTS.md, README) carry abbreviated pointers back here.

## Examples

**Correct:**

```
User: "Tell Claude the third to review the PR."
→ bridge_send_message({ target: "openclaw/clordlethird", ... })
```

```
User: "Ask Claudibo what it thinks of this design."
→ bridge_send_message({ target: "openclaw/clawdiboi2", ... })
```

```
User: "Sync with the other Claude on Mac-Mini."  (no persona named)
→ bridge_send_message({ target: "openclaw/default", ... })   // OK to default
```

**Incorrect:**

```
User voice transcript: "Have cloward third take a look."  (mis-heard "Claude the third")
→ Wrong: target: "openclaw/default"
→ Right: target: "openclaw/clordlethird"   // re-read transcript, match persona despite the mis-hearing
```

```
User: "Get Clord on it."
→ Wrong: target: "openclaw/default"   // Clord is a recognised alias
→ Right: target: "openclaw/clordlethird"
```

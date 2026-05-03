# Named target routing

**Canonical reference for matching user-named target aliases to `bridge_send_message` `target` values.**

When the user names a specific target by alias — a persona, a session, a bot account, a per-account channel, or any other named subdivision of a harness — route to the matching `target` literally. **Never** silently default to the generic catch-all (e.g. `<harness>/default`) when a specific alias was named — that's a routing bug, not a fallback.

## The principle

When the user names ANY target alias by its spoken/written name, match LITERALLY before falling back to a default. This applies regardless of whether the alias was typed or transcribed from a voice note.

**Re-read the source twice if a specific name was mentioned.** Voice transcripts are noisy and proper-noun aliases get mis-heard often — short, distinctive aliases (`Clord`, `Boi2`, `Echo`, single-syllable handles) are particularly prone to mis-hearing. If a transcript looks ambiguous, prefer the explicit-alias reading over the generic default.

## Format

Each harness defines its own target namespace. The convention agent-bridge expects is `<harness>/<account-alias>`:

| Spoken / written name(s)                              | `target`                          |
|-------------------------------------------------------|-----------------------------------|
| `Bot Alpha` / `bot-alpha` / `alpha`                   | `<harness>/bot-alpha`             |
| `Bot Beta` / `bot-beta` / `beta`                      | `<harness>/bot-beta`              |
| `<harness> default` / `default` / unspecified         | `<harness>/default`               |

Add rows as new accounts/aliases are provisioned in your harness config. Every entry under your harness's account list (e.g. `channels.telegram.accounts.<name>` for OpenClaw, or any equivalent multi-session config in another harness) becomes its own routing target.

## Why this matters

Many harnesses run **multiple parallel sessions** on the same machine — one per persona, account, or channel — each with its own running agent, system prompt, and chat history. Routing a directive intended for `bot-alpha` to `<harness>/default` injects it into the wrong session. The message lands in the wrong chat, the wrong agent answers, and the named target never sees the work. Cross-session contamination is hard to debug after the fact because the wrong session does respond, just incorrectly.

## Examples

**Correct:**

```
User: "Tell Bot Alpha to review the PR."
→ bridge_send_message({ target: "<harness>/bot-alpha", ... })
```

```
User: "Ask Bot Beta what it thinks of this design."
→ bridge_send_message({ target: "<harness>/bot-beta", ... })
```

```
User: "Sync with the other agent on <machine>."   // no alias named
→ bridge_send_message({ target: "<harness>/default", ... })   // OK to default
```

**Incorrect:**

```
User voice transcript: "Have <mis-heard-alias> take a look."
  (transcript noise from a real alias the harness has registered)
→ Wrong: target: "<harness>/default"
→ Right: target: "<harness>/<correct-alias>"   // re-read transcript, match the named alias despite the mis-hearing
```

```
User: "Get <short-alias> on it."
→ Wrong: target: "<harness>/default"   // <short-alias> is a recognised alias
→ Right: target: "<harness>/<short-alias>"
```

## Where this rule lives across agent-bridge surfaces

- **This file (`docs/named-target-routing.md`)** — canonical full text.
- **`AGENTS.md`** — abbreviated section with link back here.
- **`README.md`** — short callout in the message-routing area with link back here.
- **`bridge_send_message` tool description in `mcp-server/src/tools.ts`** — short note pointing recipients at this canonical doc.

If your harness exposes its own per-session config (system prompts, memory files), add the alias map there too for defense-in-depth. Both stay; don't remove either when the other is in place.

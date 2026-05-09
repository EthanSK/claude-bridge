/**
 * Re-export shim for the shared agent-bridge relay-notice formatter.
 *
 * Canonical source lives at `<repo>/lib/relay-notice.js` (plain ESM JS).
 * Both consumers — the OpenClaw `openclaw-channel/` plugin and this Claude
 * Code `mcp-server/` channel plugin — import the same module so the
 * structural shape of bridge-relay user-facing notices is byte-identical
 * across the fleet.
 *
 * The Summary blockquote (which requires LLM judgment per inbound message)
 * stays agent-driven in BOTH harnesses: pass `summary: null` to embed a
 * `{{SUMMARY_PLACEHOLDER}}` sentinel that the agent replaces before sending
 * the relay to the user-facing channel. Canonical user-facing format spec:
 * `docs/relay-to-user.md`.
 *
 * IMPORTANT runtime note: this re-export resolves at the relative path
 * `../../lib/relay-notice.js` from the compiled `build/index.js`, which
 * requires the mcp-server plugin to run from a checkout of the full agent-
 * bridge repo (so `lib/` is a sibling of `mcp-server/`). That's the
 * documented production posture (see CLAUDE.md "Stale / out-of-date plugin
 * install" + `agent-bridge plugin-registry-rewire` — which rewires the CC
 * registry from cache-only paths to the dev clone).
 */

export {
  formatRelayNotice,
  formatRelayScaffold,
  relayNoticeEnabled,
  relayNoticePreview,
  SUMMARY_PLACEHOLDER,
  RELAY_SCAFFOLD_START,
  RELAY_SCAFFOLD_END,
} from '../../lib/relay-notice.js';

export type { RelayNoticeMessage, RelayNoticeOpts } from '../../lib/relay-notice.js';

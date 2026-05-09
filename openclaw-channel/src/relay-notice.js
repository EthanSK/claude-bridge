/**
 * Telegram-visible relay receipts for inbound Agent Bridge messages.
 *
 * As of agent-bridge 4.2.0 the structural formatter (`formatRelayNotice`,
 * `relayNoticeEnabled`, `relayNoticePreview`) is canonically defined in the
 * shared module `<repo>/lib/relay-notice.js`. This file is a thin re-export
 * shim so existing imports inside `openclaw-channel/` (and the test suite)
 * keep working while the same code is also consumed by the Claude Code
 * `mcp-server/` channel plugin.
 *
 * Why one shared module: previously CC relay notices were hand-composed from
 * prose guidance every time, drifting from OC's programmatic shape. Sharing
 * the formatter guarantees byte-identical structural output across the fleet.
 * The Summary blockquote (which requires LLM judgment per inbound message)
 * stays agent-driven in BOTH harnesses.
 *
 * Full message bodies are no longer included in the notice. Instead the
 * OpenClaw channel stores the full inbound BridgeMessage locally under
 * ~/.agent-bridge/relay-expand/ and includes a short expand id here.
 */

export {
  formatRelayNotice,
  formatRelayScaffold,
  relayNoticeEnabled,
  relayNoticePreview,
  SUMMARY_PLACEHOLDER,
  RELAY_SCAFFOLD_START,
  RELAY_SCAFFOLD_END,
  __testing,
} from "../../lib/relay-notice.js";

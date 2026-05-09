/**
 * TypeScript ambient declarations for the shared relay-notice formatter.
 * The implementation lives in `relay-notice.js` (plain ESM JS); this file
 * exists so the `mcp-server/` TypeScript build can import it with proper
 * type checking.
 */

export interface RelayNoticeMessage {
  id?: string | null;
  from?: string | null;
  fromTarget?: string | null;
  target?: string | null;
}

export interface RelayNoticeOpts {
  /** Local target name (OC fallback when msg.target is empty). */
  targetName?: string;
  /** OC-only relay-expand id. */
  expandId?: string;
  /** Reply-path channels (string or array). */
  replyVia?: string | string[];
  /** Running plugin version (e.g. "4.1.0"). */
  agentBridgeVersion?: string;
  /** Alias for agentBridgeVersion. */
  version?: string;
  /**
   * 1-3 sentence Summary string.
   * - non-empty string: embedded as `<blockquote><b>Summary:</b> ...</blockquote>`.
   * - null: a `{{SUMMARY_PLACEHOLDER}}` sentinel is appended.
   * - undefined: omitted (legacy OC behaviour, byte-identical pre-4.2.0).
   */
  summary?: string | null;
}

export const SUMMARY_PLACEHOLDER: string;
export const RELAY_SCAFFOLD_START: string;
export const RELAY_SCAFFOLD_END: string;

export function relayNoticeEnabled(
  pluginCfg?: Record<string, unknown>,
  targetCfg?: Record<string, unknown>,
): boolean;

export function relayNoticePreview(
  content: unknown,
  maxChars?: number,
): string;

export function formatRelayNotice(
  msg: RelayNoticeMessage | null | undefined,
  opts?: RelayNoticeOpts,
): string;

/**
 * Wraps `formatRelayNotice` output with `[RELAY-SCAFFOLD-START]` /
 * `[RELAY-SCAFFOLD-END]` fences and a `{{SUMMARY_PLACEHOLDER}}` sentinel.
 * Used by the CC channel plugin to embed an agent-fillable scaffold in
 * each inbound `<channel source="agent-bridge">` push.
 */
export function formatRelayScaffold(
  msg: RelayNoticeMessage | null | undefined,
  opts?: Omit<RelayNoticeOpts, 'summary'>,
): string;

export const __testing: {
  DEFAULT_PREVIEW_CHARS: number;
};

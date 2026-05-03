/**
 * Telegram-visible relay receipts for inbound Agent Bridge messages.
 *
 * These are intentionally short, human-glanceable notices sent to the
 * configured OpenClaw chat before/while the synthetic agent turn runs. They
 * let Ethan see that a bridge/harness message landed even when the agent's
 * actual reply routes back over the silent agent-bridge back-channel.
 */

const DEFAULT_PREVIEW_CHARS = 180;

export function relayNoticeEnabled(pluginCfg = {}, targetCfg = {}) {
  const raw = targetCfg.relayNotice ?? pluginCfg.relayNotice;
  if (raw === false) return false;
  if (raw && typeof raw === "object" && raw.enabled === false) return false;
  return true;
}

export function relayNoticePreview(content, maxChars = DEFAULT_PREVIEW_CHARS) {
  const text = String(content ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const limit = Math.max(20, Number(maxChars) || DEFAULT_PREVIEW_CHARS);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function formatRelayNotice(msg, opts = {}) {
  const fromMachine = clean(msg?.from) || "unknown";
  const fromTarget = clean(msg?.fromTarget);
  const target = clean(msg?.target) || (opts.targetName ? `openclaw/${opts.targetName}` : "openclaw/?");
  const id = clean(msg?.id);
  const replyVia = clean(opts.replyVia);
  const preview = relayNoticePreview(msg?.content, opts.previewChars);

  const from = fromTarget ? `${fromMachine}/${fromTarget}` : fromMachine;
  const lines = [
    "[Agent Bridge relay] 🛰️",
    `received: ${from} → ${target}`,
  ];
  if (replyVia) lines.push(`reply path: ${replyVia}`);
  if (id) lines.push(`id: ${id}`);
  if (preview) lines.push(`preview: “${preview}”`);
  return lines.join("\n");
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

export const __testing = {
  DEFAULT_PREVIEW_CHARS,
};

import test from "node:test";
import assert from "node:assert/strict";

import {
  formatRelayNotice,
  formatRelayScaffold,
  relayNoticeEnabled,
  relayNoticePreview,
  RELAY_SCAFFOLD_START,
  RELAY_SCAFFOLD_END,
  SUMMARY_PLACEHOLDER,
} from "../src/relay-notice.js";

test("relay notices are enabled by default and can be disabled", () => {
  assert.equal(relayNoticeEnabled({}, {}), true);
  assert.equal(relayNoticeEnabled({ relayNotice: false }, {}), false);
  assert.equal(relayNoticeEnabled({ relayNotice: { enabled: false } }, {}), false);
  assert.equal(relayNoticeEnabled({ relayNotice: false }, { relayNotice: true }), true);
});

test("relay notice preview compatibility helper is one-line and bounded", () => {
  assert.equal(relayNoticePreview("  hello\n\nworld  "), "hello world");
  assert.equal(relayNoticePreview("a".repeat(50), 20), `${"a".repeat(19)}…`);
  assert.equal(relayNoticePreview("a".repeat(3100)).length, 3000);
});

test("formatRelayNotice uses a compact expand id instead of dumping content", () => {
  const longContent = "Please sync the setup repo and reply with status. ".repeat(80);
  const text = formatRelayNotice(
    {
      id: "msg-123",
      from: "MacBookPro",
      fromTarget: "claude-code",
      target: "openclaw/clordlethird",
      content: longContent,
    },
    {
      targetName: "clordlethird",
      replyVia: "agent-bridge",
      agentBridgeVersion: "4.1.0",
      expandId: "07",
    },
  );

  assert.match(text, /^\[Agent Bridge relay\] 🛰️/);
  assert.match(text, /agent-bridge: v4\.1\.0/);
  assert.match(text, /received: MacBookPro\/claude-code → openclaw\/clordlethird/);
  assert.match(text, /reply path: agent-bridge/);
  assert.match(text, /message id: msg-123/);
  assert.match(text, /expand id: 07/);
  assert.match(text, /expand: agent-bridge relay-expand 07/);
  assert.doesNotMatch(text, /message:/);
  assert.doesNotMatch(text, /Please sync the setup repo/);
  assert.ok(text.length < 260, "relay notice should stay compact");
});

test("formatRelayNotice without summary opt is byte-identical to legacy output", () => {
  // Pre-4.2.0 callers pass no `summary` option. Output must remain unchanged
  // (no trailing placeholder, no blockquote) so existing OC gateway-side
  // delivery and goldens stay valid.
  const text = formatRelayNotice(
    { id: "msg-legacy", from: "MacBookPro", target: "openclaw/default" },
    { agentBridgeVersion: "4.2.0", replyVia: "agent-bridge" },
  );
  assert.doesNotMatch(text, /SUMMARY_PLACEHOLDER/);
  assert.doesNotMatch(text, /<blockquote>/);
  assert.doesNotMatch(text, /\{\{/);
});

test("formatRelayNotice with summary=null appends the placeholder sentinel", () => {
  const text = formatRelayNotice(
    { id: "msg-1", from: "MacBookPro", target: "openclaw/default" },
    { summary: null },
  );
  assert.ok(
    text.endsWith(SUMMARY_PLACEHOLDER),
    `expected text to end with the placeholder sentinel, got: ${JSON.stringify(text)}`,
  );
});

test("formatRelayNotice with summary string embeds a Summary blockquote", () => {
  const text = formatRelayNotice(
    { id: "msg-1", from: "MacBookPro", target: "openclaw/default" },
    { summary: "MBP wants to sync the dot-claude repo." },
  );
  assert.match(
    text,
    /<blockquote><b>Summary:<\/b> MBP wants to sync the dot-claude repo\.<\/blockquote>$/,
  );
});

test("formatRelayScaffold wraps the notice in scaffold fences with placeholder", () => {
  const text = formatRelayScaffold(
    {
      id: "msg-99",
      from: "MacBookPro",
      fromTarget: "claude-code",
      target: "claude-code/default",
    },
    { agentBridgeVersion: "4.2.0", replyVia: "agent-bridge" },
  );
  assert.ok(text.startsWith(`${RELAY_SCAFFOLD_START}\n`), "starts with scaffold-start fence");
  assert.ok(text.endsWith(`\n${RELAY_SCAFFOLD_END}`), "ends with scaffold-end fence");
  assert.match(text, /\[Agent Bridge relay\] 🛰️/);
  assert.match(text, /agent-bridge: v4\.2\.0/);
  assert.match(text, /received: MacBookPro\/claude-code → claude-code\/default/);
  assert.match(text, /message id: msg-99/);
  assert.ok(text.includes(SUMMARY_PLACEHOLDER), "carries the summary placeholder for the agent to fill");
});

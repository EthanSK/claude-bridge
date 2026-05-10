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
      to: "MacMini",
      fromTarget: "claude-code",
      target: "openclaw/clordlethird",
      content: longContent,
      sourceAgentBridgeVersion: "4.0.9",
    },
    {
      targetName: "clordlethird",
      replyVia: "agent-bridge",
      destinationAgentBridgeVersion: "4.1.0",
      expandId: "07",
    },
  );

  assert.match(text, /^\[Agent Bridge relay\] 🛰️/);
  assert.match(text, /source: MacBookPro\/claude-code \(agent-bridge v4\.0\.9\)/);
  assert.match(text, /destination: MacMini\/openclaw\/clordlethird \(agent-bridge v4\.1\.0\)/);
  assert.match(text, /received: MacBookPro\/claude-code → MacMini\/openclaw\/clordlethird/);
  assert.match(text, /reply path: agent-bridge/);
  assert.match(text, /message id: msg-123/);
  assert.match(text, /expand id: 07/);
  assert.match(text, /expand: agent-bridge relay-expand 07/);
  assert.doesNotMatch(text, /message:/);
  assert.doesNotMatch(text, /Please sync the setup repo/);
  assert.ok(text.length < 420, "relay notice should stay compact");
});

test("formatRelayNotice without summary opt keeps legacy no-placeholder behaviour", () => {
  // Callers that pass no `summary` option still get no trailing placeholder
  // or blockquote; only the metadata lines changed in 4.5.0 to show endpoint
  // labels and destination-side version identity explicitly.
  const text = formatRelayNotice(
    { id: "msg-legacy", from: "MacBookPro", to: "MacMini", target: "openclaw/default" },
    { agentBridgeVersion: "4.2.0", replyVia: "agent-bridge" },
  );
  assert.match(text, /source: MacBookPro \(agent-bridge unknown\)/);
  assert.match(text, /destination: MacMini\/openclaw\/default \(agent-bridge v4\.2\.0\)/);
  assert.doesNotMatch(text, /SUMMARY_PLACEHOLDER/);
  assert.doesNotMatch(text, /<blockquote>/);
  assert.doesNotMatch(text, /\{\{/);
});

test("formatRelayNotice handles source-only version metadata from rolling-upgrade peers", () => {
  const text = formatRelayNotice(
    {
      id: "msg-source-only",
      from: "MacBookPro",
      to: "MacMini",
      fromTarget: "claude-code/default",
      target: "openclaw/default",
      sourceAgentBridgeVersion: "4.5.0",
    },
    { replyVia: "agent-bridge" },
  );

  assert.match(text, /source: MacBookPro\/claude-code\/default \(agent-bridge v4\.5\.0\)/);
  assert.match(text, /destination: MacMini\/openclaw\/default \(agent-bridge unknown\)/);
});

test("formatRelayNotice shows unknown versions when neither endpoint has metadata", () => {
  const text = formatRelayNotice(
    {
      id: "msg-no-versions",
      from: "OldSource",
      to: "OldDestination",
      fromTarget: "claude-code",
      target: "openclaw/default",
    },
    { replyVia: "agent-bridge" },
  );

  assert.match(text, /source: OldSource\/claude-code \(agent-bridge unknown\)/);
  assert.match(text, /destination: OldDestination\/openclaw\/default \(agent-bridge unknown\)/);
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

test("formatRelayNotice uses source-authored relaySummary from the message", () => {
  const text = formatRelayNotice(
    {
      id: "msg-1",
      from: "MacBookPro",
      target: "openclaw/default",
      relaySummary: "MBP wants <OpenClaw> to post the receipt from code.",
    },
    {},
  );
  assert.match(
    text,
    /<blockquote><b>Summary:<\/b> MBP wants &lt;OpenClaw&gt; to post the receipt from code\.<\/blockquote>$/,
  );
});

test("formatRelayScaffold wraps the notice in scaffold fences with placeholder", () => {
  const text = formatRelayScaffold(
    {
      id: "msg-99",
      from: "MacBookPro",
      to: "MacMini",
      fromTarget: "claude-code",
      target: "claude-code/default",
      sourceAgentBridgeVersion: "4.1.9",
    },
    { destinationAgentBridgeVersion: "4.2.0", replyVia: "agent-bridge" },
  );
  assert.ok(text.startsWith(`${RELAY_SCAFFOLD_START}\n`), "starts with scaffold-start fence");
  assert.ok(text.endsWith(`\n${RELAY_SCAFFOLD_END}`), "ends with scaffold-end fence");
  assert.match(text, /\[Agent Bridge relay\] 🛰️/);
  assert.match(text, /source: MacBookPro\/claude-code \(agent-bridge v4\.1\.9\)/);
  assert.match(text, /destination: MacMini\/claude-code\/default \(agent-bridge v4\.2\.0\)/);
  assert.match(text, /received: MacBookPro\/claude-code → MacMini\/claude-code\/default/);
  assert.match(text, /message id: msg-99/);
  assert.ok(text.includes(SUMMARY_PLACEHOLDER), "carries the summary placeholder for the agent to fill");
});

test("formatRelayScaffold embeds source-authored summary when provided", () => {
  const text = formatRelayScaffold(
    {
      id: "msg-100",
      from: "MacBookPro",
      to: "MacMini",
      fromTarget: "claude-code/default",
      target: "openclaw/default",
      relaySummary: "Source already summarized this bridge handoff.",
    },
    { destinationAgentBridgeVersion: "4.5.2", replyVia: "agent-bridge" },
  );

  assert.ok(text.startsWith(`${RELAY_SCAFFOLD_START}\n`));
  assert.doesNotMatch(text, /\{\{SUMMARY_PLACEHOLDER\}\}/);
  assert.match(text, /<blockquote><b>Summary:<\/b> Source already summarized this bridge handoff\.<\/blockquote>/);
});

import test from "node:test";
import assert from "node:assert/strict";

import { buildReply, parseBridgeMessage } from "../src/envelope.js";

test("buildReply preserves message id threading and explicit return target", () => {
  const reply = buildReply({
    fromMachine: "Mac-Mini",
    toMachine: "MacBookPro",
    replyToId: "msg-incoming",
    content: "done",
    target: "claude-code",
    ownTarget: "openclaw/clordlethird",
    sourceAgentBridgeVersion: "4.5.0",
  });

  assert.match(reply.id, /^msg-/);
  assert.equal(reply.replyTo, "msg-incoming");
  assert.equal(reply.target, "claude-code");
  assert.equal(reply.fromTarget, "openclaw/clordlethird");
  assert.equal(reply.sourceAgentBridgeVersion, "4.5.0");
});

test("buildReply can derive return target from incoming.fromTarget", () => {
  const reply = buildReply({
    fromMachine: "Mac-Mini",
    toMachine: "MacBookPro",
    replyToId: "msg-incoming",
    content: "done",
    incoming: {
      fromTarget: "openclaw/default",
    },
    ownTarget: "openclaw/default",
  });

  assert.equal(reply.target, "openclaw/default");
});

test("parseBridgeMessage accepts empty string content", () => {
  const msg = parseBridgeMessage(JSON.stringify({
    id: "msg-empty",
    from: "MacBookPro",
    to: "Mac-Mini",
    content: "",
    timestamp: Date.now(),
    target: "openclaw/default",
  }));

  assert.equal(msg.id, "msg-empty");
  assert.equal(msg.content, "");
});

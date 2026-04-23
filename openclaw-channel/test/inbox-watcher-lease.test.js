import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startInboxWatcher } from "../src/inbox-watcher.js";

test("startInboxWatcher leases delivery across watcher instances", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-openclaw-watch-"));
  const inboxRoot = join(root, "inbox");
  const ledgerPath = join(root, "delivered");
  const archiveRoot = join(root, "archive");
  const leasePath = join(root, "locks", "openclaw.watcher-lock.json");
  const targetDir = join(inboxRoot, "openclaw", "default");
  const seen = [];
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const targets = {
    default: {
      openclaw_channel: "telegram",
      account: "default",
      peer_id: "6164541473",
    },
  };

  const stop1 = startInboxWatcher({
    inboxRoot,
    ledgerPath,
    archiveRoot,
    leasePath,
    pollIntervalMs: 500,
    logger,
    targets,
    onMessage: (msg) => {
      seen.push(`first:${msg.id}`);
    },
  });
  const stop2 = startInboxWatcher({
    inboxRoot,
    ledgerPath,
    archiveRoot,
    leasePath,
    pollIntervalMs: 500,
    logger,
    targets,
    onMessage: (msg) => {
      seen.push(`second:${msg.id}`);
    },
  });

  try {
    assert.equal(existsSync(leasePath), true);
    writeMessage(targetDir, "msg-one");
    await waitFor(() => seen.includes("first:msg-one"));
    assert.equal(seen.includes("second:msg-one"), false);

    stop1();
    writeMessage(targetDir, "msg-two");
    await waitFor(() => seen.includes("second:msg-two"));
    assert.equal(seen.includes("first:msg-two"), false);
  } finally {
    stop1();
    stop2();
    rmSync(root, { recursive: true, force: true });
  }
});

function writeMessage(targetDir, id) {
  writeFileSync(
    join(targetDir, `${id}.json`),
    JSON.stringify({
      id,
      from: "MacBookPro",
      to: "Mac-Mini",
      type: "message",
      content: "hello",
      timestamp: new Date().toISOString(),
      target: "openclaw/default",
      fromTarget: "claude-code",
    }),
  );
}

async function waitFor(predicate, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(predicate(), true);
}

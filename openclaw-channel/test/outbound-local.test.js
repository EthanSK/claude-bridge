// Tests for same-machine delivery in openclaw-channel (3.5.1+).
//
// These mirror mcp-server/test/local-delivery.test.js for the openclaw-channel
// outbound side: when an embedded OpenClaw agent replies to a same-machine
// sender, deliverReply must write the JSON straight to
// ~/.agent-bridge/inbox/<target>/<id>.json — no SSH, no "paired machine not
// found" error.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { deliverReply, deliverReplyLocal, isLocalMachineName, LOCAL_MACHINE_ALIASES } from "../src/outbound.js";

const LOCAL_NAME = "Ethans-Mac-mini";

async function withSandbox(fn) {
  const sandbox = mkdtempSync(join(tmpdir(), "openclaw-outbound-local-"));
  const inboxDir = join(sandbox, "inbox");
  const outboxDir = join(sandbox, "outbox");
  const configPath = join(sandbox, "config");
  const nameFilePath = join(sandbox, "machine-name");
  const identityPath = join(sandbox, ".identity");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(nameFilePath, `${LOCAL_NAME}\n`);
  const env = { AGENT_BRIDGE_MACHINE_NAME: "" };
  const localNameOpts = {
    env,
    nameFilePath,
    identityPath,
    getHostname: () => `${LOCAL_NAME}.local`,
  };
  try {
    return await fn({ sandbox, inboxDir, outboxDir, configPath, localNameOpts });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function makeMessage(overrides = {}) {
  return {
    id: `msg-${randomUUID()}`,
    from: LOCAL_NAME,
    to: LOCAL_NAME,
    type: "message",
    content: "hello local",
    timestamp: new Date().toISOString(),
    replyTo: null,
    ttl: 60,
    target: "claude-code",
    fromTarget: "openclaw/clawdiboi2",
    ...overrides,
  };
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

// ── isLocalMachineName ──────────────────────────────────────────────────────

test("isLocalMachineName recognises the real machine name (case-insensitive)", () => {
  withSandbox(({ localNameOpts }) => {
    assert.equal(isLocalMachineName(LOCAL_NAME, localNameOpts), true);
    assert.equal(isLocalMachineName(LOCAL_NAME.toLowerCase(), localNameOpts), true);
    assert.equal(isLocalMachineName(`  ${LOCAL_NAME}  `, localNameOpts), true);
    assert.equal(isLocalMachineName("SomeOtherMachine", localNameOpts), false);
  });
});

test("isLocalMachineName recognises every reserved alias", () => {
  for (const alias of LOCAL_MACHINE_ALIASES) {
    assert.equal(isLocalMachineName(alias), true, alias);
    assert.equal(isLocalMachineName(alias.toUpperCase()), true, alias);
  }
});

test("isLocalMachineName rejects empty/non-string input", () => {
  assert.equal(isLocalMachineName(""), false);
  assert.equal(isLocalMachineName("   "), false);
  assert.equal(isLocalMachineName(undefined), false);
  assert.equal(isLocalMachineName(null), false);
});

// ── deliverReplyLocal ───────────────────────────────────────────────────────

test("deliverReplyLocal writes to the correct per-target inbox subdir", () => {
  withSandbox(({ inboxDir, outboxDir }) => {
    const msg = makeMessage({ target: "claude-code" });
    deliverReplyLocal({ message: msg, toMachine: LOCAL_NAME, inboxDir, outboxDir, logger: silentLogger });

    const finalPath = join(inboxDir, "claude-code", `${msg.id}.json`);
    const parsed = JSON.parse(readFileSync(finalPath, "utf8"));
    assert.equal(parsed.id, msg.id);
    assert.equal(parsed.target, "claude-code");
    assert.equal(parsed.fromTarget, "openclaw/clawdiboi2");
    assert.equal(parsed.content, "hello local");

    // Outbox copy mirrors the SSH path.
    const outboxPath = join(outboxDir, `${msg.id}.json`);
    assert.equal(JSON.parse(readFileSync(outboxPath, "utf8")).id, msg.id);
  });
});

test("deliverReplyLocal creates the per-target subdir when missing", () => {
  withSandbox(({ inboxDir, outboxDir }) => {
    const msg = makeMessage({ target: "openclaw/clawdiboi2" });
    const targetDir = join(inboxDir, "openclaw", "clawdiboi2");
    assert.equal(existsSync(targetDir), false);

    deliverReplyLocal({ message: msg, toMachine: LOCAL_NAME, inboxDir, outboxDir, logger: silentLogger });

    assert.equal(existsSync(targetDir), true);
    const files = readdirSync(targetDir).filter((f) => f.endsWith(".json"));
    assert.ok(files.includes(`${msg.id}.json`));
  });
});

test("deliverReplyLocal leaves no .tmp files behind on success", () => {
  withSandbox(({ inboxDir, outboxDir }) => {
    const msg = makeMessage();
    deliverReplyLocal({ message: msg, toMachine: LOCAL_NAME, inboxDir, outboxDir, logger: silentLogger });
    const targetDir = join(inboxDir, "claude-code");
    const tmpFiles = readdirSync(targetDir).filter((f) => f.startsWith(".agent-bridge-") && f.endsWith(".tmp"));
    assert.equal(tmpFiles.length, 0, `unexpected tmp files: ${tmpFiles.join(",")}`);
  });
});

test("deliverReplyLocal rejects messages with no/invalid target", () => {
  withSandbox(({ inboxDir, outboxDir }) => {
    const noTarget = makeMessage({ target: undefined });
    assert.throws(
      () => deliverReplyLocal({ message: noTarget, toMachine: LOCAL_NAME, inboxDir, outboxDir, logger: silentLogger }),
      /target is required/,
    );

    const traversal = makeMessage({ target: "../escape" });
    assert.throws(
      () => deliverReplyLocal({ message: traversal, toMachine: LOCAL_NAME, inboxDir, outboxDir, logger: silentLogger }),
      /target is required/,
    );
  });
});

// ── deliverReply (entry point) ──────────────────────────────────────────────

test("deliverReply with local machine name short-circuits to local write (no SSH)", async () => {
  await withSandbox(async ({ inboxDir, outboxDir, configPath, localNameOpts }) => {
    // Empty config — if the SSH path were taken, deliverReply would throw
    // "paired machine not found".
    writeFileSync(configPath, "");
    const msg = makeMessage();

    await deliverReply({
      message: msg,
      toMachine: LOCAL_NAME,
      inboxDir,
      outboxDir,
      configPath,
      localNameOpts,
      logger: silentLogger,
    });

    const finalPath = join(inboxDir, "claude-code", `${msg.id}.json`);
    assert.equal(JSON.parse(readFileSync(finalPath, "utf8")).id, msg.id);
  });
});

test("deliverReply with reserved aliases (local/self/localhost) routes locally", async () => {
  for (const alias of LOCAL_MACHINE_ALIASES) {
    await withSandbox(async ({ inboxDir, outboxDir, configPath, localNameOpts }) => {
      writeFileSync(configPath, "");
      const msg = makeMessage();

      await deliverReply({
        message: msg,
        toMachine: alias,
        inboxDir,
        outboxDir,
        configPath,
        localNameOpts,
        logger: silentLogger,
      });

      const finalPath = join(inboxDir, "claude-code", `${msg.id}.json`);
      assert.equal(JSON.parse(readFileSync(finalPath, "utf8")).id, msg.id, `alias=${alias}`);
    });
  }
});

test("deliverReply still throws for unknown remote machine (SSH path unchanged)", async () => {
  await withSandbox(async ({ inboxDir, outboxDir, configPath, localNameOpts }) => {
    // Empty paired-machine config; "MacBookPro" is not local and not paired.
    writeFileSync(configPath, "");
    const msg = makeMessage();

    await assert.rejects(
      () => deliverReply({
        message: msg,
        toMachine: "MacBookPro",
        inboxDir,
        outboxDir,
        configPath,
        localNameOpts,
        logger: silentLogger,
      }),
      /paired machine "MacBookPro" not found/,
    );

    // No file should have been written to the local inbox.
    const targetDir = join(inboxDir, "claude-code");
    if (existsSync(targetDir)) {
      const files = readdirSync(targetDir).filter((f) => f.endsWith(".json"));
      assert.equal(files.length, 0);
    }
  });
});

test("mixed scenario: local send lands in local inbox even when paired remotes exist", async () => {
  await withSandbox(async ({ inboxDir, outboxDir, configPath, localNameOpts }) => {
    writeFileSync(
      configPath,
      [
        "[MacBookPro]",
        "host=192.168.1.50",
        "user=ethan",
        "port=22",
        "key=/dev/null",
        "paired_at=2026-01-01T00:00:00Z",
        "",
      ].join("\n"),
    );

    const msg = makeMessage();
    await deliverReply({
      message: msg,
      toMachine: LOCAL_NAME,
      inboxDir,
      outboxDir,
      configPath,
      localNameOpts,
      logger: silentLogger,
    });

    const finalPath = join(inboxDir, "claude-code", `${msg.id}.json`);
    assert.equal(JSON.parse(readFileSync(finalPath, "utf8")).id, msg.id);
  });
});

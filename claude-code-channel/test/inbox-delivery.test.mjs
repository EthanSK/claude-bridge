/**
 * 3.6.0 — claude-code-channel inbox delivery test.
 *
 * Drops a BridgeMessage JSON into ~/.agent-bridge/inbox/claude-code/ on a
 * temp HOME, lets the plugin's watcher pick it up, and verifies:
 *   - message.received and message.pushed_to_channel events are written.
 *   - the message ID is added to the .delivered ledger so it won't replay.
 *   - the file is moved out of the inbox into .archive/claude-code/.
 *
 * The MCP transport is real here — the plugin's stdout speaks JSON-RPC on
 * the parent's stdin. We don't actually decode the channel notification; we
 * trust the unified log + filesystem state to prove delivery happened. A
 * full notification-decode test would require a real MCP client, which is
 * out of scope for this smoke test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '..', 'build', 'index.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readUnifiedEvents(home) {
  const logFile = join(home, '.agent-bridge', 'logs', 'agent-bridge.log');
  try {
    const raw = await readFile(logFile, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

test('watcher detects new inbox file, pushes channel notification, archives the file', { timeout: 20_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-code-channel-delivery-'));
  const inboxDir = join(home, '.agent-bridge', 'inbox', 'claude-code');
  const archiveDir = join(home, '.agent-bridge', 'inbox', '.archive', 'claude-code');
  const deliveredFile = join(home, '.agent-bridge', 'inbox', '.delivered');

  const child = spawn(process.execPath, [indexPath], {
    env: {
      ...process.env,
      HOME: home,
      AGENT_BRIDGE_MACHINE_NAME: 'test-claude-code-channel',
      AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  child.stdout.resume();

  try {
    // Wait for plugin startup.
    await sleep(1500);

    // Drop a fully-formed BridgeMessage into the inbox.
    await mkdir(inboxDir, { recursive: true, mode: 0o700 });
    const msgId = `msg-${randomUUID()}`;
    const msg = {
      id: msgId,
      from: 'TestSender',
      to: 'test-claude-code-channel',
      type: 'message',
      content: 'hello from the inbox-delivery test',
      timestamp: new Date().toISOString(),
      replyTo: null,
      ttl: 600,
      target: 'claude-code',
      fromTarget: 'claude-code',
    };
    const msgPath = join(inboxDir, `${msgId}.json`);
    await writeFile(msgPath, JSON.stringify(msg, null, 2), { mode: 0o600 });

    // Watcher polls every 2 s. Channel notification will then fail because
    // there is no real MCP client decoding it — but the watcher still emits
    // message.received before attempting the push, and the push notification
    // call resolves on the server side (the SDK queues notifications when
    // there's no subscriber). Allow ~7 s for the polling cycle + push attempt.
    let archived = false;
    for (let i = 0; i < 12; i += 1) {
      await sleep(1000);
      try {
        const archEntries = await readdir(archiveDir);
        if (archEntries.some((f) => f.endsWith(`_${msgId}.json`))) {
          archived = true;
          break;
        }
      } catch {
        /* archive dir may not exist yet */
      }
    }
    assert.ok(archived, `expected inbox file to be archived to ${archiveDir} within 12 s`);

    // .delivered ledger should contain the msg id.
    assert.ok(existsSync(deliveredFile), '.delivered ledger should be written');
    const delivered = await readFile(deliveredFile, 'utf8');
    assert.ok(delivered.includes(msgId), `.delivered ledger should contain ${msgId}`);

    // Inbox should no longer have the file.
    const inboxRemaining = await readdir(inboxDir);
    assert.ok(
      !inboxRemaining.includes(`${msgId}.json`),
      'inbox should no longer contain the delivered file',
    );

    // Unified log should show message.received and message.pushed_to_channel.
    const events = await readUnifiedEvents(home);
    const received = events.find((e) => e.event === 'message.received' && e.context?.msg_id === msgId);
    assert.ok(received, 'expected message.received event for delivered msg');
    const pushed = events.find((e) => e.event === 'message.pushed_to_channel' && e.context?.msg_id === msgId);
    assert.ok(pushed, 'expected message.pushed_to_channel event for delivered msg');
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    try {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(3000),
      ]);
    } catch {}
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

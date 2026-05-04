/**
 * 4.0.1 [DEAD-FALSE-POSITIVE 2026-05-04] — regression coverage for the two
 * dead-channel improvements:
 *
 *   1. Recovery path — a fresh tool call clears `channelMarkedDead` so the
 *      channel self-heals on the next harness ack instead of sticking dead
 *      until the MCP child restarts.
 *
 *   2. False-positive prevention — if any tool call is currently in flight
 *      (i.e. the harness is busy executing a long-running tool, not frozen),
 *      the escape-hatch must NOT trip even when the receive-counter and
 *      listener-count both look quiet.
 *
 * Bug seen in production (cross-fleet integration test, 2026-05-04):
 *   - tool_calls_at_window_start: 34, tool_calls_now: 34, listeners_now: 0
 *   - 6 pushes within 30s — channel marked dead while a tool was actively
 *     running. Channel stayed dead until next process restart, breaking
 *     unsolicited inbound pushes for the rest of the session.
 *
 * Tests drive the watcher in-process so we can assert state transitions
 * deterministically without depending on poll timing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── HOME-sandbox setup (must precede module imports) ────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), 'ab-dead-recovery-'));
mkdirSync(join(sandbox, '.agent-bridge'), { recursive: true });
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.AGENT_BRIDGE_MACHINE_NAME = 'TestMachine';
process.env.AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG = '1';
process.env.AGENT_BRIDGE_DISABLE_PARENT_CHECK = '1';
process.env.AGENT_BRIDGE_DISABLE_PATCH_F = '1';

const inbox = await import('../build/inbox.js');
const watcher = await import('../build/watcher.js');

const inboxDir = join(sandbox, '.agent-bridge', 'inbox', 'claude-code', 'default');
const pendingAckDir = join(sandbox, '.agent-bridge', 'inbox', '.pending-ack', 'claude-code', 'default');

inbox.ensureInboxDirs();
mkdirSync(inboxDir, { recursive: true });

test.after(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function dropMessage(content) {
  const msg = inbox.createMessage(
    'TestSender',
    'TestMachine',
    'message',
    content,
    null,
    600,
    'claude-code',
    'claude-code',
  );
  const filePath = join(inboxDir, `${msg.id}.json`);
  writeFileSync(filePath, JSON.stringify(msg, null, 2), { mode: 0o600 });
  return msg;
}

function listAck() {
  try { return readdirSync(pendingAckDir); } catch { return []; }
}

function cleanup() {
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
  if (existsSync(pendingAckDir)) for (const f of readdirSync(pendingAckDir)) try { rmSync(join(pendingAckDir, f)); } catch {}
}

async function waitForStage(id) {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 750));
    if (listAck().includes(`${id}.json`)) return true;
  }
  return false;
}

// ── Test 1: baseline — burst with NO alive evidence still trips dead-mark ────
//
// This anchors the existing behaviour before validating the new improvements:
// we want the escape-hatch to STILL fire when the harness genuinely is not
// responding (no tool calls, no listeners, no in-flight tool). Tests 2 & 3
// would be vacuous if the trigger had been weakened.
test('baseline: burst with no alive evidence still marks channel dead', { timeout: 30_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  cleanup();

  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 0,
    getChannelCallbackRegisteredAt: () => 0,
    getToolCallsInFlight: () => 0,
  });

  const startedOk = await watcher.startWatcher(() => {}, async () => {}, { role: 'channel-owner' });
  assert.ok(startedOk);

  for (let i = 0; i < 5; i += 1) {
    dropMessage(`baseline-${i}`);
    await new Promise((r) => setTimeout(r, 2_300));
  }
  watcher._processPendingDeliveriesForTesting();

  assert.ok(
    watcher._isChannelMarkedDeadForTesting(),
    'expected channel to be marked dead after 5 pushes with no alive evidence',
  );

  watcher.stopWatcher();
  cleanup();
  watcher._resetPendingDeliveriesForTesting();
});

// ── Test 2: recovery — recordHarnessAck() clears a dead channel ──────────────
//
// Simulates the production fix path: a long burst trips the escape-hatch,
// the harness later runs a tool (recordHarnessAck fires from index.ts's
// shim), and the channel returns to healthy. New messages then flow through
// the normal callback path instead of being staged-and-skipped.
test('recovery: recordHarnessAck clears dead-mark and restores callback delivery', { timeout: 30_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  cleanup();

  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 0,
    getChannelCallbackRegisteredAt: () => 0,
    getToolCallsInFlight: () => 0,
  });

  let callbackCount = 0;
  const callback = async () => { callbackCount += 1; };
  const startedOk = await watcher.startWatcher(() => {}, callback, { role: 'channel-owner' });
  assert.ok(startedOk);

  // Trip the escape-hatch via burst.
  for (let i = 0; i < 5; i += 1) {
    dropMessage(`recovery-burst-${i}`);
    await new Promise((r) => setTimeout(r, 2_300));
  }
  watcher._processPendingDeliveriesForTesting();
  assert.ok(watcher._isChannelMarkedDeadForTesting(), 'expected dead-mark after burst');
  const burstedCallbacks = callbackCount;

  // Simulate the harness running a tool — index.ts calls recordHarnessAck()
  // at the top of every wrapped handler shim.
  watcher.recordHarnessAck();

  assert.ok(
    !watcher._isChannelMarkedDeadForTesting(),
    'recordHarnessAck() must clear the sticky dead-mark',
  );

  // Drop a new message; it should be invoked through the callback path,
  // NOT staged-and-skipped like a dead-channel push would be.
  const recovered = dropMessage('recovery-after-ack');
  assert.ok(await waitForStage(recovered.id), 'recovered message should reach pending-ack/');
  assert.ok(
    callbackCount > burstedCallbacks,
    `callback must be invoked again after recovery (was ${burstedCallbacks}, now ${callbackCount})`,
  );

  watcher.stopWatcher();
  cleanup();
  watcher._resetPendingDeliveriesForTesting();
});

// ── Test 3: false-positive prevention — burst during in-flight tool ──────────
//
// Reproduces the 2026-05-04 cross-fleet log scenario:
//   tool_calls_at_window_start=34, tool_calls_now=34, listeners_now=0,
//   recent_pushes=6 → channel marked dead WHILE a tool was actively running.
//
// With the in-flight gate, a non-zero in-flight count is positive evidence
// the harness is busy (not frozen), so the dead-mark must be suppressed.
test('false-positive prevention: in-flight tool call suppresses dead-mark during burst', { timeout: 30_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  cleanup();

  // Frozen receive-counter (matches the production log: tcNow == firstSnapshot
  // because the count was bumped pre-handler, before the burst started).
  // Listener-count is 0. The ONLY positive signal is the in-flight gate.
  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 34,
    getChannelCallbackRegisteredAt: () => 0,
    getToolCallsInFlight: () => 1,
  });

  const startedOk = await watcher.startWatcher(() => {}, async () => {}, { role: 'channel-owner' });
  assert.ok(startedOk);

  for (let i = 0; i < 6; i += 1) {
    dropMessage(`in-flight-${i}`);
    await new Promise((r) => setTimeout(r, 2_300));
  }
  watcher._processPendingDeliveriesForTesting();

  assert.ok(
    !watcher._isChannelMarkedDeadForTesting(),
    'channel must NOT be marked dead while a tool call is in flight (positive harness-alive evidence)',
  );

  watcher.stopWatcher();
  cleanup();
  watcher._resetPendingDeliveriesForTesting();
});

// ── Test 4: recovery sweep — messages skipped during dead window are restored ─
//
// Codex review surfaced this case: when the channel is marked dead, inbound
// messages get staged with `escapeHatch=true` and are explicitly ignored by
// processPendingDeliveries. Without an explicit recovery sweep, clearing the
// dead flag on harness ack would only fix FUTURE pushes — messages received
// during the dead window would remain stranded in `.pending-ack/` until the
// next plugin reload. This test verifies recordHarnessAck() recovers them.
test('recovery sweep: messages staged during dead-window get re-injected to inbox on ack', { timeout: 30_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  cleanup();

  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 0,
    getChannelCallbackRegisteredAt: () => 0,
    getToolCallsInFlight: () => 0,
  });

  const startedOk = await watcher.startWatcher(() => {}, async () => {}, { role: 'channel-owner' });
  assert.ok(startedOk);

  // Trip the escape-hatch via burst.
  for (let i = 0; i < 5; i += 1) {
    dropMessage(`sweep-burst-${i}`);
    await new Promise((r) => setTimeout(r, 2_300));
  }
  watcher._processPendingDeliveriesForTesting();
  assert.ok(watcher._isChannelMarkedDeadForTesting(), 'expected dead-mark after burst');

  // Now drop two more messages while the channel is dead — these get staged
  // with escapeHatch=true and would be stranded under the old behaviour.
  const stranded = [];
  for (let i = 0; i < 2; i += 1) {
    const m = dropMessage(`sweep-during-dead-${i}`);
    stranded.push(m);
    await waitForStage(m.id);
  }

  // Verify they're in pending-ack/ with the dead-mark still set.
  for (const m of stranded) {
    assert.ok(listAck().includes(`${m.id}.json`), `${m.id} should be staged during dead-window`);
  }

  // Recovery: harness ack clears the dead-mark AND re-injects the stranded
  // escape-hatch entries.
  watcher.recordHarnessAck();

  assert.ok(!watcher._isChannelMarkedDeadForTesting(), 'dead-mark should be cleared');
  for (const m of stranded) {
    assert.ok(
      readdirSync(inboxDir).includes(`${m.id}.json`),
      `recovery sweep must re-inject ${m.id} from .pending-ack/ back to inbox/`,
    );
    assert.ok(
      !listAck().includes(`${m.id}.json`),
      `${m.id} should no longer be in .pending-ack/ after recovery`,
    );
  }

  watcher.stopWatcher();
  cleanup();
  watcher._resetPendingDeliveriesForTesting();
});

// ── Test 5: large recovered backlog does not immediately re-trip the hatch ───
//
// Codex review round 2 surfaced a sharp corner case: if the dead window
// stranded 5+ messages, the recovery sweep would re-inject them all, the
// next poll would re-emit them, repopulate `recentPushes` past the threshold,
// and re-trip the escape-hatch before any fresh harness ack could prove
// liveness. The fix excludes recovery-replay pushes from the burst detector.
test('burst-recovery: 6 stranded messages re-injected do not re-trip the dead-mark', { timeout: 60_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  cleanup();

  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 0,
    getChannelCallbackRegisteredAt: () => 0,
    getToolCallsInFlight: () => 0,
  });

  let callbackCount = 0;
  const startedOk = await watcher.startWatcher(
    () => {},
    async () => { callbackCount += 1; },
    { role: 'channel-owner' },
  );
  assert.ok(startedOk);

  // Trip the escape-hatch via 5-push burst (no in-flight tool, no listeners).
  for (let i = 0; i < 5; i += 1) {
    dropMessage(`big-burst-${i}`);
    await new Promise((r) => setTimeout(r, 2_300));
  }
  watcher._processPendingDeliveriesForTesting();
  assert.ok(watcher._isChannelMarkedDeadForTesting(), 'expected dead-mark after burst');
  const callbacksDuringBurst = callbackCount;

  // Strand 6 messages (one above the escape-hatch threshold).
  const stranded = [];
  for (let i = 0; i < 6; i += 1) {
    const m = dropMessage(`big-stranded-${i}`);
    stranded.push(m);
    await waitForStage(m.id);
  }
  assert.equal(callbackCount, callbacksDuringBurst, 'callback must NOT fire while channel is dead');

  // Recovery sweep.
  watcher.recordHarnessAck();
  assert.ok(!watcher._isChannelMarkedDeadForTesting(), 'dead-mark cleared');

  // Wait for the watcher's poll loop to re-pick up the recovered messages
  // from inbox/ and stage them through the normal channel-callback path.
  // Each recovered message should fire the callback once (recovery replay
  // is NOT counted toward the burst detector).
  for (let i = 0; i < 12; i += 1) {
    await new Promise((r) => setTimeout(r, 750));
    const stagedAll = stranded.every((m) => listAck().includes(`${m.id}.json`));
    if (stagedAll) break;
  }

  // Critical assertion: the channel must STILL be healthy after all 6
  // recovered messages have been replayed. Without the recovery-replay
  // exclusion, recentPushes would contain 6 entries and the next
  // maybeMarkChannelDead() eval would re-trip the dead-mark.
  watcher._processPendingDeliveriesForTesting();
  assert.ok(
    !watcher._isChannelMarkedDeadForTesting(),
    'channel must remain healthy after recovering ≥threshold stranded messages',
  );
  assert.ok(
    callbackCount > callbacksDuringBurst,
    `callback must fire for each recovered message (was ${callbacksDuringBurst}, now ${callbackCount})`,
  );

  watcher.stopWatcher();
  cleanup();
  watcher._resetPendingDeliveriesForTesting();
});

// ── Test 6: in-flight gate is permissive on the trailing edge ────────────────
//
// Confirms the gate is not "sticky": once the in-flight count drops back to
// zero AND no other alive signal exists, the next escape-hatch evaluation
// flips dead as before. This protects against accidental over-correction
// where a one-shot in-flight blip would forever immunise the channel.
test('in-flight gate releases when tool finishes; subsequent burst still trips dead', { timeout: 30_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  cleanup();

  let inFlight = 1;
  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 0,
    getChannelCallbackRegisteredAt: () => 0,
    getToolCallsInFlight: () => inFlight,
  });

  const startedOk = await watcher.startWatcher(() => {}, async () => {}, { role: 'channel-owner' });
  assert.ok(startedOk);

  // Burst while in-flight=1: no dead-mark.
  for (let i = 0; i < 5; i += 1) {
    dropMessage(`releasing-${i}`);
    await new Promise((r) => setTimeout(r, 2_300));
  }
  watcher._processPendingDeliveriesForTesting();
  assert.ok(!watcher._isChannelMarkedDeadForTesting(), 'no dead-mark while in-flight=1');

  // Tool finishes; in-flight drops to 0. Drop one more message to keep the
  // window populated, then re-evaluate.
  inFlight = 0;
  dropMessage('releasing-trailing');
  await new Promise((r) => setTimeout(r, 2_300));
  watcher._processPendingDeliveriesForTesting();

  assert.ok(
    watcher._isChannelMarkedDeadForTesting(),
    'once tool finishes (in-flight=0) and burst window remains, dead-mark must trip on next eval',
  );

  watcher.stopWatcher();
  cleanup();
  watcher._resetPendingDeliveriesForTesting();
});

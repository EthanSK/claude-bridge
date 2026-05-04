/**
 * 4.0.x — Orphan-suicide check tests.
 *
 * Separate from the 5s 3-poll orphan watchdog. The orphan-suicide check
 * fires every 30s after a 60s grace period and exits when `process.ppid`
 * is 1 (reparented to launchd/init), regardless of whether the captured
 * original parent PID is still considered "alive" by kill(0).
 *
 * Cases:
 *   1. Healthy child (ppid > 1) — interval fires, no exit.
 *   2. Orphaned child (mock ppid === 1) AFTER grace — exits cleanly with code 0.
 *   3. Orphaned child (mock ppid === 1) DURING grace — does NOT exit yet.
 *
 * Note: `process.ppid` is a getter, so we cannot reassign it. We override
 * it from inside a tiny preload script (see `ppidPreload`) that runs
 * before the MCP server entrypoint via `node --import` so the spawned
 * agent-bridge child sees ppid===1 as if launchd had adopted it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '..', 'build', 'index.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer(home, env = {}, extraArgs = []) {
  const child = spawn(process.execPath, [...extraArgs, indexPath], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENT_BRIDGE_MACHINE_NAME: 'test-orphan-suicide',
      // Disable the OTHER parent-liveness paths so this test isolates the
      // orphan-suicide check. The 5s 3-poll watchdog and the parent-PID
      // probe both watch unrelated signals (kill(originalParentPid, 0),
      // stdin destroyed, lease takeover) and would otherwise terminate
      // the child before we can observe the suicide path.
      AGENT_BRIDGE_DISABLE_PARENT_CHECK: '1',
      AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG: '1',
      AGENT_BRIDGE_PERSONA: '',
      // The orphan-suicide check is independently controlled via
      // AGENT_BRIDGE_DISABLE_ORPHAN_SUICIDE; disabling the 3-poll watchdog
      // above does NOT also disable suicide (intentional — they're separate
      // concerns and tests for the suicide path want it left active).
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  child.stdout.resume();
  return child;
}

async function readEvents(home) {
  const logFile = join(home, '.agent-bridge', 'logs', 'agent-bridge.log');
  try {
    const raw = await readFile(logFile, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Preload module that overrides `process.ppid` to return 1 BEFORE
// build/index.js runs. We write it into the test home dir so each
// test gets its own copy and cleanup is straightforward.
async function writePpidPreload(home) {
  const preloadPath = join(home, 'ppid-preload.mjs');
  await writeFile(
    preloadPath,
    'Object.defineProperty(process, "ppid", { get: () => 1, configurable: true });\n',
    'utf8',
  );
  return preloadPath;
}

test('source-level wiring is present in shipped build', async () => {
  const indexSrc = await readFile(indexPath, 'utf8');
  assert.ok(
    indexSrc.includes('ORPHAN_SUICIDE_INTERVAL_MS'),
    'ORPHAN_SUICIDE_INTERVAL_MS constant must exist',
  );
  assert.ok(
    indexSrc.includes('ORPHAN_SUICIDE_GRACE_MS'),
    'ORPHAN_SUICIDE_GRACE_MS constant must exist',
  );
  assert.ok(
    /30_000|30000/.test(indexSrc.match(/ORPHAN_SUICIDE_INTERVAL_MS[\s\S]{0,200}/)?.[0] ?? ''),
    'orphan suicide interval must default to 30s',
  );
  assert.ok(
    /60_000|60000/.test(indexSrc.match(/ORPHAN_SUICIDE_GRACE_MS[\s\S]{0,200}/)?.[0] ?? ''),
    'orphan suicide grace must default to 60s',
  );
  assert.ok(
    indexSrc.includes("event: 'orphan_suicide.detected'"),
    'orphan_suicide.detected log event must be wired',
  );
  assert.ok(
    indexSrc.includes('process.ppid === 1'),
    'orphan suicide must check process.ppid === 1',
  );
  assert.ok(
    /shutdown\(['"`]orphan-suicide:/.test(indexSrc),
    'orphan suicide must call shutdown() (clean lease release), not bare process.exit()',
  );
  assert.ok(
    /orphanSuicide\s*[:.]?\s*[A-Za-z.]*unref\(\)/.test(indexSrc),
    'orphan-suicide interval must be unref()ed',
  );
});

test('case 1: healthy child (ppid > 1) does NOT exit', { timeout: 12_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-orphan-suicide-healthy-'));
  // Aggressive timing: grace=500ms, interval=500ms. With a real ppid
  // (parent === this test process) the suicide check must NEVER fire,
  // no matter how short the timing is.
  const server = startServer(home, {
    AGENT_BRIDGE_ORPHAN_SUICIDE_INTERVAL_MS: '500',
    AGENT_BRIDGE_ORPHAN_SUICIDE_GRACE_MS: '500',
  });
  try {
    const exited = await Promise.race([
      new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal }))),
      sleep(5_000).then(() => null),
    ]);
    assert.equal(
      exited,
      null,
      `healthy child must remain alive — got ${JSON.stringify(exited)}`,
    );
    const events = await readEvents(home);
    const detected = events.filter((e) => e.event === 'orphan_suicide.detected');
    assert.equal(
      detected.length,
      0,
      `orphan_suicide.detected must NOT fire for healthy ppid — got: ${JSON.stringify(detected.map((d) => d.context))}`,
    );
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('case 2: orphaned child (ppid === 1) AFTER grace exits cleanly', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-orphan-suicide-after-'));
  const preloadPath = await writePpidPreload(home);
  // grace=1s, interval=500ms. After 1s the next interval tick (≤500ms
  // later) should detect ppid===1 and call shutdown().
  const server = startServer(
    home,
    {
      AGENT_BRIDGE_ORPHAN_SUICIDE_INTERVAL_MS: '500',
      AGENT_BRIDGE_ORPHAN_SUICIDE_GRACE_MS: '1000',
    },
    ['--import', pathToFileURL(preloadPath).href],
  );
  try {
    const exited = await Promise.race([
      new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal }))),
      sleep(8_000).then(() => null),
    ]);
    assert.ok(
      exited !== null,
      'orphaned child (ppid=1) must exit after the grace period',
    );
    assert.equal(exited.code, 0, `orphan suicide must exit cleanly with code 0 — got ${JSON.stringify(exited)}`);
    const events = await readEvents(home);
    const detected = events.filter((e) => e.event === 'orphan_suicide.detected');
    assert.ok(
      detected.length >= 1,
      `orphan_suicide.detected must fire at least once — got events: ${JSON.stringify(events.map((e) => e.event))}`,
    );
    assert.equal(detected[0].context?.ppid, 1, 'logged ppid context must be 1');
    // Confirm the shutdown reason carries the orphan-suicide prefix.
    const shutdownEvent = events.find((e) => e.event === 'server.shutdown');
    assert.ok(
      shutdownEvent && /orphan-suicide/.test(shutdownEvent.context?.reason ?? ''),
      `server.shutdown reason must include orphan-suicide — got: ${JSON.stringify(shutdownEvent?.context)}`,
    );
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('case 3: orphaned child (ppid === 1) DURING grace does NOT exit yet', { timeout: 12_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-orphan-suicide-grace-'));
  const preloadPath = await writePpidPreload(home);
  // grace=5s, interval=200ms. We wait 2s then assert still alive +
  // no detected event yet — grace is protecting the child.
  const server = startServer(
    home,
    {
      AGENT_BRIDGE_ORPHAN_SUICIDE_INTERVAL_MS: '200',
      AGENT_BRIDGE_ORPHAN_SUICIDE_GRACE_MS: '5000',
    },
    ['--import', pathToFileURL(preloadPath).href],
  );
  try {
    const exited = await Promise.race([
      new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal }))),
      sleep(2_000).then(() => null),
    ]);
    assert.equal(
      exited,
      null,
      `child with ppid=1 must remain alive during grace window — got ${JSON.stringify(exited)}`,
    );
    const events = await readEvents(home);
    const detected = events.filter((e) => e.event === 'orphan_suicide.detected');
    assert.equal(
      detected.length,
      0,
      `orphan_suicide.detected must NOT fire during grace — got: ${JSON.stringify(detected.map((d) => d.context))}`,
    );
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

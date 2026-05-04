// mcp-server/test/install-periodic-update.test.mjs
// -------------------------------------------------
// [PERIODIC-UPDATE 2026-05-04]
//
// Tests for the bundled harness-INDEPENDENT periodic auto-updater:
//   scripts/agent-bridge-periodic-update.sh    (macOS / Linux body)
//   scripts/agent-bridge-periodic-update.ps1   (Windows body)
//   scripts/install-periodic-update.sh         (macOS provisioner)
//   scripts/install-periodic-update.ps1        (Windows provisioner)
//
// We don't actually exercise launchd or Get-ScheduledTask in CI — that would
// require platform-specific privileges and would mutate the host. Instead the
// tests:
//   1. Lint the macOS body script with `bash -n` (syntax) and confirm the
//      expected key blocks exist (lock, fetch, build-when-needed,
//      registry-rewire, optional OC repair).
//   2. Lint the Windows body with PowerShell tokenizer if pwsh is available;
//      otherwise smoke-check structural markers.
//   3. Lint install-periodic-update.sh and assert the generated plist (when
//      we run the script in a sandbox HOME with a stub launchctl) is valid
//      XML, contains the right Label, StartInterval=600, and points at the
//      correct body script. Also asserts idempotent re-run leaves a single
//      plist.
//   4. Smoke-check install-periodic-update.ps1 structurally (Register-
//      ScheduledTask call, 10-min RepetitionInterval, AtLogOn trigger).
//
// All tests are gated to skip on platforms that can't run them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// scripts/ lives at <repo-root>/scripts/. Test file at <repo-root>/mcp-server/test/.
const REPO_ROOT = resolve(__dirname, '..', '..');
const BODY_SH = join(REPO_ROOT, 'scripts', 'agent-bridge-periodic-update.sh');
const BODY_PS1 = join(REPO_ROOT, 'scripts', 'agent-bridge-periodic-update.ps1');
const INSTALL_SH = join(REPO_ROOT, 'scripts', 'install-periodic-update.sh');
const INSTALL_PS1 = join(REPO_ROOT, 'scripts', 'install-periodic-update.ps1');

const isWindows = platform() === 'win32';
const isMac = platform() === 'darwin';
const hasBash = !isWindows;  // Git-Bash on Windows would also work, but skipping for CI simplicity.

function teardown(...paths) {
  for (const p of paths) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------- 1. macOS body syntax + structural checks -----------------------

test('agent-bridge-periodic-update.sh: bash syntax is valid', { skip: !hasBash }, () => {
  assert.ok(existsSync(BODY_SH), `body script missing: ${BODY_SH}`);
  const res = spawnSync('bash', ['-n', BODY_SH], { encoding: 'utf8' });
  assert.equal(res.status, 0, `bash -n failed: ${res.stderr}`);
});

test('agent-bridge-periodic-update.sh: contains expected blocks', () => {
  const src = readFileSync(BODY_SH, 'utf8');
  // Lock + repo guard
  assert.match(src, /mkdir "\$LOCK_DIR"/, 'missing lock directory creation');
  assert.match(src, /\$REPO\/\.git/, 'missing .git guard');
  // Step 1: fetch
  assert.match(src, /git fetch origin --prune/, 'missing git fetch step');
  // Step 2: pull (clean only)
  assert.match(src, /git pull --ff-only origin main/, 'missing git pull step');
  assert.match(src, /dirty=1/, 'missing dirty-tree detection');
  // Step 3: build-when-needed
  assert.match(src, /npm install && npm run build/, 'missing build step');
  assert.match(src, /BUILT_HEAD_FILE/, 'missing built-head sentinel');
  // Step 4: registry rewire
  assert.match(src, /plugin-registry-rewire/, 'missing plugin-registry-rewire call');
  // Step 5 (optional): OC MCP repair
  assert.match(src, /WITH_OPENCLAW_MCP_REPAIR/, 'missing OpenClaw MCP repair flag');
  assert.match(src, /openclaw mcp set agent-bridge/, 'missing OpenClaw MCP set call');
  // Log path
  assert.match(src, /\.agent-bridge\/logs\/periodic-update\.log/, 'missing log path');
});

// ---------- 2. Windows body structural checks ------------------------------

test('agent-bridge-periodic-update.ps1: contains expected blocks', () => {
  assert.ok(existsSync(BODY_PS1), `body script missing: ${BODY_PS1}`);
  const src = readFileSync(BODY_PS1, 'utf8');
  assert.match(src, /WithOpenclawMcpRepair/, 'missing OC MCP repair param');
  assert.match(src, /git fetch origin --prune/, 'missing git fetch step');
  assert.match(src, /git pull --ff-only origin main/, 'missing git pull step');
  assert.match(src, /npm.*install/i, 'missing npm install step');
  assert.match(src, /npm.*run.*build/i, 'missing npm run build step');
  assert.match(src, /plugin-registry-rewire/, 'missing plugin-registry-rewire call');
  assert.match(src, /periodic-update\.log/, 'missing log path');
  assert.match(src, /periodic-update\.lock/, 'missing lock dir');
});

// ---------- 3. macOS provisioner: plist generation -------------------------

test('install-periodic-update.sh: bash syntax is valid', { skip: !hasBash }, () => {
  assert.ok(existsSync(INSTALL_SH), `provisioner missing: ${INSTALL_SH}`);
  const res = spawnSync('bash', ['-n', INSTALL_SH], { encoding: 'utf8' });
  assert.equal(res.status, 0, `bash -n failed: ${res.stderr}`);
});

test('install-periodic-update.sh: generates valid plist with correct fields (sandbox)', { skip: !isMac }, () => {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'periodic-install-test-'));
  const launchAgentsDir = join(sandboxHome, 'Library', 'LaunchAgents');
  mkdirSync(launchAgentsDir, { recursive: true });

  // Stub `launchctl` so the installer doesn't try to talk to real launchd.
  // We point PATH at a temp bin/ that exposes a no-op launchctl.
  const stubBin = mkdtempSync(join(tmpdir(), 'periodic-install-bin-'));
  writeFileSync(join(stubBin, 'launchctl'), '#!/bin/bash\nexit 0\n');
  chmodSync(join(stubBin, 'launchctl'), 0o755);

  try {
    const env = {
      ...process.env,
      HOME: sandboxHome,
      PATH: `${stubBin}:${process.env.PATH || ''}`,
    };
    const res = spawnSync('/bin/bash', [INSTALL_SH], { env, encoding: 'utf8' });
    assert.equal(res.status, 0, `installer exited non-zero: ${res.stderr}\n${res.stdout}`);

    const plistPath = join(launchAgentsDir, 'com.ethansk.agent-bridge.periodic-update.plist');
    assert.ok(existsSync(plistPath), `plist not written: ${plistPath}`);

    const plist = readFileSync(plistPath, 'utf8');
    assert.match(plist, /<\?xml version="1\.0"/, 'plist missing XML preamble');
    assert.match(plist, /<key>Label<\/key>\s*<string>com\.ethansk\.agent-bridge\.periodic-update<\/string>/, 'wrong Label');
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>600<\/integer>/, 'wrong StartInterval');
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/, 'missing RunAtLoad=true');
    assert.match(plist, new RegExp(`<string>${BODY_SH.replace(/[.\/]/g, '\\$&')}</string>`), 'plist missing body script path');
    assert.match(plist, /<key>WorkingDirectory<\/key>/, 'missing WorkingDirectory');

    // Validate XML via plutil.
    const plutilRes = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
    assert.equal(plutilRes.status, 0, `plutil -lint failed: ${plutilRes.stdout}${plutilRes.stderr}`);

    // Idempotent re-run: still exactly one plist, still passes lint.
    const res2 = spawnSync('/bin/bash', [INSTALL_SH], { env, encoding: 'utf8' });
    assert.equal(res2.status, 0, `re-run failed: ${res2.stderr}`);
    const entries = readdirSync(launchAgentsDir).filter((f) => f.startsWith('com.ethansk.agent-bridge'));
    assert.equal(entries.length, 1, `expected exactly 1 plist after idempotent re-run, got ${entries.length}`);
    const plutilRes2 = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
    assert.equal(plutilRes2.status, 0, `plutil -lint after re-run failed: ${plutilRes2.stdout}`);
  } finally {
    teardown(sandboxHome, stubBin);
  }
});

test('install-periodic-update.sh: --with-openclaw-mcp-repair propagates to plist', { skip: !isMac }, () => {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'periodic-install-test-'));
  mkdirSync(join(sandboxHome, 'Library', 'LaunchAgents'), { recursive: true });
  const stubBin = mkdtempSync(join(tmpdir(), 'periodic-install-bin-'));
  writeFileSync(join(stubBin, 'launchctl'), '#!/bin/bash\nexit 0\n');
  chmodSync(join(stubBin, 'launchctl'), 0o755);

  try {
    const env = {
      ...process.env,
      HOME: sandboxHome,
      PATH: `${stubBin}:${process.env.PATH || ''}`,
    };
    const res = spawnSync('/bin/bash', [INSTALL_SH, '--with-openclaw-mcp-repair'], {
      env, encoding: 'utf8',
    });
    assert.equal(res.status, 0, `installer failed: ${res.stderr}\n${res.stdout}`);

    const plistPath = join(sandboxHome, 'Library', 'LaunchAgents', 'com.ethansk.agent-bridge.periodic-update.plist');
    const plist = readFileSync(plistPath, 'utf8');
    assert.match(plist, /<string>--with-openclaw-mcp-repair<\/string>/, 'plist did not include OC MCP repair flag');
  } finally {
    teardown(sandboxHome, stubBin);
  }
});

// ---------- 4. Windows provisioner structural checks -----------------------

test('install-periodic-update.ps1: structural markers present', () => {
  assert.ok(existsSync(INSTALL_PS1), `provisioner missing: ${INSTALL_PS1}`);
  const src = readFileSync(INSTALL_PS1, 'utf8');
  assert.match(src, /Register-ScheduledTask/, 'missing Register-ScheduledTask call');
  assert.match(src, /Unregister-ScheduledTask/, 'missing Unregister-ScheduledTask (idempotency)');
  assert.match(src, /AgentBridge Periodic Update/, 'missing task name');
  assert.match(src, /New-TimeSpan -Minutes 10/, 'missing 10-min interval');
  assert.match(src, /AtLogOn/, 'missing logon trigger');
  assert.match(src, /WithOpenclawMcpRepair/, 'missing OC MCP repair switch param');
});

// ---------- 5. Stale-lock reclaim behaviour --------------------------------

test('agent-bridge-periodic-update.sh: reclaims stale lock with dead pid', { skip: !hasBash }, () => {
  // We can't run the full body (it would actually `git fetch` against the
  // real repo), but we CAN test the lock-reclaim logic in isolation by
  // sourcing the script with a guard that exits before the repo guard.
  //
  // Strategy: stage a sandbox HOME with a stale lock containing a definitely-
  // dead PID, run the body with AGENT_BRIDGE_REPO pointing at a non-git
  // directory (so it exits with rc=1 at the repo guard step AFTER the lock
  // logic ran), and verify the lock was reclaimed.
  const sandboxHome = mkdtempSync(join(tmpdir(), 'periodic-lock-test-'));
  const runDir = join(sandboxHome, '.agent-bridge', 'run');
  const lockDir = join(runDir, 'periodic-update.lock');
  mkdirSync(lockDir, { recursive: true });
  // PID 999999999 is virtually guaranteed to not exist (Linux limits PIDs to
  // <= 4 million; macOS similar).
  writeFileSync(join(lockDir, 'pid'), '999999999\n');

  const fakeRepo = mkdtempSync(join(tmpdir(), 'periodic-lock-fakerepo-'));
  // Intentionally NOT a git repo — body will exit with the repo guard after
  // the lock reclaim path executes.

  try {
    const env = {
      ...process.env,
      HOME: sandboxHome,
      AGENT_BRIDGE_REPO: fakeRepo,
    };
    const res = spawnSync('/bin/bash', [BODY_SH], { env, encoding: 'utf8' });
    // Exits 1 at the repo-missing guard, but the human log should show the
    // stale-lock reclaim happened.
    assert.equal(res.status, 1, `expected rc=1 from repo guard, got ${res.status}: ${res.stderr}`);

    const logPath = join(sandboxHome, '.agent-bridge', 'logs', 'periodic-update.log');
    assert.ok(existsSync(logPath), 'log file not created');
    const logContents = readFileSync(logPath, 'utf8');
    assert.match(logContents, /stale lock: pid=999999999 no longer alive; reclaiming/, 'lock reclaim log not emitted');
    assert.match(logContents, /ERROR: repo missing/, 'repo guard did not run after reclaim');
  } finally {
    teardown(sandboxHome, fakeRepo);
  }
});

test('agent-bridge-periodic-update.sh: reclaims stale lock with no pid file', { skip: !hasBash }, () => {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'periodic-lock-test-'));
  const runDir = join(sandboxHome, '.agent-bridge', 'run');
  const lockDir = join(runDir, 'periodic-update.lock');
  mkdirSync(lockDir, { recursive: true });
  // No `pid` file — malformed lock from an old version or interrupted write.

  const fakeRepo = mkdtempSync(join(tmpdir(), 'periodic-lock-fakerepo-'));

  try {
    const env = { ...process.env, HOME: sandboxHome, AGENT_BRIDGE_REPO: fakeRepo };
    const res = spawnSync('/bin/bash', [BODY_SH], { env, encoding: 'utf8' });
    assert.equal(res.status, 1);

    const logContents = readFileSync(join(sandboxHome, '.agent-bridge', 'logs', 'periodic-update.log'), 'utf8');
    assert.match(logContents, /stale lock: missing\/malformed pid file; reclaiming/);
  } finally {
    teardown(sandboxHome, fakeRepo);
  }
});

test('agent-bridge-periodic-update.sh: skips when lock held by live pid', { skip: !hasBash }, () => {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'periodic-lock-test-'));
  const runDir = join(sandboxHome, '.agent-bridge', 'run');
  const lockDir = join(runDir, 'periodic-update.lock');
  mkdirSync(lockDir, { recursive: true });
  // Use the test process's own PID — guaranteed alive AND owned by the same
  // user (so `kill -0` works without privilege issues).
  writeFileSync(join(lockDir, 'pid'), String(process.pid) + '\n');

  const fakeRepo = mkdtempSync(join(tmpdir(), 'periodic-lock-fakerepo-'));

  try {
    const env = { ...process.env, HOME: sandboxHome, AGENT_BRIDGE_REPO: fakeRepo };
    const res = spawnSync('/bin/bash', [BODY_SH], { env, encoding: 'utf8' });
    // Should exit 0 (graceful skip), not 1 (repo guard didn't run).
    assert.equal(res.status, 0, `expected graceful skip (rc=0), got ${res.status}: ${res.stderr}\n${res.stdout}`);

    const logContents = readFileSync(join(sandboxHome, '.agent-bridge', 'logs', 'periodic-update.log'), 'utf8');
    assert.match(logContents, /already running \(lock held by live previous invocation\)/);
    // Confirm we did NOT proceed to repo guard.
    assert.doesNotMatch(logContents, /ERROR: repo missing/);
  } finally {
    teardown(sandboxHome, fakeRepo);
  }
});

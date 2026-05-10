// mcp-server/test/check-update-migration.test.mjs
// ------------------------------------------------
// [AGENT-AWARE-UPDATE-NOTIFICATIONS 2026-05-04]
//
// Tests the migration-injection logic in scripts/check-update.sh:
//   - When origin/main introduces a new file under docs/migrations/<x>.md
//     between LOCAL_HEAD..ORIGIN_HEAD, the probe extracts the
//     "## Instructions for the agent receiving this update" section
//     verbatim and includes it in the [BRIDGE-UPDATE-AVAILABLE] message.
//   - When no migration files were added in the diff range, the body
//     omits the migration section.
//   - The README.md inside docs/migrations/ is not treated as a
//     migration doc.
//
// Strategy: build a self-contained sandbox repo, simulate a "local"
// clone behind a "remote" by checking out an older commit, run
// scripts/check-update.sh against that sandbox, and inspect the JSON
// payload it drops into ~/.agent-bridge/inbox/claude-code/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const CHECK_UPDATE_SH = join(REPO_ROOT, 'scripts', 'check-update.sh');

const isWindows = platform() === 'win32';

function git(cwd, args, env = {}) {
  const res = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${res.stdout}\n${res.stderr}`);
  }
  return res.stdout.trim();
}

function setupSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-mig-test-'));
  const remote = join(root, 'remote.git');
  const localRepo = join(root, 'local');
  const home = join(root, 'home');
  mkdirSync(remote, { recursive: true });
  mkdirSync(localRepo, { recursive: true });
  mkdirSync(home, { recursive: true });

  // Bare remote
  spawnSync('git', ['init', '--bare', '-b', 'main', remote], { encoding: 'utf8' });

  // Local clone
  git(localRepo, ['init', '-b', 'main']);
  git(localRepo, ['remote', 'add', 'origin', remote]);

  // Copy the production check-update.sh into the sandbox so the script
  // resolves REPO_ROOT to the sandbox repo (its `cd "$SCRIPT_DIR/.."`
  // logic walks one dir up from itself).
  const sandboxScripts = join(localRepo, 'scripts');
  mkdirSync(sandboxScripts, { recursive: true });
  cpSync(CHECK_UPDATE_SH, join(sandboxScripts, 'check-update.sh'));
  // No coord-helper in the sandbox — that's a separate concern.
  spawnSync('chmod', ['+x', join(sandboxScripts, 'check-update.sh')]);

  // Initial commit on local (any file)
  writeFileSync(join(localRepo, 'README.md'), '# sandbox\n');
  git(localRepo, ['add', '.']);
  git(localRepo, ['commit', '-m', 'initial']);
  git(localRepo, ['push', '-u', 'origin', 'main']);

  return { root, remote, localRepo, home };
}

function readDroppedMessage(home) {
  const inboxDir = join(home, '.agent-bridge', 'inbox', 'claude-code');
  const files = readdirSync(inboxDir);
  const json = files.find((f) => f.endsWith('.json'));
  if (!json) {
    throw new Error(`no JSON file dropped in ${inboxDir}; got: ${files.join(', ')}`);
  }
  return JSON.parse(readFileSync(join(inboxDir, json), 'utf8'));
}

function runCheckUpdate(localRepo, home) {
  // The script uses HOME for the inbox + sentinel. Pin it so we don't
  // touch the developer's real ~/.agent-bridge/.
  const env = {
    HOME: home,
    AGENT_BRIDGE_AUTO_UPDATE_CHECK: '1',
    PATH: process.env.PATH,
  };
  const res = spawnSync('bash', [join(localRepo, 'scripts', 'check-update.sh'), '--force', '--target=claude-code'], {
    cwd: localRepo,
    env,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`check-update.sh exit=${res.status}\n${res.stdout}\n${res.stderr}`);
  }
  return res;
}

test(
  'migration extraction: instructions section injected into bridge message body',
  { skip: isWindows ? 'bash-only sandbox' : false },
  () => {
    const { root, localRepo, home } = setupSandbox();
    try {
      // On the remote (via local push), add a migration doc.
      const migDir = join(localRepo, 'docs', 'migrations');
      mkdirSync(migDir, { recursive: true });
      writeFileSync(
        join(migDir, '4.0.0-example.md'),
        [
          '# 4.0.0 example migration',
          '',
          '## Context',
          '',
          'Some background paragraph about why.',
          '',
          '## Instructions for the agent receiving this update',
          '',
          '1. Audit `~/.openclaw/openclaw.json` for stale `replyVia` keys.',
          '2. Restart the OpenClaw gateway with `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`.',
          '3. Confirm the v3 plugin loaded by tailing the gateway log.',
          '',
          '## Verification',
          '',
          'Tail the log and grep for `Channel v3`.',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(migDir, 'README.md'),
        '# migrations dir\n\nConvention doc — should NOT be treated as a migration.\n## Instructions for the agent receiving this update\n\nIGNORED — this is the convention README.\n',
      );
      git(localRepo, ['add', '.']);
      git(localRepo, ['commit', '-m', 'feat: add 4.0.0 migration doc']);
      git(localRepo, ['push', 'origin', 'main']);

      // Roll the local checkout back so origin is strictly ahead.
      git(localRepo, ['reset', '--hard', 'HEAD~1']);

      runCheckUpdate(localRepo, home);
      const payload = readDroppedMessage(home);

      assert.match(payload.content, /\[BRIDGE-UPDATE-AVAILABLE\]/);
      assert.match(payload.content, /Agent migration instructions/);
      assert.match(payload.content, /docs\/migrations\/4\.0\.0-example\.md/);
      assert.match(payload.content, /Audit `~\/\.openclaw\/openclaw\.json`/);
      assert.match(payload.content, /Restart the OpenClaw gateway/);
      // The README.md "instructions" section MUST NOT leak in.
      assert.doesNotMatch(payload.content, /IGNORED — this is the convention README/);
      // The "Context" / "Verification" sections of the migration MUST NOT
      // leak — only the Instructions section is injected verbatim.
      assert.doesNotMatch(payload.content, /Some background paragraph about why\./);
      assert.doesNotMatch(payload.content, /Tail the log and grep for `Channel v3`\./);

      // Changed-files manifest is also present.
      assert.match(payload.content, /Changed files:/);
      assert.match(payload.content, /docs\/migrations\/4\.0\.0-example\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'no migration files in diff range → body omits migration section',
  { skip: isWindows ? 'bash-only sandbox' : false },
  () => {
    const { root, localRepo, home } = setupSandbox();
    try {
      // Add a regular non-migration file.
      writeFileSync(join(localRepo, 'feature.txt'), 'just a feature\n');
      git(localRepo, ['add', '.']);
      git(localRepo, ['commit', '-m', 'feat: random feature']);
      git(localRepo, ['push', 'origin', 'main']);
      git(localRepo, ['reset', '--hard', 'HEAD~1']);

      runCheckUpdate(localRepo, home);
      const payload = readDroppedMessage(home);

      assert.match(payload.content, /\[BRIDGE-UPDATE-AVAILABLE\]/);
      assert.doesNotMatch(payload.content, /Agent migration instructions/);
      // Standard receiver-coord guidance still present.
      assert.match(payload.content, /Receiver subagents MUST coordinate/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('source/destination agent-bridge versions are included in channel notification meta', () => {
  // [AGENT-BRIDGE-DUAL-VERSION-RELAY 2026-05-10]
  // Relay scaffolds should expose both the sender-side version, when the peer
  // included it, and this receiver's local version. The legacy
  // `agent_bridge_version` alias remains as the destination/local version.
  const indexSrc = readFileSync(
    resolve(__dirname, '..', 'src', 'index.ts'),
    'utf8',
  );
  assert.ok(
    indexSrc.includes('source_agent_bridge_version: message.sourceAgentBridgeVersion'),
    "channel notification meta must include source_agent_bridge_version when known",
  );
  assert.ok(
    indexSrc.includes('destination_agent_bridge_version: VERSION'),
    "channel notification meta must include destination_agent_bridge_version: VERSION",
  );
  assert.ok(
    indexSrc.includes('agent_bridge_version: VERSION'),
    "channel notification meta must keep legacy `agent_bridge_version: VERSION`",
  );
  // The doc reference should still point at the relay-to-user doc.
  assert.ok(
    indexSrc.includes('docs/relay-to-user.md'),
    "channel notification meta comment should reference docs/relay-to-user.md",
  );
});

test(
  'changed-files truncation note appears for >30 files',
  { skip: isWindows ? 'bash-only sandbox' : false },
  () => {
    const { root, localRepo, home } = setupSandbox();
    try {
      // Add 35 files in a single commit so the truncation note kicks in.
      for (let i = 0; i < 35; i += 1) {
        writeFileSync(join(localRepo, `f${i}.txt`), `file ${i}\n`);
      }
      git(localRepo, ['add', '.']);
      git(localRepo, ['commit', '-m', 'feat: 35-file rollout']);
      git(localRepo, ['push', 'origin', 'main']);
      git(localRepo, ['reset', '--hard', 'HEAD~1']);

      runCheckUpdate(localRepo, home);
      const payload = readDroppedMessage(home);
      assert.match(payload.content, /Changed files:/);
      assert.match(payload.content, /\(showing 30 of 35 changed files\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

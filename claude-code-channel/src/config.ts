/**
 * Configuration constants for the agent-bridge claude-code-channel plugin.
 *
 * This is a copy/paste subset of mcp-server/src/config.ts. The two packages
 * deliberately duplicate this small surface (paths, target validation, prune
 * defaults) instead of sharing it through a workspace package — it mirrors
 * the openclaw-channel zero-dep philosophy and keeps the channel plugin
 * self-contained so the plugin host can launch it without coordinating with
 * a workspace install. See docs/3.6.0-channel-plugin-migration.md §5.4.
 *
 * Wire-format compatibility: every constant here MUST match mcp-server's
 * config.ts byte-for-byte. 3.5.x mcp-server (channel-owner) and 3.6.x
 * claude-code-channel coexist by sharing the same on-disk lease file at
 * `~/.agent-bridge/locks/claude-code.watcher-lock.json`. If the path changes
 * here, lease arbitration breaks during rollout.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BRIDGE_DIR = join(homedir(), '.agent-bridge');
export const INBOX_DIR = join(BRIDGE_DIR, 'inbox');
export const LOGS_DIR = join(BRIDGE_DIR, 'logs');
export const LOCKS_DIR = join(BRIDGE_DIR, 'locks');
export const FAILED_DIR = join(INBOX_DIR, '.failed');
export const ARCHIVE_DIR = join(INBOX_DIR, '.archive');
export const PROCESSED_FILE = join(INBOX_DIR, '.processed');
export const DELIVERED_FILE = join(INBOX_DIR, '.delivered');

/**
 * Per-harness/per-target subdir under INBOX_DIR. The claude-code-channel
 * plugin only watches the `claude-code` branch — openclaw and any future
 * harnesses watch their own subdirs independently.
 */
export const CLAUDE_CODE_TARGET = 'claude-code';

/** Per-target inbox subdir. */
export function inboxSubdir(target: string): string {
  return join(INBOX_DIR, target);
}

/** Per-target archive subdir. */
export function archiveSubdir(target: string): string {
  return join(ARCHIVE_DIR, target);
}

/** Per-target failed subdir. */
export function failedSubdir(target: string): string {
  return join(FAILED_DIR, target);
}

/**
 * Validate a target string. Allowed chars: Unicode letters + Unicode digits +
 * `_`, `.`, `-`, `/`. Control chars, spaces, and filesystem-nasties rejected.
 */
export function isValidTarget(target: string): boolean {
  if (!target || typeof target !== 'string') return false;
  if (target.length > 256) return false;
  if (target.includes('..')) return false;
  if (target.startsWith('/') || target.endsWith('/')) return false;
  if (target.includes('//')) return false;
  const segmentPattern = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_\.-]*[\p{L}\p{N}_])?$/u;
  return target.split('/').every((segment) => segmentPattern.test(segment));
}

export const PROCESSED_FILE_MAX_SIZE = 512 * 1024;

/** TTL fallback (kept identical to mcp-server). */
export const DEFAULT_TTL_SECONDS = parseInt(
  process.env.BRIDGE_DEFAULT_TTL ?? '86400',
  10,
);

export function ensureDirectories(): void {
  for (const dir of [
    BRIDGE_DIR,
    INBOX_DIR,
    LOGS_DIR,
    LOCKS_DIR,
    FAILED_DIR,
    ARCHIVE_DIR,
    inboxSubdir(CLAUDE_CODE_TARGET),
    archiveSubdir(CLAUDE_CODE_TARGET),
    failedSubdir(CLAUDE_CODE_TARGET),
  ]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

/**
 * Get the local machine name. Mirrors mcp-server's logic — env override,
 * pinned name file, identity-keypath inference, hostname fallback.
 */
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const MACHINE_NAME_FILE = join(BRIDGE_DIR, 'machine-name');
const IDENTITY_FILE = join(BRIDGE_DIR, '.identity');

function readNonEmptyFile(path: string): string {
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function machineNameFromIdentity(identityPath: string): string {
  const keyPath = readNonEmptyFile(identityPath);
  if (!keyPath) return '';
  const base = basename(expandHome(keyPath));
  if (!base.startsWith('agent-bridge_')) return '';
  return base.slice('agent-bridge_'.length).trim();
}

function normalizeHostname(value: string): string {
  return value.trim().replace(/\.local$/i, '');
}

export function getLocalMachineName(): string {
  const override = process.env.AGENT_BRIDGE_MACHINE_NAME?.trim();
  if (override) return override;

  const pinnedName = readNonEmptyFile(MACHINE_NAME_FILE);
  if (pinnedName) return pinnedName;

  const identityName = machineNameFromIdentity(IDENTITY_FILE);
  if (identityName) return identityName;

  return normalizeHostname(hostname());
}

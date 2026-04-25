/**
 * Inbox state — delivered/processed ledgers and in-memory cache for the
 * claude-code-channel watcher.
 *
 * This is a slimmed copy of mcp-server/src/inbox.ts: we keep the
 * delivered-id ledger (so the watcher doesn't re-emit a channel notification
 * for messages already pushed) and the cache invalidation hooks the watcher
 * relies on. We DROP outbound send paths (`sendMessage`, `sendLocalMessage`,
 * `consumeInbox`, prune timers, outbox handling) — those belong in the
 * tools-only mcp-server and have no place in a channel-only process.
 *
 * Wire format: BridgeMessage shape is byte-compatible with mcp-server's
 * BridgeMessage. The .delivered ledger file path is shared with mcp-server
 * so a tools-only mcp-server's `bridge_inbox_stats` can read it.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  ARCHIVE_DIR,
  CLAUDE_CODE_TARGET,
  DELIVERED_FILE,
  FAILED_DIR,
  INBOX_DIR,
  PROCESSED_FILE,
  PROCESSED_FILE_MAX_SIZE,
  archiveSubdir,
  failedSubdir,
  inboxSubdir,
} from './config.js';
import { logEvent } from './log.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BridgeMessage {
  id: string;
  from: string;
  to: string;
  type: 'message' | 'command' | 'response' | 'reply';
  content: string;
  timestamp: string;
  replyTo: string | null;
  ttl?: number;
  target?: string;
  fromTarget?: string;
}

// ── Per-target paths (claude-code only — this plugin's branch) ───────────────

export const CLAUDE_CODE_INBOX_DIR = inboxSubdir(CLAUDE_CODE_TARGET);
export const CLAUDE_CODE_ARCHIVE_DIR = archiveSubdir(CLAUDE_CODE_TARGET);
export const CLAUDE_CODE_FAILED_DIR = failedSubdir(CLAUDE_CODE_TARGET);

// ── Internal state ───────────────────────────────────────────────────────────

let pendingFiles = new Set<string>();
let cacheInitialized = false;
let cacheDirty = true;

let processedIds = new Set<string>();
let deliveredIds = new Set<string>();

let _watcherBackend: 'polling' | 'unknown' = 'unknown';
let _watcherHealthy = false;

// ── Directory helpers ────────────────────────────────────────────────────────

export function ensureInboxDirs(): void {
  for (const dir of [
    INBOX_DIR,
    FAILED_DIR,
    ARCHIVE_DIR,
    CLAUDE_CODE_INBOX_DIR,
    CLAUDE_CODE_ARCHIVE_DIR,
    CLAUDE_CODE_FAILED_DIR,
  ]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

// ── Watcher status ───────────────────────────────────────────────────────────

export function setWatcherStatus(
  backend: 'polling' | 'unknown',
  healthy: boolean,
): void {
  _watcherBackend = backend;
  _watcherHealthy = healthy;
}

export function getWatcherStatus(): { backend: 'polling' | 'unknown'; healthy: boolean } {
  return { backend: _watcherBackend, healthy: _watcherHealthy };
}

// ── Cache invalidation ───────────────────────────────────────────────────────

export function invalidateCache(): void {
  cacheDirty = true;
}

export function notifyNewFiles(fileNames: string[]): void {
  for (const f of fileNames) {
    if (f.endsWith('.json')) {
      pendingFiles.add(f);
    }
  }
}

// ── Processed-ID tracking (kept for forward-compat with mcp-server) ──────────

function loadProcessedIds(): void {
  processedIds.clear();
  if (!existsSync(PROCESSED_FILE)) return;
  try {
    const raw = readFileSync(PROCESSED_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      const id = line.trim();
      if (id) processedIds.add(id);
    }
  } catch {
    /* ignore — empty/missing is fine */
  }
}

// ── Delivered-ID tracking (channel notification dedup) ──────────────────────

function loadDeliveredIds(): void {
  deliveredIds.clear();
  if (!existsSync(DELIVERED_FILE)) return;
  try {
    const raw = readFileSync(DELIVERED_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      const id = line.trim();
      if (id) deliveredIds.add(id);
    }
  } catch {
    /* ignore */
  }
}

export function isDelivered(id: string): boolean {
  return deliveredIds.has(id);
}

export function markDelivered(id: string): void {
  deliveredIds.add(id);
  try {
    appendFileSync(DELIVERED_FILE, id + '\n');
    rotateDeliveredFileIfNeeded();
  } catch (err) {
    logEvent({
      event: 'inbox.mark_delivered_failed',
      level: 'warn',
      msg: `Failed to append delivered ID ${id}`,
      context: { id, error: String(err) },
    });
  }
}

function rotateDeliveredFileIfNeeded(): void {
  try {
    if (!existsSync(DELIVERED_FILE)) return;
    const stat = statSync(DELIVERED_FILE);
    if (stat.size > PROCESSED_FILE_MAX_SIZE) {
      const ids = Array.from(deliveredIds);
      const keepCount = Math.floor(ids.length / 2);
      const keep = ids.slice(ids.length - keepCount);
      deliveredIds = new Set(keep);
      writeFileSync(DELIVERED_FILE, keep.join('\n') + '\n', { mode: 0o600 });
      logEvent({
        event: 'inbox.delivered_file_rotated',
        msg: `Rotated .delivered file: kept ${keepCount} of ${ids.length} IDs`,
        context: { kept: keepCount, total: ids.length },
      });
    }
  } catch {
    /* ignore */
  }
}

// ── Cache refresh ────────────────────────────────────────────────────────────

export function refreshCacheIfNeeded(): void {
  if (cacheInitialized && !cacheDirty) return;
  pendingFiles.clear();
  try {
    if (existsSync(CLAUDE_CODE_INBOX_DIR)) {
      const files = readdirSync(CLAUDE_CODE_INBOX_DIR)
        .filter((f) => f.endsWith('.json'));
      for (const f of files) pendingFiles.add(f);
    }
  } catch {
    /* ignore */
  }
  cacheInitialized = true;
  cacheDirty = false;
}

// ── Initialization ───────────────────────────────────────────────────────────

export function initInbox(): void {
  ensureInboxDirs();
  loadProcessedIds();
  loadDeliveredIds();
  refreshCacheIfNeeded();
  logEvent({
    event: 'inbox.initialized',
    msg: 'Inbox state initialized (claude-code-channel)',
    context: {
      processed_ids: processedIds.size,
      delivered_ids: deliveredIds.size,
    },
  });
}

export function shutdownInbox(): void {
  // No prune timer in this slim version. Kept for symmetry with mcp-server.
  logEvent({ event: 'inbox.shutdown', msg: 'Inbox state shut down' });
}

// Helpers used by watcher.ts -------------------------------------------------

export { unlinkSync, renameSync };

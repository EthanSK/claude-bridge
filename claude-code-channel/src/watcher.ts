/**
 * Inbox watcher for the agent-bridge claude-code-channel plugin.
 *
 * This is a port of mcp-server/src/watcher.ts adapted for the long-lived
 * channel-plugin process. The polling loop, lease arbitration, archive /
 * failed handling, and channel-notification callback are byte-compatible
 * with mcp-server 3.5.x — they share the same on-disk lease file at
 * `~/.agent-bridge/locks/claude-code.watcher-lock.json` so a 3.5.x peer
 * and a 3.6.x channel plugin coexist via lease arbitration during rollout.
 *
 * Polling-only (2s interval). No external dependencies. Identical to
 * mcp-server/src/watcher.ts header note.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CLAUDE_CODE_TARGET,
  LOCKS_DIR,
  archiveSubdir,
  failedSubdir,
  inboxSubdir,
  isValidTarget,
} from './config.js';
import {
  invalidateCache,
  isDelivered,
  markDelivered,
  notifyNewFiles,
  setWatcherStatus,
} from './inbox.js';
import type { BridgeMessage } from './inbox.js';
import { logEvent } from './log.js';

const CLAUDE_CODE_INBOX_DIR = inboxSubdir(CLAUDE_CODE_TARGET);
const CLAUDE_CODE_ARCHIVE_DIR = archiveSubdir(CLAUDE_CODE_TARGET);
const CLAUDE_CODE_FAILED_DIR = failedSubdir(CLAUDE_CODE_TARGET);
const INBOX_DIR_LOCAL = CLAUDE_CODE_INBOX_DIR;

type MessageCallback = (files: string[]) => void;

/**
 * Callback invoked with a parsed BridgeMessage when a new inbox file arrives.
 * Used to push channel notifications into the running Claude session.
 */
export type ChannelNotifyCallback = (message: BridgeMessage) => void | Promise<void>;

type WatcherLeaseFile = {
  pid: number;
  target: string;
  role: string;
  token: string;
  startedAt: number;
  updatedAt: number;
};

type WatcherLeaseState = {
  filePath: string;
  heartbeat: ReturnType<typeof setInterval>;
  meta: WatcherLeaseFile;
};

type WatcherLeaseAcquireResult = 'acquired' | 'busy' | 'failed';

let pollInterval: ReturnType<typeof setInterval> | null = null;
let knownFiles = new Set<string>();
let watcherLease: WatcherLeaseState | null = null;
let watcherLeaseRenewFailures = 0;
let standbyRetryTimer: ReturnType<typeof setTimeout> | null = null;
let savedMessageCallback: MessageCallback | null = null;
let savedWatcherRole = 'channel-owner';

const KNOWN_FILES_MAX = 2000;
const WATCHER_LEASE_STALE_MS = 15_000;
const WATCHER_LEASE_HEARTBEAT_MS = 5_000;
const WATCHER_LEASE_MAX_RENEW_FAILURES = 3;
const WATCHER_STANDBY_RETRY_MS = 2_000;
const DEFAULT_CHANNEL_NOTIFY_TIMEOUT_MS = 10_000;

function addKnownFile(name: string): void {
  if (knownFiles.has(name)) return;
  if (knownFiles.size >= KNOWN_FILES_MAX) {
    const first = knownFiles.values().next().value;
    if (first !== undefined) knownFiles.delete(first);
  }
  knownFiles.add(name);
}

const currentBackend: 'polling' = 'polling';

let savedChannelCallback: ChannelNotifyCallback | null = null;

function channelNotifyTimeoutMs(): number {
  const raw = process.env.AGENT_BRIDGE_CHANNEL_NOTIFY_TIMEOUT_MS;
  if (!raw) return DEFAULT_CHANNEL_NOTIFY_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_CHANNEL_NOTIFY_TIMEOUT_MS;
  return Math.min(parsed, 120_000);
}

function withChannelNotifyTimeout<T>(promise: Promise<T>, msgId: string): Promise<T> {
  const timeoutMs = channelNotifyTimeoutMs();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const err = new Error(
        `Channel notification for ${msgId} did not settle within ${timeoutMs}ms`,
      );
      (err as Error & { code?: string }).code = 'AGENT_BRIDGE_CHANNEL_NOTIFY_TIMEOUT';
      reject(err);
    }, timeoutMs);
    timeout.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function watcherLeasePath(target: string): string {
  const safeTarget = target.replaceAll('/', '__');
  return join(LOCKS_DIR, `${safeTarget}.watcher-lock.json`);
}

function readWatcherLease(filePath: string): WatcherLeaseFile | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WatcherLeaseFile>;
    if (!parsed || typeof parsed !== 'object') return null;
    const pid = Number(parsed.pid);
    const startedAt = Number(parsed.startedAt);
    const updatedAt = Number(parsed.updatedAt);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (typeof parsed.target !== 'string' || !parsed.target) return null;
    if (typeof parsed.role !== 'string' || !parsed.role) return null;
    if (typeof parsed.token !== 'string' || !parsed.token) return null;
    if (!Number.isFinite(startedAt) || !Number.isFinite(updatedAt)) return null;
    return {
      pid,
      target: parsed.target,
      role: parsed.role,
      token: parsed.token,
      startedAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code !== 'ESRCH';
  }
}

function watcherLeaseIsStale(filePath: string, lease: WatcherLeaseFile): boolean {
  if (!pidIsAlive(lease.pid)) return true;
  try {
    const stats = statSync(filePath);
    const lastUpdated = Math.max(Number(lease.updatedAt) || 0, stats.mtimeMs);
    return Date.now() - lastUpdated > WATCHER_LEASE_STALE_MS;
  } catch {
    return true;
  }
}

function clearWatcherLeaseState(): void {
  if (watcherLease?.heartbeat) {
    clearInterval(watcherLease.heartbeat);
  }
  watcherLease = null;
  watcherLeaseRenewFailures = 0;
}

function releaseWatcherLease(): void {
  if (!watcherLease) return;
  const { filePath, meta } = watcherLease;
  clearWatcherLeaseState();
  try {
    const current = readWatcherLease(filePath);
    if (current?.token === meta.token && existsSync(filePath)) {
      unlinkSync(filePath);
      logEvent({
        event: 'watcher.lease_released',
        msg: `Watcher lease released for ${meta.target}`,
        context: { target: meta.target, pid: process.pid, role: meta.role },
      });
    }
  } catch (err) {
    logEvent({
      event: 'watcher.lease_release_failed',
      level: 'warn',
      msg: `Watcher: failed to release lease ${filePath}`,
      context: { error: String(err) },
    });
  }
}

function stopPollingForLeaseLoss(reason: string): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  clearWatcherLeaseState();
  setWatcherStatus(currentBackend, false);
  logEvent({
    event: 'watcher.lease_lost',
    level: 'warn',
    msg: `Watcher lease lost for ${CLAUDE_CODE_TARGET}`,
    context: { reason, pid: process.pid, target: CLAUDE_CODE_TARGET },
  });
  if (savedMessageCallback) {
    scheduleStandbyRetry(savedMessageCallback, savedWatcherRole);
  }
}

function renewWatcherLease(): void {
  if (!watcherLease) return;
  try {
    const current = readWatcherLease(watcherLease.filePath);
    if (!current || current.token !== watcherLease.meta.token) {
      stopPollingForLeaseLoss('lock file replaced by another owner');
      return;
    }
    watcherLease.meta.updatedAt = Date.now();
    writeFileSync(watcherLease.filePath, JSON.stringify(watcherLease.meta, null, 2));
    watcherLeaseRenewFailures = 0;
    setWatcherStatus(currentBackend, true);
  } catch (err) {
    watcherLeaseRenewFailures += 1;
    setWatcherStatus(currentBackend, false);
    logEvent({
      event: 'watcher.heartbeat_failed',
      level: 'warn',
      msg: `Watcher lease heartbeat failed for ${CLAUDE_CODE_TARGET}`,
      context: {
        target: CLAUDE_CODE_TARGET,
        pid: process.pid,
        failures: watcherLeaseRenewFailures,
        maxFailures: WATCHER_LEASE_MAX_RENEW_FAILURES,
        error: String(err),
      },
    });
    if (watcherLeaseRenewFailures >= WATCHER_LEASE_MAX_RENEW_FAILURES) {
      stopPollingForLeaseLoss('lease heartbeat write failures');
    }
  }
}

function tryAcquireWatcherLease(role: string): WatcherLeaseAcquireResult {
  mkdirSync(LOCKS_DIR, { recursive: true, mode: 0o700 });
  const filePath = watcherLeasePath(CLAUDE_CODE_TARGET);
  const now = Date.now();
  const meta: WatcherLeaseFile = {
    pid: process.pid,
    target: CLAUDE_CODE_TARGET,
    role,
    token: `${process.pid}-${now}-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: now,
    updatedAt: now,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(filePath, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(meta, null, 2));
      } finally {
        closeSync(fd);
      }
      const heartbeat = setInterval(renewWatcherLease, WATCHER_LEASE_HEARTBEAT_MS);
      // NOTE: heartbeat is NOT unref'ed for the channel-plugin process. The
      // whole point of claude-code-channel is to be the long-lived channel
      // owner; the lease heartbeat must keep the loop alive across idle
      // gaps. mcp-server (tools-only) intentionally unref'd this for the
      // opposite reason. See docs/3.6.0-channel-plugin-migration.md §3.2 D.
      watcherLease = { filePath, heartbeat, meta };
      logEvent({
        event: 'watcher.lease_acquired',
        msg: `Watcher lease acquired for ${meta.target}`,
        context: { target: meta.target, role, pid: process.pid },
      });
      return 'acquired';
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'EEXIST') {
        logEvent({
          event: 'watcher.lease_acquire_error',
          level: 'error',
          msg: `Watcher: failed to acquire lease ${filePath}`,
          context: { error: String(err) },
        });
        return 'failed';
      }
      const existing = readWatcherLease(filePath);
      if (!existing) {
        try {
          unlinkSync(filePath);
          continue;
        } catch (unlinkErr) {
          logEvent({
            event: 'watcher.lease_acquire_unlink_failed',
            level: 'warn',
            msg: `Watcher: could not remove malformed lease ${filePath}`,
            context: { error: String(unlinkErr) },
          });
          return 'failed';
        }
      }
      if (!watcherLeaseIsStale(filePath, existing)) {
        logEvent({
          event: 'watcher.lease_busy',
          level: 'warn',
          msg: `Watcher lease busy for ${CLAUDE_CODE_TARGET}`,
          context: {
            target: CLAUDE_CODE_TARGET,
            holderPid: existing.pid,
            holderRole: existing.role,
            pid: process.pid,
            role,
          },
        });
        return 'busy';
      }
      try {
        unlinkSync(filePath);
        logEvent({
          event: 'watcher.lease_stolen',
          level: 'warn',
          msg: `Removed stale watcher lease for ${CLAUDE_CODE_TARGET}`,
          context: {
            target: CLAUDE_CODE_TARGET,
            stalePid: existing.pid,
            staleRole: existing.role,
            pid: process.pid,
            role,
          },
        });
      } catch (unlinkErr) {
        logEvent({
          event: 'watcher.lease_stolen_unlink_failed',
          level: 'warn',
          msg: `Watcher: failed to remove stale lease ${filePath}`,
          context: { error: String(unlinkErr) },
        });
        return 'failed';
      }
    }
  }

  return 'failed';
}

function clearStandbyRetryTimer(): void {
  if (standbyRetryTimer) {
    clearTimeout(standbyRetryTimer);
    standbyRetryTimer = null;
  }
}

function activateWatcher(callback: MessageCallback): void {
  initKnownFiles();
  startPolling(callback);
}

function scheduleStandbyRetry(callback: MessageCallback, role: string): void {
  savedMessageCallback = callback;
  savedWatcherRole = role;
  if (standbyRetryTimer || pollInterval || watcherLease) return;

  const retry = () => {
    standbyRetryTimer = null;
    if (pollInterval || watcherLease) return;
    const result = tryAcquireWatcherLease(savedWatcherRole);
    if (result === 'acquired') {
      logEvent({
        event: 'watcher.standby_promoted',
        level: 'warn',
        msg: `Watcher standby promoted for ${CLAUDE_CODE_TARGET}`,
        context: { target: CLAUDE_CODE_TARGET, pid: process.pid, role: savedWatcherRole },
      });
      activateWatcher(callback);
      void replayUndeliveredMessages();
      return;
    }
    if (result === 'failed') {
      logEvent({
        event: 'watcher.standby_retry_failed',
        level: 'warn',
        msg: `Watcher standby: lease acquisition failed for ${CLAUDE_CODE_TARGET}`,
        context: { retryMs: WATCHER_STANDBY_RETRY_MS },
      });
    }
    standbyRetryTimer = setTimeout(retry, WATCHER_STANDBY_RETRY_MS);
    // Standby retries are unref'd — they should never keep the loop alive on
    // their own. The lease holder owns liveness via its lease heartbeat.
    standbyRetryTimer.unref?.();
  };

  logEvent({
    event: 'watcher.standby_retry_scheduled',
    level: 'warn',
    msg: `Watcher standby retry scheduled for ${CLAUDE_CODE_TARGET}`,
    context: { target: CLAUDE_CODE_TARGET, pid: process.pid, role },
  });
  standbyRetryTimer = setTimeout(retry, WATCHER_STANDBY_RETRY_MS);
  standbyRetryTimer.unref?.();
}

function quarantineFailed(fileName: string, reason: string): void {
  const filePath = join(INBOX_DIR_LOCAL, fileName);
  try {
    if (!existsSync(CLAUDE_CODE_FAILED_DIR)) {
      mkdirSync(CLAUDE_CODE_FAILED_DIR, { recursive: true, mode: 0o700 });
    }
    renameSync(filePath, join(CLAUDE_CODE_FAILED_DIR, fileName));
    knownFiles.delete(fileName);
    invalidateCache();
    logEvent({
      event: 'watcher.message_quarantined',
      level: 'warn',
      msg: `Channel: moved ${fileName} to .failed/${CLAUDE_CODE_TARGET}/`,
      context: { fileName, reason },
    });
  } catch (err) {
    logEvent({
      event: 'watcher.message_quarantine_failed',
      level: 'error',
      msg: `Channel: failed to quarantine ${fileName}`,
      context: { fileName, error: String(err) },
    });
  }
}

function archiveDeliveredMessage(fileName: string, id: string, reason: string): void {
  const filePath = join(INBOX_DIR_LOCAL, fileName);
  try {
    if (!existsSync(filePath)) {
      knownFiles.delete(fileName);
      invalidateCache();
      return;
    }
    if (!existsSync(CLAUDE_CODE_ARCHIVE_DIR)) {
      mkdirSync(CLAUDE_CODE_ARCHIVE_DIR, { recursive: true, mode: 0o700 });
    }
    const stamped = `${new Date().toISOString().replace(/[:.]/g, '-')}_${fileName}`;
    renameSync(filePath, join(CLAUDE_CODE_ARCHIVE_DIR, stamped));
    knownFiles.delete(fileName);
    invalidateCache();
  } catch (err) {
    logEvent({
      event: 'watcher.archive_failed',
      level: 'warn',
      msg: `Channel: failed to archive delivered message ${id} (${fileName})`,
      context: { id, fileName, reason, error: String(err) },
    });
  }
}

function emitChannelNotification(fileName: string): void {
  if (!savedChannelCallback) return;

  const filePath = join(INBOX_DIR_LOCAL, fileName);
  try {
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, 'utf8');
    const msg = JSON.parse(raw) as BridgeMessage;
    if (!msg.id || !msg.timestamp || typeof msg.content !== 'string') {
      quarantineFailed(fileName, 'missing required fields: id, timestamp, content');
      return;
    }
    if (!msg.target || !isValidTarget(msg.target)) {
      quarantineFailed(fileName, `missing/invalid target ${JSON.stringify(msg.target ?? null)}`);
      return;
    }
    if (msg.target !== CLAUDE_CODE_TARGET) {
      quarantineFailed(
        fileName,
        `target ${JSON.stringify(msg.target)} does not match ${CLAUDE_CODE_TARGET}`,
      );
      return;
    }
    if (isDelivered(msg.id)) {
      archiveDeliveredMessage(fileName, msg.id, 'already delivered');
      return;
    }
    logEvent({
      event: 'message.received',
      msg: `Inbox message ${msg.id} received from ${msg.from}`,
      context: {
        msg_id: msg.id,
        from: msg.from,
        to: msg.to,
        type: msg.type,
        reply_to: msg.replyTo,
        content_length: msg.content?.length ?? 0,
      },
    });
    withChannelNotifyTimeout(Promise.resolve(savedChannelCallback(msg)), msg.id)
      .then(() => {
        markDelivered(msg.id);
        archiveDeliveredMessage(fileName, msg.id, 'pushed to channel');
      })
      .catch((err) => {
        knownFiles.delete(fileName);
        invalidateCache();
        const errCode =
          (err as { code?: string } | undefined)?.code
          ?? ((err && typeof err === 'object' && 'name' in err) ? String((err as { name?: string }).name) : undefined);
        logEvent({
          event: 'notification.push_failed',
          level: 'error',
          msg: `Channel notification push failed for ${msg.id}; leaving file pending for next owner`,
          context: {
            msg_id: msg.id,
            from: msg.from,
            to: msg.to,
            target: msg.target,
            reply_to: msg.replyTo,
            error: String(err),
            error_code: errCode,
            decision: 'leave_pending_for_next_owner',
            file_name: fileName,
          },
        });
      });
  } catch (err) {
    quarantineFailed(fileName, `failed to parse/emit notification: ${err}`);
  }
}

function initKnownFiles(): void {
  knownFiles.clear();
  try {
    if (existsSync(INBOX_DIR_LOCAL)) {
      const files = readdirSync(INBOX_DIR_LOCAL).filter((f) => f.endsWith('.json'));
      for (const f of files) knownFiles.add(f);
    }
  } catch {
    /* ignore */
  }
}

function checkForNewFiles(callback: MessageCallback): void {
  try {
    if (!existsSync(INBOX_DIR_LOCAL)) return;
    const currentFiles = readdirSync(INBOX_DIR_LOCAL).filter((f) => f.endsWith('.json'));
    const newFiles = currentFiles.filter((f) => !knownFiles.has(f));
    if (newFiles.length > 0) {
      for (const f of newFiles) addKnownFile(f);
      notifyNewFiles(newFiles);
      invalidateCache();
      for (const f of newFiles) emitChannelNotification(f);
      callback(newFiles.map((f) => join(INBOX_DIR_LOCAL, f)));
    }
  } catch (err) {
    logEvent({
      event: 'watcher.check_error',
      level: 'error',
      msg: 'Watcher error checking files',
      context: { error: String(err) },
    });
  }
}

function startPolling(callback: MessageCallback): void {
  if (pollInterval) return;
  setWatcherStatus('polling', true);
  logEvent({
    event: 'watcher.started',
    msg: 'Using polling watcher (2s interval)',
    context: { backend: 'polling', intervalMs: 2000 },
  });
  pollInterval = setInterval(() => checkForNewFiles(callback), 2000);
  // Poll interval is intentionally REFED for the channel-owner process. The
  // whole reason this plugin exists is to be the long-lived channel host.
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function startWatcher(
  callback: MessageCallback,
  channelCallback?: ChannelNotifyCallback,
  opts?: { role?: string },
): Promise<boolean> {
  savedMessageCallback = callback;
  if (channelCallback) savedChannelCallback = channelCallback;

  if (!existsSync(INBOX_DIR_LOCAL)) {
    mkdirSync(INBOX_DIR_LOCAL, { recursive: true, mode: 0o700 });
  }

  const role = opts?.role?.trim() || 'channel-owner';
  savedWatcherRole = role;
  const leaseResult = tryAcquireWatcherLease(role);
  if (leaseResult === 'acquired') {
    clearStandbyRetryTimer();
    activateWatcher(callback);
    return true;
  }

  setWatcherStatus(currentBackend, false);
  if (leaseResult === 'busy') {
    scheduleStandbyRetry(callback, role);
    return true;
  }
  return false;
}

export async function replayUndeliveredMessages(): Promise<void> {
  const channelCallback = savedChannelCallback;
  if (!channelCallback) {
    logEvent({
      event: 'replay.skipped',
      level: 'warn',
      msg: 'Replay: no channel callback registered, skipping',
    });
    return;
  }
  if (!watcherLease) {
    logEvent({
      event: 'replay.skipped_standby',
      msg: 'Replay: this process is standby (no watcher lease), skipping',
    });
    return;
  }

  try {
    if (!existsSync(INBOX_DIR_LOCAL)) return;
    const files = readdirSync(INBOX_DIR_LOCAL).filter((f) => f.endsWith('.json'));
    if (files.length === 0) return;

    const undelivered: { fileName: string; msg: BridgeMessage }[] = [];
    for (const fileName of files) {
      const filePath = join(INBOX_DIR_LOCAL, fileName);
      try {
        const raw = readFileSync(filePath, 'utf8');
        const msg = JSON.parse(raw) as BridgeMessage;
        if (!msg.id || !msg.timestamp || typeof msg.content !== 'string') {
          quarantineFailed(fileName, 'replay missing required fields: id, timestamp, content');
          continue;
        }
        if (!msg.target || !isValidTarget(msg.target) || msg.target !== CLAUDE_CODE_TARGET) {
          quarantineFailed(
            fileName,
            `replay target ${JSON.stringify(msg.target ?? null)} is not ${CLAUDE_CODE_TARGET}`,
          );
          continue;
        }
        if (isDelivered(msg.id)) {
          archiveDeliveredMessage(fileName, msg.id, 'already delivered during replay');
          continue;
        }
        undelivered.push({ fileName, msg });
      } catch (err) {
        quarantineFailed(fileName, `replay failed to parse message: ${err}`);
      }
    }

    if (undelivered.length === 0) return;

    undelivered.sort(
      (a, b) =>
        new Date(a.msg.timestamp).getTime() - new Date(b.msg.timestamp).getTime(),
    );

    logEvent({
      event: 'replay.started',
      msg: `Replay: emitting ${undelivered.length} undelivered message(s)`,
      context: { count: undelivered.length },
    });

    for (const { fileName, msg } of undelivered) {
      try {
        await withChannelNotifyTimeout(Promise.resolve(channelCallback(msg)), msg.id);
        markDelivered(msg.id);
        archiveDeliveredMessage(fileName, msg.id, 'replayed to channel');
      } catch (err) {
        knownFiles.delete(fileName);
        invalidateCache();
        logEvent({
          event: 'replay.push_failed',
          level: 'error',
          msg: `Replay: failed to push ${fileName}`,
          context: { fileName, msg_id: msg.id, error: String(err) },
        });
      }
    }

    logEvent({
      event: 'replay.completed',
      msg: `Replay: completed, ${undelivered.length} message(s) attempted`,
      context: { count: undelivered.length },
    });
  } catch (err) {
    logEvent({
      event: 'replay.scan_failed',
      level: 'error',
      msg: 'Replay: failed to scan inbox for undelivered messages',
      context: { error: String(err) },
    });
  }
}

export function stopWatcher(): void {
  clearStandbyRetryTimer();
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  releaseWatcherLease();
  setWatcherStatus(currentBackend, false);
  logEvent({
    event: 'watcher.stopped',
    msg: 'Watcher stopped',
    context: { backend: currentBackend },
  });
}

export function getWatcherBackend(): 'polling' {
  return currentBackend;
}

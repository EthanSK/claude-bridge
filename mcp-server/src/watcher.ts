/**
 * File watcher for incoming messages in ~/.agent-bridge/inbox/.
 *
 * Polling-only (2s interval). No external dependencies.
 *
 * Historical note: earlier versions of this file spawned `fswatch` (macOS) or
 * `inotifywait` (Linux) as child processes and fell back to polling only if
 * the spawn failed. That was removed in mcp-server 3.4.3 because:
 *  - fswatch is not installed by default on macOS and required Homebrew
 *  - the spawned children occasionally outlived their parent MCP, leaving
 *    zombie watchers pinned to dead Claude sessions
 *  - the extra code path (spawn/crash/backoff/restart) was a frequent source
 *    of race bugs, and the benefit (sub-second latency) wasn't worth it
 *    when polling at 2 s uses effectively zero CPU and zero dependencies.
 *
 * Responsibilities kept:
 *  - Notify inbox cache on new files
 *  - Report health status via setWatcherStatus()
 *  - Emit channel notifications when new messages arrive (push to Claude)
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { CLAUDE_CODE_TARGET, UNROUTED_DIR, inboxSubdir, isValidTarget } from './config.js';

/**
 * The inbox subdir this watcher owns. As of mcp-server 3.4.0 the watcher
 * scopes to `inbox/claude-code/` instead of the flat root inbox. Other
 * harnesses (openclaw-channel etc.) watch their own subdirs independently.
 */
const CLAUDE_CODE_INBOX_DIR = inboxSubdir(CLAUDE_CODE_TARGET);
const INBOX_DIR = CLAUDE_CODE_INBOX_DIR;
import { logInfo, logError, logDebug, logWarn } from './logger.js';
import { logEvent } from './log.js';
import { invalidateCache, notifyNewFiles, setWatcherStatus, isDelivered, markDelivered } from './inbox.js';
import type { BridgeMessage } from './inbox.js';

type MessageCallback = (files: string[]) => void;

/**
 * Callback invoked with a parsed BridgeMessage when a new inbox file arrives.
 * Used to push channel notifications into the running Claude session.
 */
type ChannelNotifyCallback = (message: BridgeMessage) => void | Promise<void>;

let pollInterval: ReturnType<typeof setInterval> | null = null;
let knownFiles = new Set<string>();

/** Maximum entries in knownFiles before evicting oldest (insertion-order). */
const KNOWN_FILES_MAX = 2000;

function addKnownFile(name: string): void {
  if (knownFiles.has(name)) return;
  if (knownFiles.size >= KNOWN_FILES_MAX) {
    // Evict the oldest entry (Sets iterate in insertion order)
    const first = knownFiles.values().next().value;
    if (first !== undefined) knownFiles.delete(first);
  }
  knownFiles.add(name);
}

/**
 * Current backend used for watching. Always 'polling' as of 3.4.3. Retained
 * as a constant (rather than removed entirely) so the exported
 * `getWatcherBackend()` signature and `setWatcherStatus()` contract continue
 * to compile and callers (inbox stats, tests) don't break.
 */
const currentBackend: 'polling' = 'polling';

/** The channel notification callback. */
let savedChannelCallback: ChannelNotifyCallback | null = null;

/**
 * Try to parse a message file and emit a channel notification.
 * Marks the message as delivered to avoid re-emitting on next startup.
 * Errors are logged but never thrown — the watcher must keep running.
 */
function quarantineUnrouted(fileName: string, reason: string): void {
  const filePath = join(INBOX_DIR, fileName);
  try {
    if (!existsSync(UNROUTED_DIR)) {
      mkdirSync(UNROUTED_DIR, { recursive: true, mode: 0o700 });
    }
    renameSync(filePath, join(UNROUTED_DIR, fileName));
    knownFiles.delete(fileName);
    invalidateCache();
    logWarn(`Channel: moved ${fileName} to .failed/_unrouted/: ${reason}`);
  } catch (err) {
    logError(`Channel: failed to quarantine ${fileName}: ${err}`);
  }
}

function emitChannelNotification(fileName: string): void {
  if (!savedChannelCallback) return;

  const filePath = join(INBOX_DIR, fileName);
  try {
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, 'utf8');
    const msg = JSON.parse(raw) as BridgeMessage;
    if (!msg.id || !msg.timestamp || !msg.content) {
      logWarn(`Channel: skipping malformed message file ${fileName}`);
      return;
    }
    if (!msg.target || !isValidTarget(msg.target)) {
      quarantineUnrouted(fileName, `missing/invalid target ${JSON.stringify(msg.target ?? null)}`);
      return;
    }
    if (msg.target !== CLAUDE_CODE_TARGET) {
      quarantineUnrouted(fileName, `target ${JSON.stringify(msg.target)} does not match ${CLAUDE_CODE_TARGET}`);
      return;
    }
    // Skip if already delivered in a previous session
    if (isDelivered(msg.id)) {
      logDebug(`Channel: skipping already-delivered message ${msg.id}`);
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
    Promise.resolve(savedChannelCallback(msg))
      .then(() => {
        markDelivered(msg.id);
      })
      .catch((err) => {
        logError(`Channel: notification callback failed for ${msg.id}: ${err}`);
      });
  } catch (err) {
    logError(`Channel: failed to emit notification for ${fileName}: ${err}`);
  }
}

// ── Known-files init ─────────────────────────────────────────────────────────

function initKnownFiles(): void {
  knownFiles.clear();
  try {
    if (existsSync(INBOX_DIR)) {
      const files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
      for (const f of files) {
        knownFiles.add(f);
      }
    }
  } catch {
    // Ignore errors
  }
}

// ── Polling implementation ───────────────────────────────────────────────────

function checkForNewFiles(callback: MessageCallback): void {
  try {
    if (!existsSync(INBOX_DIR)) return;
    const currentFiles = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
    const newFiles = currentFiles.filter(f => !knownFiles.has(f));

    if (newFiles.length > 0) {
      logDebug(`Watcher detected ${newFiles.length} new message(s)`);
      for (const f of newFiles) {
        addKnownFile(f);
      }
      // Notify the inbox cache
      notifyNewFiles(newFiles);
      invalidateCache();

      // Emit channel notifications for each new message
      for (const f of newFiles) {
        emitChannelNotification(f);
      }

      callback(newFiles.map(f => join(INBOX_DIR, f)));
    }
  } catch (err) {
    logError(`Watcher error checking files: ${err}`);
  }
}

function startPolling(callback: MessageCallback): void {
  if (pollInterval) return;
  setWatcherStatus('polling', true);
  logInfo('Using polling watcher (2s interval)');
  logEvent({
    event: 'watcher.started',
    msg: 'Using polling watcher (2s interval)',
    context: { backend: 'polling', intervalMs: 2000 },
  });
  pollInterval = setInterval(() => checkForNewFiles(callback), 2000);
  if (pollInterval.unref) pollInterval.unref();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start watching the inbox for new messages.
 * Polling-only (2 s interval).
 *
 * @param callback - Called with file paths when new messages are detected.
 * @param channelCallback - Optional. Called with parsed BridgeMessage for
 *   each new message, used to push channel notifications into Claude.
 */
export async function startWatcher(
  callback: MessageCallback,
  channelCallback?: ChannelNotifyCallback,
): Promise<void> {
  if (channelCallback) {
    savedChannelCallback = channelCallback;
  }

  // Ensure inbox directory exists
  if (!existsSync(INBOX_DIR)) {
    mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 });
  }

  initKnownFiles();
  startPolling(callback);
}

/**
 * Replay undelivered messages from the inbox.
 *
 * Scans the inbox for .json files that have not yet been pushed as channel
 * notifications (i.e. messages that arrived while Claude was offline).
 * Emits a channel notification for each, sorted oldest-first so the agent
 * sees them in chronological order.
 *
 * Call this AFTER the MCP server is connected so that
 * `notifications/claude/channel` can actually be sent.
 */
export async function replayUndeliveredMessages(): Promise<void> {
  const channelCallback = savedChannelCallback;
  if (!channelCallback) {
    logWarn('Replay: no channel callback registered, skipping');
    return;
  }

  try {
    if (!existsSync(INBOX_DIR)) return;

    const files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
    if (files.length === 0) return;

    // Parse all valid messages, filter to undelivered, sort by timestamp
    const undelivered: { fileName: string; msg: BridgeMessage }[] = [];

    for (const fileName of files) {
      const filePath = join(INBOX_DIR, fileName);
      try {
        const raw = readFileSync(filePath, 'utf8');
        const msg = JSON.parse(raw) as BridgeMessage;
        if (!msg.id || !msg.timestamp || !msg.content) continue;
        if (!msg.target || !isValidTarget(msg.target) || msg.target !== CLAUDE_CODE_TARGET) {
          quarantineUnrouted(
            fileName,
            `replay target ${JSON.stringify(msg.target ?? null)} is not ${CLAUDE_CODE_TARGET}`,
          );
          continue;
        }
        if (isDelivered(msg.id)) continue;
        undelivered.push({ fileName, msg });
      } catch {
        // Skip malformed files — the prune pass will handle them
      }
    }

    if (undelivered.length === 0) {
      logInfo('Replay: no undelivered messages found');
      return;
    }

    // Sort oldest first
    undelivered.sort(
      (a, b) =>
        new Date(a.msg.timestamp).getTime() - new Date(b.msg.timestamp).getTime(),
    );

    logInfo(`Replay: emitting ${undelivered.length} undelivered message(s)`);

    for (const { fileName, msg } of undelivered) {
      logInfo(`Replay: pushing message ${msg.id} from ${msg.from} (ts: ${msg.timestamp})`);
      try {
        await channelCallback(msg);
        markDelivered(msg.id);
      } catch (err) {
        logError(`Replay: failed to push ${fileName}: ${err}`);
      }
    }

    logInfo(`Replay: completed, ${undelivered.length} message(s) delivered`);
  } catch (err) {
    logError(`Replay: failed to scan inbox for undelivered messages: ${err}`);
  }
}

/**
 * Stop the watcher (for clean shutdown).
 */
export function stopWatcher(): void {
  if (pollInterval) {
    logInfo('Stopping polling watcher');
    clearInterval(pollInterval);
    pollInterval = null;
  }
  setWatcherStatus(currentBackend, false);
  logInfo('Watcher stopped');
  logEvent({
    event: 'watcher.stopped',
    msg: 'Watcher stopped',
    context: { backend: currentBackend },
  });
}

/**
 * Get the current watcher backend. Always `'polling'` as of 3.4.3 (the
 * fswatch/inotifywait spawn paths were removed). Kept as a function so
 * callers compile unchanged.
 */
export function getWatcherBackend(): 'polling' {
  return currentBackend;
}

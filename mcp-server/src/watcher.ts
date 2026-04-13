/**
 * File watcher for incoming messages in ~/.agent-bridge/inbox/.
 *
 * Uses:
 * - macOS: fswatch (install via `brew install fswatch`)
 * - Linux: inotifywait (from inotify-tools)
 * - Fallback: polling every 2 seconds
 *
 * The watcher notifies a callback when new .json files appear.
 */

import { spawn, type ChildProcess } from 'child_process';
import { readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { INBOX_DIR } from './config.js';
import { logInfo, logError, logDebug } from './logger.js';

type MessageCallback = (files: string[]) => void;

let watcherProcess: ChildProcess | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let knownFiles = new Set<string>();

/**
 * Initialize the set of known files in the inbox.
 */
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

/**
 * Check for new files in the inbox (used by polling fallback).
 */
function checkForNewFiles(callback: MessageCallback): void {
  try {
    if (!existsSync(INBOX_DIR)) return;
    const currentFiles = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
    const newFiles = currentFiles.filter(f => !knownFiles.has(f));

    if (newFiles.length > 0) {
      logDebug(`Watcher detected ${newFiles.length} new message(s)`);
      for (const f of newFiles) {
        knownFiles.add(f);
      }
      callback(newFiles.map(f => join(INBOX_DIR, f)));
    }
  } catch (err) {
    logError(`Watcher error checking files: ${err}`);
  }
}

/**
 * Start polling as a fallback.
 */
function startPolling(callback: MessageCallback): void {
  if (pollInterval) return;
  logInfo('Using polling watcher (2s interval)');
  pollInterval = setInterval(() => checkForNewFiles(callback), 2000);
}

/**
 * Try to spawn a process and check if it starts successfully within a timeout.
 * Returns the process if successful, null if it fails to start.
 */
function trySpawn(
  command: string,
  args: string[],
  timeoutMs: number = 500
): Promise<ChildProcess | null> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        if (proc.exitCode === null) {
          // Still running — started successfully
          resolve(proc);
        } else {
          resolve(null);
        }
      }, timeoutMs);

      proc.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });

      // If it exits immediately, it failed
      proc.on('close', () => {
        clearTimeout(timer);
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Start watching the inbox for new messages.
 * Tries native watchers first, falls back to polling.
 */
export async function startWatcher(callback: MessageCallback): Promise<void> {
  // Ensure inbox directory exists
  if (!existsSync(INBOX_DIR)) {
    mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 });
  }

  initKnownFiles();

  const platform = process.platform;

  // Try fswatch on macOS
  if (platform === 'darwin') {
    logInfo('Attempting to start fswatch watcher...');
    const proc = await trySpawn('fswatch', [
      '-0',
      '--event',
      'Created',
      INBOX_DIR,
    ]);

    if (proc) {
      logInfo('fswatch watcher started');
      watcherProcess = proc;

      proc.stdout!.on('data', (chunk: Buffer) => {
        const paths = chunk
          .toString()
          .split('\0')
          .filter(p => p.endsWith('.json'));
        if (paths.length > 0) {
          for (const p of paths) {
            const name = p.split('/').pop()!;
            knownFiles.add(name);
          }
          callback(paths);
        }
      });

      proc.on('close', () => {
        if (watcherProcess === proc) {
          watcherProcess = null;
          logInfo('fswatch exited, falling back to polling');
          startPolling(callback);
        }
      });

      return;
    }
  }

  // Try inotifywait on Linux
  if (platform === 'linux') {
    logInfo('Attempting to start inotifywait watcher...');
    const proc = await trySpawn('inotifywait', [
      '-m',
      '-e',
      'create',
      '--format',
      '%f',
      INBOX_DIR,
    ]);

    if (proc) {
      logInfo('inotifywait watcher started');
      watcherProcess = proc;

      proc.stdout!.on('data', (chunk: Buffer) => {
        const files = chunk
          .toString()
          .trim()
          .split('\n')
          .filter(f => f.endsWith('.json'));
        if (files.length > 0) {
          for (const f of files) {
            knownFiles.add(f);
          }
          callback(files.map(f => join(INBOX_DIR, f)));
        }
      });

      proc.on('close', () => {
        if (watcherProcess === proc) {
          watcherProcess = null;
          logInfo('inotifywait exited, falling back to polling');
          startPolling(callback);
        }
      });

      return;
    }
  }

  // Fallback: polling
  startPolling(callback);
}

/**
 * Stop the watcher (for clean shutdown).
 */
export function stopWatcher(): void {
  if (watcherProcess) {
    logInfo('Stopping file watcher process');
    watcherProcess.kill();
    watcherProcess = null;
  }
  if (pollInterval) {
    logInfo('Stopping polling watcher');
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

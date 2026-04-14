/**
 * Logger for agent-bridge MCP server.
 * Writes to ~/.agent-bridge/logs/mcp-server.log and stderr (never stdout — that's for JSON-RPC).
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { LOGS_DIR, LOG_ROTATION_MAX_FILES } from './config.js';

const LOG_FILE_NAME = 'mcp-server.log';
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB — rotate when exceeded

/**
 * Amortize rotation checks: only stat the file every N writes.
 * Avoids a stat() syscall on every single log line.
 */
const ROTATION_CHECK_INTERVAL = 50;
let writesSinceRotationCheck = 0;
let logsDirVerified = false;

function ensureLogsDir(): void {
  if (logsDirVerified) return;
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
  }
  logsDirVerified = true;
}

function getLogFile(): string {
  return join(LOGS_DIR, LOG_FILE_NAME);
}

/**
 * Rotate the log file if it exceeds MAX_LOG_SIZE.
 * Called every ROTATION_CHECK_INTERVAL writes to avoid excess stat() calls.
 */
function rotateIfNeeded(): void {
  writesSinceRotationCheck++;
  if (writesSinceRotationCheck < ROTATION_CHECK_INTERVAL) return;
  writesSinceRotationCheck = 0;

  const logFile = getLogFile();
  try {
    if (existsSync(logFile)) {
      const stat = statSync(logFile);
      if (stat.size > MAX_LOG_SIZE) {
        const rotated = join(LOGS_DIR, `mcp-server-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
        renameSync(logFile, rotated);

        // Enforce retention cap: delete oldest rotated files beyond LOG_ROTATION_MAX_FILES
        try {
          const rotatedFiles = readdirSync(LOGS_DIR)
            .filter(f => f.startsWith('mcp-server-') && f.endsWith('.log'))
            .map(f => ({ name: f, mtime: statSync(join(LOGS_DIR, f)).mtimeMs }))
            .sort((a, b) => a.mtime - b.mtime); // oldest first

          const overflow = rotatedFiles.length - LOG_ROTATION_MAX_FILES;
          for (let i = 0; i < overflow; i++) {
            try { unlinkSync(join(LOGS_DIR, rotatedFiles[i].name)); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    }
  } catch {
    // Ignore rotation errors — don't block logging
  }
}

function formatMessage(level: string, msg: string): string {
  return `[${new Date().toISOString()}] [${level}] ${msg}\n`;
}

export function logInfo(msg: string): void {
  ensureLogsDir();
  rotateIfNeeded();
  const formatted = formatMessage('INFO', msg);
  try { appendFileSync(getLogFile(), formatted); } catch { /* ignore */ }
  process.stderr.write(formatted);
}

export function logWarn(msg: string): void {
  ensureLogsDir();
  rotateIfNeeded();
  const formatted = formatMessage('WARN', msg);
  try { appendFileSync(getLogFile(), formatted); } catch { /* ignore */ }
  process.stderr.write(formatted);
}

export function logError(msg: string, err?: unknown): void {
  ensureLogsDir();
  rotateIfNeeded();
  let formatted = formatMessage('ERROR', msg);
  if (err instanceof Error && err.stack) {
    formatted += `  Stack: ${err.stack}\n`;
  }
  try { appendFileSync(getLogFile(), formatted); } catch { /* ignore */ }
  process.stderr.write(formatted);
}

export function logDebug(msg: string): void {
  ensureLogsDir();
  rotateIfNeeded();
  const formatted = formatMessage('DEBUG', msg);
  try { appendFileSync(getLogFile(), formatted); } catch { /* ignore */ }
  // Debug only goes to file, not stderr, to reduce noise
}

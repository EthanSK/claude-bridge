/**
 * Logger for agent-bridge MCP server.
 * Writes to ~/.agent-bridge/logs/mcp-server.log and stderr (never stdout — that's for JSON-RPC).
 */

import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { LOGS_DIR } from './config.js';

const LOG_FILE_NAME = 'mcp-server.log';
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB — rotate when exceeded

function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
  }
}

function getLogFile(): string {
  return join(LOGS_DIR, LOG_FILE_NAME);
}

/**
 * Rotate the log file if it exceeds MAX_LOG_SIZE.
 */
function rotateIfNeeded(): void {
  const logFile = getLogFile();
  try {
    if (existsSync(logFile)) {
      const stat = statSync(logFile);
      if (stat.size > MAX_LOG_SIZE) {
        const rotated = join(LOGS_DIR, `mcp-server-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
        renameSync(logFile, rotated);
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
  appendFileSync(getLogFile(), formatted);
  process.stderr.write(formatted);
}

export function logWarn(msg: string): void {
  ensureLogsDir();
  rotateIfNeeded();
  const formatted = formatMessage('WARN', msg);
  appendFileSync(getLogFile(), formatted);
  process.stderr.write(formatted);
}

export function logError(msg: string, err?: unknown): void {
  ensureLogsDir();
  rotateIfNeeded();
  let formatted = formatMessage('ERROR', msg);
  if (err instanceof Error && err.stack) {
    formatted += `  Stack: ${err.stack}\n`;
  }
  appendFileSync(getLogFile(), formatted);
  process.stderr.write(formatted);
}

export function logDebug(msg: string): void {
  ensureLogsDir();
  const formatted = formatMessage('DEBUG', msg);
  appendFileSync(getLogFile(), formatted);
  // Debug only goes to file, not stderr, to reduce noise
}

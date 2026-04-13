/**
 * Logger for agent-bridge MCP server.
 * Writes to ~/.agent-bridge/logs/ and stderr (never stdout — that's for JSON-RPC).
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { LOGS_DIR } from './config.js';

function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
  }
}

function getLogFile(): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return join(LOGS_DIR, `mcp-server-${date}.log`);
}

function formatMessage(level: string, msg: string): string {
  return `[${new Date().toISOString()}] [${level}] ${msg}\n`;
}

export function logInfo(msg: string): void {
  ensureLogsDir();
  const formatted = formatMessage('INFO', msg);
  appendFileSync(getLogFile(), formatted);
  process.stderr.write(formatted);
}

export function logError(msg: string): void {
  ensureLogsDir();
  const formatted = formatMessage('ERROR', msg);
  appendFileSync(getLogFile(), formatted);
  process.stderr.write(formatted);
}

export function logDebug(msg: string): void {
  ensureLogsDir();
  const formatted = formatMessage('DEBUG', msg);
  appendFileSync(getLogFile(), formatted);
  // Debug only goes to file, not stderr, to reduce noise
}

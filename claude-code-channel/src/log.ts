/**
 * Unified structured event log writer for claude-code-channel.
 *
 * Writes NDJSON to ~/.agent-bridge/logs/agent-bridge.log alongside mcp-server,
 * the bash CLI, and any other agent-bridge component. Same file, same shape,
 * different `component` field — so `jq` queries on the unified log surface
 * channel-plugin events alongside everything else.
 *
 * This is a copy/paste of mcp-server/src/log.ts with `component` set to
 * `'claude-code-channel'`. The two log writers MUST stay byte-compatible;
 * if you change the schema here, change it in mcp-server too.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { LOGS_DIR } from './config.js';

const LOG_FILE_NAME = 'agent-bridge.log';
const MAX_LOG_SIZE = 50 * 1024 * 1024;
const ROTATION_CHECK_INTERVAL = 50;
const MAX_CONTEXT_STRING = 2000;

let writesSinceRotationCheck = 0;
let logsDirVerified = false;
let cachedMachine: string | null = null;

function ensureLogsDir(): void {
  if (logsDirVerified) return;
  try {
    if (!existsSync(LOGS_DIR)) {
      mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    }
  } catch {
    /* fall through */
  }
  logsDirVerified = true;
}

function logPath(): string {
  return join(LOGS_DIR, LOG_FILE_NAME);
}

function rotatedPath(): string {
  return join(LOGS_DIR, `${LOG_FILE_NAME}.1`);
}

function rotateIfNeeded(): void {
  writesSinceRotationCheck++;
  if (writesSinceRotationCheck < ROTATION_CHECK_INTERVAL) return;
  writesSinceRotationCheck = 0;
  try {
    const p = logPath();
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.size <= MAX_LOG_SIZE) return;
    renameSync(p, rotatedPath());
  } catch {
    /* ignore rotation errors */
  }
}

function getMachine(): string {
  if (cachedMachine !== null) return cachedMachine;
  try {
    cachedMachine = hostname().replace(/\.local$/, '');
  } catch {
    cachedMachine = 'unknown';
  }
  return cachedMachine;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /ghp_[A-Za-z0-9]{30,}/g,
  /gho_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(?:Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

function redactString(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

function truncateString(input: string): string {
  if (input.length <= MAX_CONTEXT_STRING) return input;
  return `${input.slice(0, MAX_CONTEXT_STRING)}…[truncated ${input.length - MAX_CONTEXT_STRING}]`;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateString(redactString(value));
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(redactString(value.message)),
      stack: value.stack ? truncateString(redactString(value.stack)) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEventInput {
  event: string;
  level?: LogLevel;
  msg: string;
  context?: Record<string, unknown>;
}

const COMPONENT = 'claude-code-channel';

export function logEvent(input: LogEventInput): void {
  ensureLogsDir();
  rotateIfNeeded();

  const record = {
    ts: new Date().toISOString(),
    component: COMPONENT,
    machine: getMachine(),
    event: input.event,
    level: input.level ?? 'info',
    msg: truncateString(redactString(input.msg)),
    ...(input.context ? { context: sanitize(input.context) } : {}),
  };

  let line: string;
  try {
    line = JSON.stringify(record) + '\n';
  } catch (err) {
    line = JSON.stringify({
      ts: record.ts,
      component: record.component,
      machine: record.machine,
      event: record.event,
      level: 'warn',
      msg: `[log.ts] failed to serialize event ${input.event}: ${String(err)}`,
    }) + '\n';
  }

  try {
    appendFileSync(logPath(), line);
  } catch (err) {
    try {
      process.stderr.write(`[agent-bridge.log fallback] ${line}`);
      process.stderr.write(`[agent-bridge.log fallback] write error: ${String(err)}\n`);
    } catch {
      /* swallow */
    }
  }
}

/**
 * Tiny convenience helpers for stderr-bound diagnostic lines. These do NOT
 * write to the unified NDJSON log; they go to stderr (which is teed to
 * ~/.agent-bridge/logs/claude-code-channel-stderr.log via Patch B).
 */
export function logStderr(msg: string): void {
  try {
    process.stderr.write(`${msg}\n`);
  } catch {
    /* swallow */
  }
}

/**
 * Last-reachable-path cache for agent-bridge.
 *
 * Remembers whether LAN or internet worked most recently per-machine so that
 * off-network ops don't eat a 3s LAN probe on every call. Entries older than
 * PATH_CACHE_TTL_MS (default 1h) are considered stale — the next call will
 * re-probe LAN-first to ensure the cache reflects current topology.
 *
 * Cache file: ~/.agent-bridge/path-cache.json, mode 0600.
 *
 * Shape:
 *   {
 *     "Mac-Mini":   { "path": "internet", "ts": 1776473474, "last_success": 1776473474 },
 *     "MacBookPro": { "path": "lan",      "ts": 1776473400, "last_success": 1776473400 }
 *   }
 *
 * All writes go through an atomic `rename(tmp, final)` so concurrent readers
 * never observe a partially-written file. Corrupt files are treated as empty
 * and silently overwritten on the next successful probe.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync, renameSync } from 'fs';
import { join } from 'path';
import { BRIDGE_DIR } from './config.js';
import { logDebug, logWarn } from './logger.js';

export const PATH_CACHE_FILE = join(BRIDGE_DIR, 'path-cache.json');

/** TTL for a cached `last_success` — 1 hour by default, overridable via env. */
function readPathCacheTtlMs(): number {
  const fallback = 60 * 60 * 1000;
  const parsed = parseInt(process.env.AGENT_BRIDGE_PATH_CACHE_TTL_MS ?? String(fallback), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const PATH_CACHE_TTL_MS = readPathCacheTtlMs();

export type PathKind = 'lan' | 'internet';

export interface PathCacheEntry {
  path: PathKind;
  /** Seconds since epoch — last time we wrote this entry. */
  ts: number;
  /** Seconds since epoch — last successful connection via `path`. */
  last_success: number;
}

type PathCacheFile = Record<string, PathCacheEntry>;

function isPathCacheEntry(value: unknown): value is PathCacheEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<PathCacheEntry>;
  return (
    (entry.path === 'lan' || entry.path === 'internet') &&
    typeof entry.ts === 'number' &&
    Number.isFinite(entry.ts) &&
    typeof entry.last_success === 'number' &&
    Number.isFinite(entry.last_success)
  );
}

function normalizePathCacheFile(value: unknown): PathCacheFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const normalized: PathCacheFile = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isPathCacheEntry(entry)) {
      normalized[key] = entry;
    }
  }
  return normalized;
}

function serializePathCacheFile(file: PathCacheFile): string {
  const entries = Object.entries(file);
  if (entries.length === 0) {
    return '{\n}\n';
  }
  // Keep one machine entry per line so the dependency-free bash fallback can
  // read cache files produced by the TypeScript server.
  const lines = entries.map(([key, entry]) => `  ${JSON.stringify(key)}: ${JSON.stringify(entry)}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

/**
 * Read the raw cache file. Returns `{}` when the file is missing or corrupt.
 */
function readPathCacheFile(): PathCacheFile {
  if (!existsSync(PATH_CACHE_FILE)) {
    return {};
  }
  try {
    const raw = readFileSync(PATH_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizePathCacheFile(parsed);
  } catch (err) {
    // Corrupt file — treat as missing. The next successful probe will
    // overwrite it with a clean entry.
    logWarn(`path-cache: corrupt file at ${PATH_CACHE_FILE}, treating as empty (${err instanceof Error ? err.message : String(err)})`);
    return {};
  }
}

/**
 * Case-insensitive key lookup — the bash config uses case-insensitive machine
 * names, so the cache must do the same.
 */
function findKey(file: PathCacheFile, machine: string): string | undefined {
  const lower = machine.toLowerCase();
  return Object.keys(file).find(k => k.toLowerCase() === lower);
}

/**
 * Read the cached path for a machine (or undefined if no entry).
 */
export function readPathCache(machine: string): PathCacheEntry | undefined {
  const file = readPathCacheFile();
  const key = findKey(file, machine);
  if (!key) return undefined;
  const entry = file[key];
  if (!entry || (entry.path !== 'lan' && entry.path !== 'internet')) {
    return undefined;
  }
  return entry;
}

/**
 * Check whether a cache entry's `last_success` is within the TTL window.
 */
export function isFresh(entry: PathCacheEntry | undefined, ttlMs: number = PATH_CACHE_TTL_MS): boolean {
  if (!entry) return false;
  const nowS = Math.floor(Date.now() / 1000);
  return (nowS - entry.last_success) * 1000 < ttlMs;
}

/**
 * Write (or update) the cached path for a machine.
 * Atomic via write-to-tmp + rename. File mode is 0600.
 */
export function writePathCache(machine: string, path: PathKind): void {
  const file = readPathCacheFile();
  const existingKey = findKey(file, machine);
  // If there's an entry under a different-case key, drop it so we don't end
  // up with two entries for the same machine differing only in case.
  if (existingKey && existingKey !== machine) {
    delete file[existingKey];
  }
  const nowS = Math.floor(Date.now() / 1000);
  file[machine] = { path, ts: nowS, last_success: nowS };

  const tmp = `${PATH_CACHE_FILE}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, serializePathCacheFile(file), { mode: 0o600 });
    renameSync(tmp, PATH_CACHE_FILE);
    // renameSync preserves the file's mode; chmod defensively in case the
    // destination already existed with looser perms.
    try { chmodSync(PATH_CACHE_FILE, 0o600); } catch { /* best effort */ }
    logDebug(`path-cache: ${machine} -> ${path}`);
  } catch (err) {
    logWarn(`path-cache: write failed for ${machine}: ${err instanceof Error ? err.message : String(err)}`);
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

/**
 * Clear the cache entry for a single machine. If the cache becomes empty,
 * remove the file entirely so an `ls` of `~/.agent-bridge` stays tidy.
 */
export function clearPathCache(machine: string): void {
  const file = readPathCacheFile();
  const key = findKey(file, machine);
  if (!key) return;
  delete file[key];
  if (Object.keys(file).length === 0) {
    try { unlinkSync(PATH_CACHE_FILE); } catch { /* best effort */ }
    return;
  }
  const tmp = `${PATH_CACHE_FILE}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, serializePathCacheFile(file), { mode: 0o600 });
    renameSync(tmp, PATH_CACHE_FILE);
    try { chmodSync(PATH_CACHE_FILE, 0o600); } catch { /* best effort */ }
  } catch (err) {
    logWarn(`path-cache: clear failed for ${machine}: ${err instanceof Error ? err.message : String(err)}`);
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

/**
 * Pick the order in which to attempt paths for a machine.
 *
 *  - `bypass=true`         -> always `['lan', 'internet']` (forced fresh probe)
 *  - fresh cache entry     -> cached path first, alt second
 *  - no cache / stale      -> `['lan', 'internet']` (LAN-first)
 */
export function pathOrder(machine: string, opts: { bypass?: boolean } = {}): PathKind[] {
  if (opts.bypass) {
    return ['lan', 'internet'];
  }
  const entry = readPathCache(machine);
  if (isFresh(entry) && entry) {
    return entry.path === 'lan' ? ['lan', 'internet'] : ['internet', 'lan'];
  }
  return ['lan', 'internet'];
}

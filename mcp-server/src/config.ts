/**
 * Configuration loader for agent-bridge.
 * Reads the INI-style config from ~/.agent-bridge/config
 * and SSH key paths from ~/.agent-bridge/keys/
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { homedir, hostname } from 'os';
import { join } from 'path';

export const BRIDGE_DIR = join(homedir(), '.agent-bridge');
export const CONFIG_FILE = join(BRIDGE_DIR, 'config');
export const KEYS_DIR = join(BRIDGE_DIR, 'keys');
export const INBOX_DIR = join(BRIDGE_DIR, 'inbox');
export const OUTBOX_DIR = join(BRIDGE_DIR, 'outbox');
export const LOGS_DIR = join(BRIDGE_DIR, 'logs');
export const FAILED_DIR = join(INBOX_DIR, '.failed');
export const PROCESSED_FILE = join(INBOX_DIR, '.processed');

/** Pruning / TTL settings (overridable via environment variables) */
export const PRUNE_MAX_AGE_MS = parseInt(
  process.env.BRIDGE_PRUNE_MAX_AGE_MS ?? String(24 * 60 * 60 * 1000),
  10,
); // 24 hours
export const PRUNE_MAX_INBOX_SIZE = parseInt(
  process.env.BRIDGE_PRUNE_MAX_INBOX ?? '100',
  10,
);
export const PRUNE_INTERVAL_MS = parseInt(
  process.env.BRIDGE_PRUNE_INTERVAL_MS ?? String(5 * 60 * 1000),
  10,
); // 5 minutes
export const DEFAULT_TTL_SECONDS = parseInt(
  process.env.BRIDGE_DEFAULT_TTL ?? '3600',
  10,
); // 1 hour
export const PROCESSED_FILE_MAX_SIZE = 512 * 1024; // 512 KB — rotate when exceeded

export interface MachineConfig {
  name: string;
  host: string;
  user: string;
  port: number;
  key: string;
  pairedAt: string;
}

/**
 * Ensure all required directories exist.
 */
export function ensureDirectories(): void {
  for (const dir of [BRIDGE_DIR, INBOX_DIR, OUTBOX_DIR, LOGS_DIR, FAILED_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

/**
 * Parse the INI-style config file and return all machine configs.
 */
export function loadConfig(): MachineConfig[] {
  if (!existsSync(CONFIG_FILE)) {
    return [];
  }

  const content = readFileSync(CONFIG_FILE, 'utf8');
  const machines: MachineConfig[] = [];
  let current: Partial<MachineConfig> | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();

    // Section header: [MachineName]
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      if (current?.name) {
        machines.push(current as MachineConfig);
      }
      current = { name: sectionMatch[1] };
      continue;
    }

    // Key=value pair
    if (current) {
      const kvMatch = line.match(/^(\w+)=(.*)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        switch (key) {
          case 'host':
            current.host = value;
            break;
          case 'user':
            current.user = value;
            break;
          case 'port':
            current.port = parseInt(value, 10) || 22;
            break;
          case 'key':
            current.key = value;
            break;
          case 'paired_at':
            current.pairedAt = value;
            break;
        }
      }
    }
  }

  // Push the last machine
  if (current?.name) {
    machines.push(current as MachineConfig);
  }

  return machines;
}

/**
 * Get a specific machine by name (case-insensitive).
 */
export function getMachine(name: string): MachineConfig | undefined {
  const machines = loadConfig();
  const lower = name.toLowerCase();
  return machines.find(m => m.name.toLowerCase() === lower);
}

/**
 * Get the local machine name from the config directory.
 * Falls back to hostname.
 */
export function getLocalMachineName(): string {
  // Check if there's a local name file
  const nameFile = join(BRIDGE_DIR, 'machine-name');
  if (existsSync(nameFile)) {
    return readFileSync(nameFile, 'utf8').trim();
  }
  // Fall back to hostname
  return hostname().replace(/\.local$/, '');
}

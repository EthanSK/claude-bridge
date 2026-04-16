/**
 * SSH execution wrapper for agent-bridge.
 * Runs commands on remote machines using the SSH keys from v1.
 *
 * Supports dual-endpoint fallback: tries LAN (host:port) first with a short
 * timeout, then falls back to internet_host:internet_port if configured.
 *
 * Logs all connection attempts and results.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { type MachineConfig } from './config.js';
import { logDebug, logError, logInfo, logWarn } from './logger.js';

/** Timeout for the LAN attempt when an internet fallback is available. */
const LAN_CONNECT_TIMEOUT_S = 3;
/** Timeout for the internet fallback attempt. */
const INTERNET_CONNECT_TIMEOUT_S = 10;
/** Timeout when there is no fallback (single endpoint). */
const DEFAULT_CONNECT_TIMEOUT_S = 10;

export interface SSHResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Build the common SSH argument list for a machine.
 */
function buildSSHArgs(
  machine: MachineConfig,
  host: string,
  port: number,
  connectTimeoutS: number,
): string[] {
  return [
    '-i', machine.key,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeoutS}`,
    '-o', 'LogLevel=ERROR',
    '-p', String(port),
    `${machine.user}@${host}`,
  ];
}

/**
 * Execute an SSH command against a specific host:port.
 * Internal helper — does not do fallback.
 */
function sshExecSingle(
  machine: MachineConfig,
  host: string,
  port: number,
  connectTimeoutS: number,
  command: string,
  timeoutMs: number,
): Promise<SSHResult> {
  const args = [...buildSSHArgs(machine, host, port, connectTimeoutS), command];

  return new Promise<SSHResult>((resolve, reject) => {
    const proc = spawn('ssh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`SSH command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? 1;
      resolve({ exitCode, stdout, stderr });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run a command on a remote machine via SSH.
 *
 * If the machine has an internet_host configured, tries the primary
 * host first (3s connect timeout), then falls back to internet_host.
 */
export async function sshExec(
  machine: MachineConfig,
  command: string,
  timeoutMs: number = 30000,
): Promise<SSHResult> {
  if (!existsSync(machine.key)) {
    throw new Error(`SSH key not found: ${machine.key}`);
  }

  const hasInternetFallback = !!machine.internetHost;
  const lanTimeout = hasInternetFallback ? LAN_CONNECT_TIMEOUT_S : DEFAULT_CONNECT_TIMEOUT_S;

  logDebug(`SSH exec to ${machine.name} (${machine.host}:${machine.port}): ${command.substring(0, 200)}`);

  // Try primary (LAN) endpoint
  try {
    const result = await sshExecSingle(
      machine, machine.host, machine.port, lanTimeout, command, timeoutMs,
    );
    // Only fall back on SSH connection failure (exit 255), not remote command failures.
    // Exit code 255 means SSH itself failed (connection refused, timeout, auth failure).
    // Any other exit code means SSH connected but the remote command returned non-zero.
    if (result.exitCode !== 255 || !hasInternetFallback) {
      if (result.exitCode === 0) {
        logDebug(`SSH to ${machine.name} succeeded via LAN (${machine.host}:${machine.port})`);
      }
      return result;
    }
    logWarn(`SSH to ${machine.name} via LAN failed (exit=255, connection failure), trying internet fallback...`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Distinguish connection-level errors (spawn failure) from command timeouts.
    // A timeout means SSH connected and the command was running — retrying would
    // duplicate side effects. Only retry on spawn errors (SSH binary not found, etc.).
    const isTimeout = errMsg.includes('timed out');
    if (!hasInternetFallback || isTimeout) {
      logError(`SSH to ${machine.name} failed: ${errMsg}`);
      throw err;
    }
    logWarn(`SSH to ${machine.name} via LAN failed (${errMsg}), trying internet fallback...`);
  }

  // Try internet fallback
  const internetPort = machine.internetPort ?? 22;
  logInfo(`SSH fallback to ${machine.name} via internet (${machine.internetHost}:${internetPort})`);

  try {
    const result = await sshExecSingle(
      machine, machine.internetHost!, internetPort, INTERNET_CONNECT_TIMEOUT_S, command, timeoutMs,
    );
    if (result.exitCode === 0) {
      logInfo(`SSH to ${machine.name} succeeded via internet (${machine.internetHost}:${internetPort})`);
    } else {
      logError(`SSH to ${machine.name} failed on both LAN and internet (internet exit=${result.exitCode})`);
    }
    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logError(`Machine ${machine.name} unreachable on both LAN (${machine.host}:${machine.port}) and internet (${machine.internetHost}:${internetPort}): ${errMsg}`);
    throw new Error(
      `Machine "${machine.name}" unreachable on both LAN and internet. ` +
      `LAN: ${machine.host}:${machine.port}, Internet: ${machine.internetHost}:${internetPort}`,
    );
  }
}

/**
 * Check if a remote machine is reachable via SSH.
 */
export async function sshPing(machine: MachineConfig): Promise<boolean> {
  logDebug(`SSH ping to ${machine.name} (${machine.user}@${machine.host}:${machine.port})`);
  try {
    const result = await sshExec(machine, 'echo pong', 10000);
    const reachable = result.exitCode === 0 && result.stdout.trim() === 'pong';
    logInfo(`SSH ping ${machine.name}: ${reachable ? 'ONLINE' : 'OFFLINE'}`);
    return reachable;
  } catch {
    logInfo(`SSH ping ${machine.name}: OFFLINE (error)`);
    return false;
  }
}

/**
 * Write content to a file on a remote machine via SSH.
 * Uses base64 encoding for safe transport of arbitrary content
 * (JSON with quotes, newlines, backslashes, etc.).
 */
export async function sshWriteFile(
  machine: MachineConfig,
  remotePath: string,
  content: string,
  timeoutMs: number = 15000,
): Promise<SSHResult> {
  logDebug(`SSH write file to ${machine.name}: ${remotePath} (${content.length}B)`);
  // Base64-encode the content to avoid shell escaping issues with quotes,
  // newlines, backslashes, dollar signs, etc. in JSON payloads.
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  // Replace a leading `~` with `$HOME` so the remote shell expands it correctly.
  // Single-quoting a path that starts with `~` prevents tilde expansion, causing
  // files to land in a literal `~/` directory instead of the user's home dir.
  const expandedPath = remotePath.startsWith('~/')
    ? `$HOME/${remotePath.slice(2)}`
    : remotePath;
  // Use double-quotes around the path so $HOME is expanded by the remote shell.
  // base64 output only contains [A-Za-z0-9+/=] so single-quoting is safe there.
  const command = `mkdir -p "$(dirname "${expandedPath}")" && echo '${b64}' | base64 -d > "${expandedPath}"`;
  return sshExec(machine, command, timeoutMs);
}

/**
 * Read a file from a remote machine via SSH.
 */
export async function sshReadFile(
  machine: MachineConfig,
  remotePath: string,
  timeoutMs: number = 15000,
): Promise<string> {
  const result = await sshExec(machine, `cat '${remotePath}'`, timeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to read remote file ${remotePath}: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * List files in a directory on a remote machine via SSH.
 */
export async function sshListFiles(
  machine: MachineConfig,
  remotePath: string,
  timeoutMs: number = 15000,
): Promise<string[]> {
  const result = await sshExec(
    machine,
    `ls -1 '${remotePath}' 2>/dev/null || true`,
    timeoutMs,
  );
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout.trim().split('\n').filter(Boolean);
}

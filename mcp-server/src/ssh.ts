/**
 * SSH execution wrapper for agent-bridge.
 * Runs commands on remote machines using the SSH keys from v1.
 *
 * Policy (3.4.2+): If `internet_host` is configured, ALWAYS use it — no LAN
 * fallback. Tailscale works from any network, LAN only works from home.
 * If `internet_host` is absent, LAN is the only path.
 *
 * Logs all connection attempts and results.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { type MachineConfig } from './config.js';
import { logDebug, logError, logInfo, logWarn } from './logger.js';
import { writePathCache, type PathKind } from './pathCache.js';

/** Timeout for the internet (Tailscale) attempt. */
const INTERNET_CONNECT_TIMEOUT_S = 10;
/** Timeout when using the LAN endpoint (no internet configured). */
const LAN_CONNECT_TIMEOUT_S = 10;

export interface SSHResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * Wall-clock milliseconds the ssh process ran for, used to disambiguate a
   * connection-timeout 255 from a remote command that returned 255 on its
   * own. Not all callers care about this — single-endpoint callers can ignore.
   */
  elapsedMs?: number;
}

/**
 * Build the common SSH argument list for a machine.
 *
 * `clientLogFile` (optional) captures ssh client-side diagnostics via `-E` at
 * INFO level so we can reliably distinguish a connection-level failure (which
 * writes well-known messages to this log) from a remote command exit. Without
 * this, SSH's default `LogLevel=ERROR` path writes some connection failures
 * silently, making exit 255 ambiguous.
 */
function buildSSHArgs(
  machine: MachineConfig,
  host: string,
  port: number,
  connectTimeoutS: number,
  clientLogFile?: string,
): string[] {
  const args = [
    '-i', machine.key,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeoutS}`,
    '-o', 'LogLevel=ERROR',
    '-p', String(port),
  ];
  if (clientLogFile) {
    // -E writes SSH client logs to a file; -o LogLevel=INFO raises the level
    // enough to include "Connection timed out", "Permission denied", etc.
    // without polluting stderr for the caller.
    args.push('-E', clientLogFile, '-o', 'LogLevel=INFO');
  }
  args.push(`${machine.user}@${host}`);
  return args;
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
  // Capture ssh client diagnostics into a tmpfile so we can reliably detect
  // connection failures even when the default LogLevel=ERROR path would
  // otherwise write nothing to stderr.
  const tmpDir = mkdtempSync(join(tmpdir(), 'ab-ssh-'));
  const clientLog = join(tmpDir, 'client.log');
  const args = [...buildSSHArgs(machine, host, port, connectTimeoutS, clientLog), command];

  const startedAt = Date.now();
  return new Promise<SSHResult>((resolve, reject) => {
    const proc = spawn('ssh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    };

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
      cleanup();
      reject(new Error(`SSH command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? 1;
      // Fold the client log into stderr so downstream classification uses a
      // single stream. If the read fails, we just get whatever stderr was.
      let clientLogText = '';
      try { clientLogText = readFileSync(clientLog, 'utf8'); } catch { /* noop */ }
      cleanup();
      resolve({
        exitCode,
        stdout,
        stderr: stderr + clientLogText,
        elapsedMs: Date.now() - startedAt,
      });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
  });
}

/** Options for tuning a single sshExec call. */
export interface SSHExecOptions {
  /**
   * Compatibility flag retained from the old cache/probe era. 3.4.2+ endpoint
   * selection remains `internet_host` when configured, otherwise LAN; callers
   * may still pass this without changing endpoint selection.
   */
  bypassPathCache?: boolean;
}

/**
 * SSH exit 255 is ambiguous: it can mean "ssh itself failed to connect" OR
 * "ssh connected fine and the remote command returned 255 on its own." For
 * non-interactive exec paths we must not retry a command that actually ran
 * to completion, so we match ONLY explicit client-emitted connection-failure
 * phrases. We deliberately avoid elapsed-time heuristics here — a
 * long-running remote command that eventually exits 255 would otherwise be
 * misclassified as a slow ConnectTimeout.
 *
 * In practice OpenSSH always prints "ssh: connect to host X port Y: ..."
 * or similar on real connection failures, so stderr sniffing is sufficient.
 */
function isConnectionFailure(stderr: string): boolean {
  // Only match phrases the ssh *client* itself emits for its own failures.
  // Generic strings like "Permission denied" or "Broken pipe" are avoided
  // because remote commands can legitimately write them to stderr.
  const patterns = [
    'ssh: connect to host',
    'ssh: Could not resolve hostname',
    'ssh_exchange_identification:',
    'kex_exchange_identification:',
    'Host key verification failed',
    'Permission denied (publickey',
    'No route to host',
    'Network is unreachable',
    'Name or service not known',
  ];
  return !!stderr && patterns.some(p => stderr.includes(p));
}

/**
 * Transient client-side failures that may succeed if retried after a brief
 * backoff. "Address already in use" shows up when the kernel transiently
 * can't bind an ephemeral source port (port-range exhaustion, lingering
 * TIME_WAIT sockets, or macOS's firewall/VPN stack churning). It's NOT a
 * path-health signal — the remote endpoint is fine, the client just couldn't
 * open a socket this instant.
 */
function isTransientClientFailure(stderr: string): boolean {
  if (!stderr) return false;
  return (
    stderr.includes('Address already in use') ||
    // Match BOTH the Linux ("Cannot assign requested address") and macOS
    // ("Can't assign requested address") wordings of EADDRNOTAVAIL by
    // checking the shared suffix.
    stderr.includes('assign requested address') ||
    stderr.includes('Resource temporarily unavailable')
  );
}

/** Sleep helper for exp-backoff retries. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Exponential backoff delays between retry attempts within a single endpoint.
 * First attempt is at delay[0] = 0 (immediate). Subsequent attempts back off
 * at 500ms, 1500ms. Kept modest so a two-path failure finishes in under ~6s
 * including connection timeouts.
 */
const RETRY_BACKOFFS_MS = [0, 500, 1500] as const;

function shellDoubleQuotePath(path: string): string {
  const escapeDoubleQuoted = (value: string): string =>
    value.replace(/(["\\$`])/g, '\\$1');
  if (path.startsWith('~/')) {
    return `"${'${HOME}'}/${escapeDoubleQuoted(path.slice(2))}"`;
  }
  return `"${escapeDoubleQuoted(path)}"`;
}

/**
 * Resolve the endpoint tuple for a given path attempt.
 */
function endpointFor(machine: MachineConfig, kind: PathKind): { host: string; port: number; timeoutS: number; label: string } {
  if (kind === 'lan') {
    return {
      host: machine.host,
      port: machine.port,
      timeoutS: LAN_CONNECT_TIMEOUT_S,
      label: 'LAN',
    };
  }
  return {
    host: machine.internetHost!,
    port: machine.internetPort ?? 22,
    timeoutS: INTERNET_CONNECT_TIMEOUT_S,
    label: 'internet',
  };
}

/**
 * Pick the single endpoint kind to use for this machine.
 *
 * 3.4.2+ policy: Tailscale-first, no fallback.
 *   - `internetHost` configured    -> 'internet'
 *   - `internetHost` absent        -> 'lan'
 */
function preferredEndpointKind(machine: MachineConfig): PathKind {
  return machine.internetHost ? 'internet' : 'lan';
}

/**
 * Run a command on a remote machine via SSH.
 *
 * 3.4.2+ policy: Tailscale-first, no fallback.
 *   - If `internet_host` is configured, it is the ONLY endpoint we try.
 *   - Otherwise, LAN (host:port) is the ONLY endpoint we try.
 *
 * Remote-command failures (non-255, non-zero) are returned as-is. Transient
 * client-side bind failures ("Address already in use", "Cannot assign
 * requested address", etc.) are retried a few times on the same endpoint.
 * Real connection failures are returned — callers should surface them
 * rather than silently retrying a different path.
 *
 * The `bypassPathCache` option is retained for API compatibility but is a
 * no-op in the new policy.
 */
export async function sshExec(
  machine: MachineConfig,
  command: string,
  timeoutMs: number = 30000,
  _opts: SSHExecOptions = {},
): Promise<SSHResult> {
  if (!existsSync(machine.key)) {
    throw new Error(`SSH key not found: ${machine.key}`);
  }

  const kind = preferredEndpointKind(machine);
  const ep = endpointFor(machine, kind);
  logDebug(
    `SSH exec to ${machine.name} via ${ep.label} (${ep.host}:${ep.port}): ` +
    `${command.substring(0, 200)}`,
  );

  // Single-endpoint path with transient-retry loop. "Address already in use"
  // and friends retry on the same endpoint; real connection failures or
  // remote-command exits are returned as-is (no fallback).
  let result: SSHResult | undefined;
  for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length; attempt++) {
    const backoff = RETRY_BACKOFFS_MS[attempt];
    if (backoff > 0) {
      logDebug(
        `SSH to ${machine.name} via ${ep.label}: transient failure, ` +
        `backing off ${backoff}ms before retry ${attempt}/${RETRY_BACKOFFS_MS.length - 1}`,
      );
      await sleep(backoff);
    }
    result = await sshExecSingle(
      machine, ep.host, ep.port, ep.timeoutS, command, timeoutMs,
    );
    if (
      result.exitCode === 255 &&
      isConnectionFailure(result.stderr) &&
      isTransientClientFailure(result.stderr) &&
      attempt < RETRY_BACKOFFS_MS.length - 1
    ) {
      logWarn(
        `SSH to ${machine.name} via ${ep.label} hit transient client failure ` +
        `(${result.stderr.trim().split('\n').pop()}), retrying on same path`,
      );
      continue;
    }
    break;
  }

  const finalResult = result!;
  const connected =
    finalResult.exitCode !== 255 || !isConnectionFailure(finalResult.stderr);
  if (connected) {
    logDebug(
      `SSH to ${machine.name} connected via ${ep.label} ` +
      `(${ep.host}:${ep.port})`,
    );
    try { writePathCache(machine.name, kind); } catch { /* best effort */ }
  } else {
    logError(
      `SSH to ${machine.name} via ${ep.label} failed ` +
      `(connection failure, ${ep.host}:${ep.port}, no fallback)`,
    );
  }
  return finalResult;
}

/** Result of `sshPingDetailed` — reachability plus which path was used. */
export interface SSHPingResult {
  reachable: boolean;
  /** The endpoint kind that was attempted (the only one we try in 3.4.2+). */
  kind: PathKind;
  /** Human-readable label matching the kind ('LAN' or 'internet'). */
  label: string;
  /** Endpoint host:port that was tried. */
  host: string;
  port: number;
}

/**
 * Check if a remote machine is reachable via SSH and report which path was
 * used. 3.4.2+ policy: single endpoint (Tailscale when configured, LAN
 * otherwise) — no fallback.
 */
export async function sshPingDetailed(
  machine: MachineConfig,
  opts: SSHExecOptions = {},
): Promise<SSHPingResult> {
  const kind = preferredEndpointKind(machine);
  const ep = endpointFor(machine, kind);
  logDebug(
    `SSH ping to ${machine.name} via ${ep.label} ` +
    `(${machine.user}@${ep.host}:${ep.port})`,
  );
  try {
    // Keep this above the 10s internet ConnectTimeout so connection failures
    // surface as SSH exit 255 rather than a top-level process timeout.
    const result = await sshExec(machine, 'echo pong', 15000, opts);
    const reachable = result.exitCode === 0 && result.stdout.trim() === 'pong';
    logInfo(`SSH ping ${machine.name}: ${reachable ? 'ONLINE' : 'OFFLINE'} via ${ep.label}`);
    return { reachable, kind, label: ep.label, host: ep.host, port: ep.port };
  } catch {
    logInfo(`SSH ping ${machine.name}: OFFLINE via ${ep.label} (error)`);
    return { reachable: false, kind, label: ep.label, host: ep.host, port: ep.port };
  }
}

/**
 * Back-compat boolean wrapper around `sshPingDetailed`. Prefer the detailed
 * variant in new call sites so the UI can surface which path was used.
 */
export async function sshPing(
  machine: MachineConfig,
  opts: SSHExecOptions = {},
): Promise<boolean> {
  return (await sshPingDetailed(machine, opts)).reachable;
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
  const destExpr = shellDoubleQuotePath(remotePath);
  const tmpName = `.agent-bridge-${randomUUID()}.tmp`;
  // Write to a hidden temp file in the target directory and atomically rename
  // it into place. Native watchers listen for *.json creation, so direct writes
  // can expose partial JSON and lose a message if the watcher quarantines it.
  const command = [
    `dest=${destExpr}`,
    'dir="$(dirname "$dest")"',
    `tmp="$dir/${tmpName}"`,
    'mkdir -p "$dir"',
    'trap \'rm -f "$tmp"\' EXIT',
    `echo '${b64}' | base64 -d > "$tmp"`,
    'mv -f "$tmp" "$dest"',
  ].join(' && ');
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

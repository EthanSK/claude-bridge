/**
 * SSH execution wrapper for agent-bridge.
 * Runs commands on remote machines using the SSH keys from v1.
 *
 * Logs all connection attempts and results.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { type MachineConfig } from './config.js';
import { logDebug, logError, logInfo } from './logger.js';

/** Maximum time to wait for the SSH TCP connection to establish. */
const SSH_CONNECT_TIMEOUT_S = 10;

export interface SSHResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Build the common SSH argument list for a machine.
 */
function buildSSHArgs(machine: MachineConfig, port?: number): string[] {
  return [
    '-i', machine.key,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    '-o', 'LogLevel=ERROR',
    '-p', String(port ?? machine.port),
    `${machine.user}@${machine.host}`,
  ];
}

/**
 * Run a command on a remote machine via SSH.
 */
export async function sshExec(
  machine: MachineConfig,
  command: string,
  timeoutMs: number = 30000,
): Promise<SSHResult> {
  if (!existsSync(machine.key)) {
    throw new Error(`SSH key not found: ${machine.key}`);
  }

  const args = [...buildSSHArgs(machine), command];

  logDebug(`SSH exec to ${machine.name}: ${command.substring(0, 200)}`);

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
      logError(`SSH command timed out after ${timeoutMs}ms to ${machine.name}`);
      reject(new Error(`SSH command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? 1;
      logDebug(
        `SSH to ${machine.name} completed: exit=${exitCode}, stdout=${stdout.length}B, stderr=${stderr.length}B`,
      );
      resolve({ exitCode, stdout, stderr });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logError(`SSH spawn error to ${machine.name}: ${err.message}`);
      reject(err);
    });
  });
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
  const command = `mkdir -p "$(dirname '${remotePath}')" && echo '${b64}' | base64 -d > '${remotePath}'`;
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

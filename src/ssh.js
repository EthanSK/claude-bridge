import { Client } from "ssh2";
import { readFileSync } from "fs";
import { spawn } from "child_process";
import { getMachine } from "./config.js";

/**
 * Execute a command on a remote machine via SSH.
 * Returns { stdout, stderr, code }.
 */
export function sshExec(machineName, command, opts = {}) {
  return new Promise((resolve, reject) => {
    const machine = getMachine(machineName);
    if (!machine) {
      return reject(new Error(`Machine "${machineName}" not found. Run "claude-bridge list" to see paired machines.`));
    }

    const conn = new Client();
    let stdout = "";
    let stderr = "";

    const timeout = opts.timeout || 30000;
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`SSH command timed out after ${timeout / 1000}s`));
    }, timeout);

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          conn.end();
          return reject(err);
        }

        stream.on("close", (code) => {
          clearTimeout(timer);
          conn.end();
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
        });

        stream.on("data", (data) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data) => {
          stderr += data.toString();
        });
      });
    });

    conn.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    const connOpts = {
      host: machine.host,
      port: parseInt(machine.port) || 22,
      username: machine.user,
      readyTimeout: 10000,
    };

    if (machine.privateKeyPath) {
      try {
        connOpts.privateKey = readFileSync(machine.privateKeyPath);
      } catch (e) {
        return reject(
          new Error(`Could not read private key at ${machine.privateKeyPath}: ${e.message}`)
        );
      }
    }

    conn.connect(connOpts);
  });
}

/**
 * Check if a machine is reachable via SSH.
 * Returns { reachable: boolean, latencyMs: number, error?: string }.
 */
export function sshPing(machineName) {
  return new Promise((resolve) => {
    const start = Date.now();
    const machine = getMachine(machineName);
    if (!machine) {
      return resolve({
        reachable: false,
        latencyMs: 0,
        error: `Machine "${machineName}" not found`,
      });
    }

    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      resolve({
        reachable: false,
        latencyMs: Date.now() - start,
        error: "Connection timed out",
      });
    }, 5000);

    conn.on("ready", () => {
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      conn.end();
      resolve({ reachable: true, latencyMs });
    });

    conn.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        reachable: false,
        latencyMs: Date.now() - start,
        error: err.message,
      });
    });

    const connOpts = {
      host: machine.host,
      port: parseInt(machine.port) || 22,
      username: machine.user,
      readyTimeout: 5000,
    };

    if (machine.privateKeyPath) {
      try {
        connOpts.privateKey = readFileSync(machine.privateKeyPath);
      } catch {
        return resolve({
          reachable: false,
          latencyMs: 0,
          error: "Could not read private key",
        });
      }
    }

    conn.connect(connOpts);
  });
}

/**
 * Open an interactive SSH shell (spawns ssh binary directly for full PTY).
 */
export function sshInteractive(machineName) {
  return new Promise((resolve, reject) => {
    const machine = getMachine(machineName);
    if (!machine) {
      return reject(new Error(`Machine "${machineName}" not found.`));
    }

    const args = [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-p", String(machine.port || 22),
    ];

    if (machine.privateKeyPath) {
      args.push("-i", machine.privateKeyPath);
    }

    args.push(`${machine.user}@${machine.host}`);

    const child = spawn("ssh", args, {
      stdio: "inherit",
    });

    child.on("close", (code) => {
      resolve(code);
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

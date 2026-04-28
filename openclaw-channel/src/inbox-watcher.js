/**
 * Inbox watcher for the openclaw side of agent-bridge.
 *
 * As of v2.1.0 the single global inbox has been split into per-harness /
 * per-target subdirs under `~/.agent-bridge/inbox/`. This watcher walks
 * `inbox/openclaw/<targetName>/*.json` for each configured target and
 * dispatches messages to the caller-provided handler, tagging each dispatch
 * with the target name so `index.js` can route into the matching Telegram
 * session.
 *
 * Zero external dependencies — Node builtins only (fs, path, os).
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  appendFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { parseBridgeMessage } from "./envelope.js";

const DEFAULT_POLL_MS = 2000;
const DEFAULT_INBOX_ROOT = join(homedir(), ".agent-bridge", "inbox");
const DEFAULT_LEDGER = join(homedir(), ".agent-bridge", ".openclaw-v2-delivered");
const DEFAULT_ARCHIVE_ROOT = join(homedir(), ".agent-bridge", "archive", "openclaw");
const DEFAULT_LEASE_PATH = join(homedir(), ".agent-bridge", "locks", "openclaw.watcher-lock.json");
const OPENCLAW_HARNESS_PREFIX = "openclaw";
const LEASE_STALE_MS = 15_000;
const LEASE_HEARTBEAT_MS = 5_000;
const MAX_HEARTBEAT_FAILURES = 3;

/**
 * @typedef {Object} TargetSpec
 * @property {string} name               e.g. "default", "clawdiboi2"
 * @property {string} dir                absolute path of the watched subdir
 * @property {object} config             resolved target config block (openclaw_channel, account, peer_id, ...)
 */

/**
 * Start the multi-target inbox watcher.
 *
 * @param {object} opts
 * @param {string} [opts.inboxRoot]      absolute path of ~/.agent-bridge/inbox (defaults to homedir/.agent-bridge/inbox)
 * @param {string} [opts.ledgerPath]     absolute path of the delivered-id ledger
 * @param {string} [opts.leasePath]      cross-process watcher lease path
 * @param {number} [opts.pollIntervalMs] polling interval per subdir (default 2000)
 * @param {object} [opts.logger]         logger with {info,warn,error,debug}
 * @param {Record<string, object>} opts.targets  map of <targetName> -> target config. The watcher creates and watches a subdir per target.
 * @param {(msg: object, ctx: {filePath:string, target:TargetSpec}) => Promise<void>|void} opts.onMessage
 * @returns {() => void} stop fn
 */
export function startInboxWatcher(opts) {
  const inboxRoot = opts.inboxRoot ?? DEFAULT_INBOX_ROOT;
  const ledgerPath = opts.ledgerPath ?? DEFAULT_LEDGER;
  const archiveRoot = opts.archiveRoot ?? DEFAULT_ARCHIVE_ROOT;
  const leasePath = opts.leasePath ?? DEFAULT_LEASE_PATH;
  const pollMs = Math.max(500, opts.pollIntervalMs ?? DEFAULT_POLL_MS);
  const log = opts.logger ?? console;
  const onMessage = opts.onMessage;
  const targetsMap = opts.targets ?? {};
  const failedRoot = failedRootFor(inboxRoot);
  const unroutedDir = unroutedSubdir(inboxRoot);

  // Ensure the harness root + each target subdir exist up front so the host
  // can drop files in straight away. Also mkdir the `_unrouted/` quarantine
  // dir so legacy flat files have a place to land.
  mkdirSync(join(inboxRoot, OPENCLAW_HARNESS_PREFIX), { recursive: true });
  mkdirSync(dirname(ledgerPath), { recursive: true });
  mkdirSync(unroutedDir, { recursive: true });
  mkdirSync(archiveRoot, { recursive: true });

  /** @type {TargetSpec[]} */
  const targets = Object.keys(targetsMap).flatMap((name) => {
    if (!isValidTargetName(name)) {
      log.warn?.(`target "${name}" has an invalid subdir name — skipping`);
      return [];
    }
    const dir = join(inboxRoot, OPENCLAW_HARNESS_PREFIX, name);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      log.warn?.(`unable to mkdir target dir ${dir}: ${err?.message ?? err}`);
    }
    return [{ name, dir, config: targetsMap[name] }];
  });

  if (targets.length === 0) {
    log.warn?.(
      "inbox watcher: no targets configured — the plugin will not dispatch any messages. "
      + 'Add `channels["agent-bridge"].config.targets = { default: {...}, ... }` to openclaw.json.',
    );
  } else {
    log.info?.(
      `watching ${targets.length} target(s) under ${inboxRoot}/${OPENCLAW_HARNESS_PREFIX}/: `
      + targets.map((t) => t.name).join(", "),
    );
  }

  const delivered = loadLedger(ledgerPath);
  let stopped = false;
  let timer = null;
  let standbyTimer = null;
  let leaseHeartbeat = null;
  let leaseMeta = null;
  let heartbeatFailures = 0;
  let scanning = false;

  async function scanOneTarget(target) {
    const entries = safeReaddir(target.dir);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const fullPath = join(target.dir, name);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;

      let raw;
      try {
        raw = readFileSync(fullPath, "utf8");
      } catch (err) {
        log.warn?.(`unable to read ${target.name}/${name}: ${err?.message ?? err}`);
        continue;
      }
      const msg = parseBridgeMessage(raw);
      if (!msg) {
        log.warn?.(`inbox: skipping invalid envelope ${target.name}/${name}`);
        quarantine(fullPath, target.name, failedRoot);
        continue;
      }
      const expectedTarget = `${OPENCLAW_HARNESS_PREFIX}/${target.name}`;
      if (msg.target !== expectedTarget) {
        log.warn?.(
          `inbox: target mismatch for ${target.name}/${name}: expected ${expectedTarget}, got ${JSON.stringify(msg.target ?? null)}`,
        );
        quarantine(fullPath, target.name, failedRoot);
        continue;
      }
      if (delivered.has(msg.id)) continue;

      let deliveredOk;
      try {
        deliveredOk = await onMessage(msg, { filePath: fullPath, target });
      } catch (err) {
        log.error?.(`inbox: dispatch failed for ${target.name}/${msg.id}: ${err?.stack || err}`);
        // Move to .failed/ so we don't re-process this message every poll.
        quarantine(fullPath, target.name, failedRoot);
        continue;
      }
      if (deliveredOk === false) {
        // Handler chose to retry later — leave file in place, don't ledger.
        continue;
      }
      // Dispatch succeeded: move file to archive FIRST, then ledger. If the
      // archive move fails, treat as a failed dispatch (quarantine + don't
      // ledger) so we don't end up with a ledgered-but-still-present file
      // that re-blocks the slot.
      const moved = archiveFile(fullPath, target.name, archiveRoot, log);
      if (!moved) {
        quarantine(fullPath, target.name, failedRoot);
        continue;
      }
      delivered.add(msg.id);
      appendLedger(ledgerPath, msg.id);
    }
  }

  async function scanUnrouted() {
    // Sweep any flat-file messages sitting at the root of inbox/openclaw/ or
    // at the root of inbox/ itself (legacy senders running agent-bridge < 3.4.0).
    // These can't be routed deterministically — per design there's no default
    // routing — so shove them into .failed/_unrouted/ with a loud log line.
    const legacyCandidates = [
      inboxRoot,
      join(inboxRoot, OPENCLAW_HARNESS_PREFIX),
    ];
    for (const legacyDir of legacyCandidates) {
      try {
        const entries = readdirSync(legacyDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith(".json")) continue;
          const src = join(legacyDir, entry.name);
          const dest = join(unroutedDir, entry.name);
          try {
            renameSync(src, dest);
            log.warn?.(
              `Legacy flat-file inbox message moved to ${unroutedDir}: ${entry.name}. `
              + `Senders must set BridgeMessage.target (e.g. "openclaw/clawdiboi2").`,
            );
          } catch (err) {
            log.error?.(`failed to quarantine legacy ${src}: ${err?.message ?? err}`);
          }
        }
      } catch {
        /* dir may not exist yet */
      }
    }
  }

  async function scan() {
    if (stopped || scanning) return;
    scanning = true;
    try {
      await scanUnrouted();
      for (const target of targets) {
        if (stopped) break;
        await scanOneTarget(target);
      }
    } finally {
      scanning = false;
      if (!stopped) {
        timer = setTimeout(scan, pollMs);
      }
    }
  }

  function clearActiveTimers() {
    if (timer) clearTimeout(timer);
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    timer = null;
    leaseHeartbeat = null;
  }

  function releaseLease() {
    if (!leaseMeta) return;
    const meta = leaseMeta;
    leaseMeta = null;
    heartbeatFailures = 0;
    try {
      const current = readLease(leasePath);
      if (current?.token === meta.token) {
        unlinkSync(leasePath);
        log.info?.(`inbox watcher: released lease pid=${process.pid}`);
      }
    } catch (err) {
      log.warn?.(`inbox watcher: failed to release lease: ${err?.message ?? err}`);
    }
  }

  function becomeStandby(reason) {
    clearActiveTimers();
    releaseLease();
    if (stopped) return;
    log.warn?.(`inbox watcher: standing by (${reason})`);
    scheduleStandby();
  }

  function renewLease() {
    if (!leaseMeta) return;
    try {
      const current = readLease(leasePath);
      if (!current || current.token !== leaseMeta.token) {
        becomeStandby("lease replaced by another process");
        return;
      }
      leaseMeta.updatedAt = Date.now();
      writeFileSync(leasePath, JSON.stringify(leaseMeta, null, 2), { mode: 0o600 });
      heartbeatFailures = 0;
    } catch (err) {
      heartbeatFailures += 1;
      log.warn?.(
        `inbox watcher: lease heartbeat failed (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): `
        + `${err?.message ?? err}`,
      );
      if (heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
        becomeStandby("lease heartbeat failures");
      }
    }
  }

  function startActive() {
    if (stopped || leaseMeta) return true;
    const acquired = acquireLease(leasePath, "openclaw", log);
    if (!acquired) return false;
    leaseMeta = acquired;
    heartbeatFailures = 0;
    log.info?.(`inbox watcher: acquired lease pid=${process.pid}`);
    leaseHeartbeat = setInterval(renewLease, LEASE_HEARTBEAT_MS);
    leaseHeartbeat.unref?.();
    timer = setTimeout(scan, Math.min(250, pollMs));
    return true;
  }

  function scheduleStandby() {
    if (stopped || standbyTimer) return;
    standbyTimer = setTimeout(function retry() {
      standbyTimer = null;
      if (stopped) return;
      if (startActive()) return;
      standbyTimer = setTimeout(retry, pollMs);
      standbyTimer.unref?.();
    }, Math.min(250, pollMs));
    standbyTimer.unref?.();
  }

  if (!startActive()) {
    log.warn?.(`inbox watcher: lease busy at ${leasePath}; waiting as standby`);
    scheduleStandby();
  }

  return function stop() {
    stopped = true;
    if (standbyTimer) clearTimeout(standbyTimer);
    standbyTimer = null;
    clearActiveTimers();
    releaseLease();
  };
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function loadLedger(path) {
  const set = new Set();
  if (!existsSync(path)) return set;
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (t) set.add(t);
    }
  } catch {
    /* ignore */
  }
  return set;
}

function appendLedger(path, id) {
  try {
    appendFileSync(path, id + "\n");
  } catch {
    /* ignore */
  }
}

function failedRootFor(inboxRoot) {
  return join(inboxRoot, ".failed");
}

function unroutedSubdir(inboxRoot) {
  return join(failedRootFor(inboxRoot), "_unrouted");
}

function isValidTargetName(name) {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name)
  );
}

function archiveFile(filePath, targetName, archiveRoot, log) {
  try {
    const archiveDir = join(archiveRoot, targetName);
    mkdirSync(archiveDir, { recursive: true });
    const base = basename(filePath);
    // Prefix with timestamp so multiple processings of the same id never
    // collide (e.g. after a ledger reset) and to make chronological tailing
    // trivial.
    const stamped = `${new Date().toISOString().replace(/[:.]/g, "-")}_${base}`;
    renameSync(filePath, join(archiveDir, stamped));
    return true;
  } catch (err) {
    log?.warn?.(
      `inbox: failed to archive ${targetName}/${filePath}: ${err?.message ?? err}`,
    );
    return false;
  }
}

function leaseIsStale(filePath, lease) {
  if (!pidIsAlive(lease.pid)) return true;
  try {
    const stats = statSync(filePath);
    const lastUpdated = Math.max(Number(lease.updatedAt) || 0, stats.mtimeMs);
    return Date.now() - lastUpdated > LEASE_STALE_MS;
  } catch {
    return true;
  }
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

function readLease(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const pid = Number(parsed?.pid);
    const startedAt = Number(parsed?.startedAt);
    const updatedAt = Number(parsed?.updatedAt);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (typeof parsed?.target !== "string" || !parsed.target) return null;
    if (typeof parsed?.token !== "string" || !parsed.token) return null;
    if (!Number.isFinite(startedAt) || !Number.isFinite(updatedAt)) return null;
    return {
      pid,
      target: parsed.target,
      token: parsed.token,
      startedAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

function acquireLease(filePath, target, log) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const now = Date.now();
  const meta = {
    pid: process.pid,
    target,
    token: `${process.pid}-${now}-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: now,
    updatedAt: now,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(filePath, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(meta, null, 2));
      } finally {
        closeSync(fd);
      }
      return meta;
    } catch (err) {
      if (err?.code !== "EEXIST") {
        log.warn?.(`inbox watcher: failed to acquire lease ${filePath}: ${err?.message ?? err}`);
        return null;
      }
      const existing = readLease(filePath);
      if (!existing || leaseIsStale(filePath, existing)) {
        try {
          unlinkSync(filePath);
          continue;
        } catch (unlinkErr) {
          log.warn?.(
            `inbox watcher: failed to remove stale lease ${filePath}: `
            + `${unlinkErr?.message ?? unlinkErr}`,
          );
          return null;
        }
      }
      return null;
    }
  }

  return null;
}

function quarantine(filePath, targetName, failedRoot) {
  try {
    const failedDir = join(failedRoot, `${OPENCLAW_HARNESS_PREFIX}__${targetName}`);
    mkdirSync(failedDir, { recursive: true });
    const base = basename(filePath);
    renameSync(filePath, join(failedDir, base));
  } catch {
    // last-resort rename-in-place
    try {
      renameSync(filePath, filePath + ".bad");
    } catch {
      /* ignore */
    }
  }
}

export const __testing = {
  DEFAULT_INBOX_ROOT,
  DEFAULT_LEDGER,
  DEFAULT_ARCHIVE_ROOT,
  DEFAULT_LEASE_PATH,
  UNROUTED_SUBDIR: unroutedSubdir(DEFAULT_INBOX_ROOT),
  OPENCLAW_HARNESS_PREFIX,
};

// Mini-as-master role + peer registry tests (2026-05-04, voice 6286).
//
// Focus: pure-logic coverage of the new code paths in core.mjs. The SFTP
// transport path through emitter.mjs is exercised by the e2e harness in
// chime/e2e/audible-demo.mjs (which writes synthetic events into the local
// inbox) and by the cross-machine simulation documented in the
// agent-completion-chime AGENTS.md.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("roleFor returns master when local machine matches masterMachine", async () => {
  const bridgeHome = mkdtempSync(join(tmpdir(), "agent-bridge-chime-mm-"));
  process.env.AGENT_BRIDGE_HOME = bridgeHome;
  process.env.AGENT_BRIDGE_MACHINE_NAME = "Ethans-Mac-mini";
  try {
    const core = await import(`../core.mjs?mmtest=${Date.now()}-master`);
    assert.equal(core.roleFor({ ...core.DEFAULT_CONFIG }), "master");
    assert.equal(core.masterMachineOf({ ...core.DEFAULT_CONFIG }), "Ethans-Mac-mini");
  } finally {
    rmSync(bridgeHome, { recursive: true, force: true });
    delete process.env.AGENT_BRIDGE_HOME;
    delete process.env.AGENT_BRIDGE_MACHINE_NAME;
  }
});

test("roleFor returns peer when local machine differs from masterMachine", async () => {
  const bridgeHome = mkdtempSync(join(tmpdir(), "agent-bridge-chime-mm-"));
  process.env.AGENT_BRIDGE_HOME = bridgeHome;
  process.env.AGENT_BRIDGE_MACHINE_NAME = "MacBookPro";
  try {
    const core = await import(`../core.mjs?mmtest=${Date.now()}-peer`);
    assert.equal(core.roleFor({ ...core.DEFAULT_CONFIG }), "peer");
    assert.equal(core.masterMachineOf({ ...core.DEFAULT_CONFIG }), "Ethans-Mac-mini");
  } finally {
    rmSync(bridgeHome, { recursive: true, force: true });
    delete process.env.AGENT_BRIDGE_HOME;
    delete process.env.AGENT_BRIDGE_MACHINE_NAME;
  }
});

test("roleFor returns standalone when masterMachine is null", async () => {
  const bridgeHome = mkdtempSync(join(tmpdir(), "agent-bridge-chime-mm-"));
  process.env.AGENT_BRIDGE_HOME = bridgeHome;
  process.env.AGENT_BRIDGE_MACHINE_NAME = "MacBookPro";
  try {
    const core = await import(`../core.mjs?mmtest=${Date.now()}-standalone`);
    assert.equal(core.roleFor({ ...core.DEFAULT_CONFIG, masterMachine: null }), "standalone");
    assert.equal(core.masterMachineOf({ ...core.DEFAULT_CONFIG, masterMachine: null }), null);
  } finally {
    rmSync(bridgeHome, { recursive: true, force: true });
    delete process.env.AGENT_BRIDGE_HOME;
    delete process.env.AGENT_BRIDGE_MACHINE_NAME;
  }
});

test("recordPeerRegistration is idempotent and refreshes lastSeenAt", async () => {
  const bridgeHome = mkdtempSync(join(tmpdir(), "agent-bridge-chime-mm-"));
  process.env.AGENT_BRIDGE_HOME = bridgeHome;
  process.env.AGENT_BRIDGE_MACHINE_NAME = "Ethans-Mac-mini";
  try {
    const core = await import(`../core.mjs?mmtest=${Date.now()}-registry`);
    let registry = core.loadChimePeers();
    assert.deepEqual(registry, { peers: {} });

    registry = core.recordPeerRegistration(
      registry,
      { machine: "MacBookPro", chimeVersion: "1.0.0", pid: 100 },
      1_000,
    );
    core.saveChimePeers(registry);
    let peer = core.loadChimePeers().peers.MacBookPro;
    assert.equal(peer.machine, "MacBookPro");
    assert.equal(peer.registeredAt, 1_000);
    assert.equal(peer.lastSeenAt, 1_000);
    assert.equal(peer.chimeVersion, "1.0.0");

    registry = core.recordPeerRegistration(
      registry,
      { machine: "MacBookPro", chimeVersion: "1.0.0", pid: 100 },
      2_000,
    );
    core.saveChimePeers(registry);
    peer = core.loadChimePeers().peers.MacBookPro;
    assert.equal(peer.registeredAt, 1_000); // unchanged on re-register
    assert.equal(peer.lastSeenAt, 2_000);   // refreshed

    registry = core.recordPeerRegistration(
      registry,
      { machine: "SHITTYWINDOWS", chimeVersion: "1.0.0", pid: 200 },
      3_000,
    );
    core.saveChimePeers(registry);
    const both = core.loadChimePeers().peers;
    assert.equal(Object.keys(both).length, 2);
    assert.ok(both.MacBookPro);
    assert.ok(both.SHITTYWINDOWS);
  } finally {
    rmSync(bridgeHome, { recursive: true, force: true });
    delete process.env.AGENT_BRIDGE_HOME;
    delete process.env.AGENT_BRIDGE_MACHINE_NAME;
  }
});

test("recordPeerRegistration ignores blank machine names", async () => {
  const bridgeHome = mkdtempSync(join(tmpdir(), "agent-bridge-chime-mm-"));
  process.env.AGENT_BRIDGE_HOME = bridgeHome;
  process.env.AGENT_BRIDGE_MACHINE_NAME = "Ethans-Mac-mini";
  try {
    const core = await import(`../core.mjs?mmtest=${Date.now()}-blank`);
    let registry = { peers: {} };
    registry = core.recordPeerRegistration(registry, { machine: "" }, 1_000);
    registry = core.recordPeerRegistration(registry, { machine: "   " }, 1_000);
    registry = core.recordPeerRegistration(registry, {}, 1_000);
    assert.deepEqual(registry, { peers: {} });
  } finally {
    rmSync(bridgeHome, { recursive: true, force: true });
    delete process.env.AGENT_BRIDGE_HOME;
    delete process.env.AGENT_BRIDGE_MACHINE_NAME;
  }
});

test("playSound accepts rate parameter without throwing", async () => {
  const bridgeHome = mkdtempSync(join(tmpdir(), "agent-bridge-chime-mm-"));
  process.env.AGENT_BRIDGE_HOME = bridgeHome;
  try {
    const core = await import(`../core.mjs?mmtest=${Date.now()}-rate`);
    // Just exercise the call. afplay spawn is detached + stdio:ignore so the
    // test doesn't actually emit audio (and the unknown-sound name avoids
    // a real playback).
    const ok = core.playSound("Glass", 0.0, 1.05);
    assert.equal(typeof ok, "boolean");
  } finally {
    rmSync(bridgeHome, { recursive: true, force: true });
    delete process.env.AGENT_BRIDGE_HOME;
  }
});

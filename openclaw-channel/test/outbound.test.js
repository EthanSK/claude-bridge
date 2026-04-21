import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { localMachineName } from "../src/outbound.js";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-openclaw-channel-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("AGENT_BRIDGE_MACHINE_NAME override wins unchanged", () => {
  withTempDir((dir) => {
    const nameFilePath = join(dir, "machine-name");
    const identityPath = join(dir, ".identity");
    writeFileSync(nameFilePath, "PinnedName\n");
    writeFileSync(identityPath, join(dir, "keys", "agent-bridge_IdentityName"));

    assert.equal(
      localMachineName({
        env: { AGENT_BRIDGE_MACHINE_NAME: "MacBookPro.lan" },
        nameFilePath,
        identityPath,
        getHostname: () => "HostName.local",
      }),
      "MacBookPro.lan",
    );
  });
});

test("machine-name file beats identity and hostname fallback", () => {
  withTempDir((dir) => {
    const nameFilePath = join(dir, "machine-name");
    const identityPath = join(dir, ".identity");
    writeFileSync(nameFilePath, "PinnedName\n");
    writeFileSync(identityPath, join(dir, "keys", "agent-bridge_IdentityName"));

    assert.equal(
      localMachineName({
        env: {},
        nameFilePath,
        identityPath,
        getHostname: () => "HostName.local",
      }),
      "PinnedName",
    );
  });
});

test("setup identity yields a stable machine label when available", () => {
  withTempDir((dir) => {
    const identityPath = join(dir, ".identity");
    writeFileSync(identityPath, join(dir, "keys", "agent-bridge_MacBookPro"));

    assert.equal(
      localMachineName({
        env: {},
        nameFilePath: join(dir, "missing-machine-name"),
        identityPath,
        getHostname: () => "Ethans-MacBook-Pro.local",
      }),
      "MacBookPro",
    );
  });
});

test("hostname fallback strips .local", () => {
  assert.equal(
    localMachineName({
      env: {},
      nameFilePath: join(tmpdir(), "definitely-missing-machine-name"),
      identityPath: join(tmpdir(), "definitely-missing-identity"),
      getHostname: () => "Ethans-MacBook-Pro.local",
    }),
    "Ethans-MacBook-Pro",
  );
});

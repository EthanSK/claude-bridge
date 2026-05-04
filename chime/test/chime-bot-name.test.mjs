// Tests for chime/bot-name.mjs (2026-05-04, voice 6308).
//
// Verifies the static-map / cache / fallback resolution order, the speech
// format strings, and the shortenMachineNameForSpeech helper.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("resolveBotNameSync prefers the static map over cache", async () => {
  const bridgeHome = mkdtempSync(join(tmpdir(), "agent-bridge-chime-bn-"));
  process.env.AGENT_BRIDGE_HOME = bridgeHome;
  process.env.AGENT_BRIDGE_MACHINE_NAME = "Ethans-Mac-mini";
  try {
    const botName = await import(`../bot-name.mjs?bn=${Date.now()}-static`);
    const config = { botNamesByMachine: { "Ethans-Mac-mini": "StaticMapBot" } };
    assert.equal(botName.resolveBotNameSync({ machine: "Ethans-Mac-mini", config }), "StaticMapBot");
  } finally {
    rmSync(bridgeHome, { recursive: true, force: true });
    delete process.env.AGENT_BRIDGE_HOME;
    delete process.env.AGENT_BRIDGE_MACHINE_NAME;
  }
});

test("resolveBotNameSync returns null for unknown machine", async () => {
  const bridgeHome = mkdtempSync(join(tmpdir(), "agent-bridge-chime-bn-"));
  process.env.AGENT_BRIDGE_HOME = bridgeHome;
  try {
    const botName = await import(`../bot-name.mjs?bn=${Date.now()}-unknown`);
    assert.equal(botName.resolveBotNameSync({ machine: "NeverHeardOf", config: {} }), null);
    assert.equal(botName.resolveBotNameSync({}), null);
    assert.equal(botName.resolveBotNameSync({ machine: "" }), null);
  } finally {
    rmSync(bridgeHome, { recursive: true, force: true });
    delete process.env.AGENT_BRIDGE_HOME;
  }
});

test("resolveBotNameSync uses cache when no static-map hit", async () => {
  const bridgeHome = mkdtempSync(join(tmpdir(), "agent-bridge-chime-bn-"));
  process.env.AGENT_BRIDGE_HOME = bridgeHome;
  try {
    // core.mjs read AGENT_BRIDGE_HOME at first import; re-imports with cache-
    // busting query strings re-evaluate it. Use a fresh import to re-resolve
    // CHIME_DIR for THIS bridge home, then materialize the chime dir.
    const core = await import(`../core.mjs?bn=${Date.now()}-coredir`);
    core.ensureChimeDirs();
    const botName = await import(`../bot-name.mjs?bn=${Date.now()}-cache`);
    const cachePath = botName.botNameCachePath();
    mkdirSync(join(bridgeHome, "chime"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({
      "CachedHost": { bot_name: "CachedBot", cached_at: Date.now() },
    }));
    assert.equal(botName.resolveBotNameSync({ machine: "CachedHost", config: {} }), "CachedBot");
  } finally {
    rmSync(bridgeHome, { recursive: true, force: true });
    delete process.env.AGENT_BRIDGE_HOME;
  }
});

test("resolveBotNameSync ignores stale cache entries", async () => {
  const bridgeHome = mkdtempSync(join(tmpdir(), "agent-bridge-chime-bn-"));
  process.env.AGENT_BRIDGE_HOME = bridgeHome;
  try {
    const core = await import(`../core.mjs?bn=${Date.now()}-coredir2`);
    core.ensureChimeDirs();
    const botName = await import(`../bot-name.mjs?bn=${Date.now()}-stale`);
    mkdirSync(join(bridgeHome, "chime"), { recursive: true });
    const stale = Date.now() - 30 * 24 * 60 * 60 * 1000;
    writeFileSync(botName.botNameCachePath(), JSON.stringify({
      "StaleHost": { bot_name: "StaleBot", cached_at: stale },
    }));
    assert.equal(botName.resolveBotNameSync({ machine: "StaleHost", config: {} }), null);
  } finally {
    rmSync(bridgeHome, { recursive: true, force: true });
    delete process.env.AGENT_BRIDGE_HOME;
  }
});

test("speechForChime builds correct strings", async () => {
  const botName = await import(`../bot-name.mjs?bn=${Date.now()}-speech`);
  assert.equal(
    botName.speechForChime({ kind: "all_complete", bot_name: "Realclaude4bot", machine_fallback: "Mini" }),
    "Realclaude4bot all complete",
  );
  assert.equal(
    botName.speechForChime({ kind: "per_agent", bot_name: "Lemaciboi5bot", machine_fallback: "MBP" }),
    "Lemaciboi5bot subagent complete",
  );
});

test("speechForChime falls back to machine name when bot_name absent", async () => {
  const botName = await import(`../bot-name.mjs?bn=${Date.now()}-fallback`);
  assert.equal(
    botName.speechForChime({ kind: "all_complete", bot_name: null, machine_fallback: "Mac mini" }),
    "Mac mini all complete",
  );
  assert.equal(
    botName.speechForChime({ kind: "per_agent", bot_name: "", machine_fallback: "MacBookPro" }),
    "MacBookPro subagent complete",
  );
});

test("speechForChime returns null when nothing to say", async () => {
  const botName = await import(`../bot-name.mjs?bn=${Date.now()}-null`);
  assert.equal(botName.speechForChime({ kind: "all_complete" }), null);
  assert.equal(botName.speechForChime({ kind: "per_agent", bot_name: "", machine_fallback: "" }), null);
});

test("shortenMachineNameForSpeech normalizes machine names", async () => {
  const botName = await import(`../bot-name.mjs?bn=${Date.now()}-shorten`);
  assert.equal(botName.shortenMachineNameForSpeech("Ethans-Mac-mini.local"), "Mac mini");
  assert.equal(botName.shortenMachineNameForSpeech("Ethans-Mac-mini"), "Mac mini");
  assert.equal(botName.shortenMachineNameForSpeech("MacBookPro"), "MacBookPro");
  assert.equal(botName.shortenMachineNameForSpeech("SHITTYWINDOWS"), "SHITTYWINDOWS");
  assert.equal(botName.shortenMachineNameForSpeech(""), "");
  assert.equal(botName.shortenMachineNameForSpeech(null), "");
});

test("fetchBotUsernameFromTelegram returns username from getMe-like response", async () => {
  const botName = await import(`../bot-name.mjs?bn=${Date.now()}-fetch`);
  let calledUrl = null;
  const fakeFetch = async (url) => {
    calledUrl = url;
    return {
      ok: true,
      json: async () => ({ ok: true, result: { id: 123, username: "TestBot" } }),
    };
  };
  const name = await botName.fetchBotUsernameFromTelegram("fake-token", { fetchImpl: fakeFetch });
  assert.equal(name, "TestBot");
  assert.ok(calledUrl.includes("getMe"));
});

test("fetchBotUsernameFromTelegram returns null on api error", async () => {
  const botName = await import(`../bot-name.mjs?bn=${Date.now()}-fetcherr`);
  const fakeFetch = async () => ({ ok: false });
  assert.equal(await botName.fetchBotUsernameFromTelegram("fake-token", { fetchImpl: fakeFetch }), null);

  const fakeFetch2 = async () => ({ ok: true, json: async () => ({ ok: false }) });
  assert.equal(await botName.fetchBotUsernameFromTelegram("fake-token", { fetchImpl: fakeFetch2 }), null);
});

test("refreshLocalBotNameCache uses cached value within TTL", async () => {
  const bridgeHome = mkdtempSync(join(tmpdir(), "agent-bridge-chime-bn-"));
  process.env.AGENT_BRIDGE_HOME = bridgeHome;
  try {
    const core = await import(`../core.mjs?bn=${Date.now()}-coredir3`);
    core.ensureChimeDirs();
    const botName = await import(`../bot-name.mjs?bn=${Date.now()}-refresh`);
    mkdirSync(join(bridgeHome, "chime"), { recursive: true });
    writeFileSync(botName.botNameCachePath(), JSON.stringify({
      "FreshHost": { bot_name: "FreshBot", cached_at: Date.now() },
    }));
    let fetchCalled = false;
    const fakeFetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
    const result = await botName.refreshLocalBotNameCache({
      local_machine: "FreshHost",
      fetchImpl: fakeFetch,
    });
    assert.equal(result, "FreshBot");
    assert.equal(fetchCalled, false, "should not call fetch when cache is fresh");
  } finally {
    rmSync(bridgeHome, { recursive: true, force: true });
    delete process.env.AGENT_BRIDGE_HOME;
  }
});

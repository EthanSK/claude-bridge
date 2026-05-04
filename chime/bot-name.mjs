// =============================================================================
// chime/bot-name.mjs — resolve the Telegram bot name bound to a given machine,
// so the master daemon can `say` "Realclaude4bot all complete" / "Lemaciboi5bot
// subagent complete" when processing forwarded peer events.
//
// Established 2026-05-04 (Ethan voice 6308):
//   "I wanted to try and be the Telegram name that I'm communicating with,
//    because that's the one I see, right? The name of the bot."
//
// =============================================================================
// Resolution order
// =============================================================================
//
//   1. Static map in chime config: `botNamesByMachine[<machine>]`. Authoritative
//      when set — Ethan can hand-edit it. Lives in
//      ~/.agent-bridge/chime/config.json.
//   2. AUTO-DERIVE for the LOCAL machine only. We can't auto-derive a peer's
//      bot name because we don't have its bot token — only THIS machine's
//      Telegram plugin has its own .env.
//      a. If a fresh cache entry exists in
//         ~/.agent-bridge/chime/bot-name.cache.json (< 7 days old), use it.
//      b. Otherwise, read ~/.claude/channels/telegram/.env for
//         TELEGRAM_BOT_TOKEN, call Telegram's getMe API once, cache the
//         resulting `result.username`, return it.
//      c. If the token isn't there or the API call fails, return null.
//   3. Fall back to a short machine name (caller's responsibility).
//
// The cache TTL is 7 days because bot usernames are basically permanent —
// Ethan would only ever change one if he re-pairs to a new bot.
//
// The auto-derive HTTP call is sync-only-when-cached. The first-ever call
// goes async (returns null, populates cache for next iteration). This keeps
// the chime daemon's processInboxOnce loop from ever blocking on a network
// call.
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolve the chime dir at CALL time, not at module load time. This is the
 * same logic core.mjs uses for CHIME_DIR but evaluated lazily so test code
 * that flips AGENT_BRIDGE_HOME between tests sees the right path.
 */
function chimeDir() {
  const bridgeHome = process.env.AGENT_BRIDGE_HOME
    ? process.env.AGENT_BRIDGE_HOME.replace(/^~/, homedir())
    : join(homedir(), ".agent-bridge");
  return join(bridgeHome, "chime");
}

export function botNameCachePath() {
  return join(chimeDir(), "bot-name.cache.json");
}

function telegramEnvPath() {
  return join(homedir(), ".claude", "channels", "telegram", ".env");
}

function loadCache() {
  const p = botNameCachePath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  const p = botNameCachePath();
  try {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch {}
}

export function readLocalTelegramToken() {
  const path = telegramEnvPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
  return null;
}

export async function fetchBotUsernameFromTelegram(token, { fetchImpl = globalThis.fetch } = {}) {
  if (!token || !fetchImpl) return null;
  try {
    const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    let resp;
    try {
      resp = await fetchImpl(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!resp || !resp.ok) return null;
    const data = await resp.json();
    if (data && data.ok === true && data.result && typeof data.result.username === "string") {
      return data.result.username;
    }
  } catch {}
  return null;
}

/**
 * SYNC lookup, cache-only. Returns the bot name for `machine` or null. Never
 * blocks on the network — that's the job of `refreshLocalBotNameCache`.
 *
 * `config` should have `botNamesByMachine` (map of machine -> bot username).
 */
export function resolveBotNameSync({ machine, config } = {}) {
  if (!machine) return null;
  const map = (config && typeof config.botNamesByMachine === "object" && config.botNamesByMachine) || {};
  if (typeof map[machine] === "string" && map[machine].trim()) return map[machine].trim();
  const cache = loadCache();
  const entry = cache[machine];
  if (entry && typeof entry.bot_name === "string" && entry.bot_name.trim()) {
    const ts = Number(entry.cached_at ?? 0);
    if (Date.now() - ts < CACHE_TTL_MS) return entry.bot_name.trim();
  }
  return null;
}

export async function refreshLocalBotNameCache({
  local_machine,
  fetchImpl = globalThis.fetch,
  forceRefresh = false,
} = {}) {
  if (!local_machine) return null;
  const cache = loadCache();
  const entry = cache[local_machine];
  if (!forceRefresh && entry && typeof entry.bot_name === "string") {
    const ts = Number(entry.cached_at ?? 0);
    if (Date.now() - ts < CACHE_TTL_MS) return entry.bot_name;
  }
  const token = readLocalTelegramToken();
  if (!token) return null;
  const name = await fetchBotUsernameFromTelegram(token, { fetchImpl });
  if (!name) return null;
  cache[local_machine] = { bot_name: name, cached_at: Date.now() };
  saveCache(cache);
  return name;
}

/**
 * Build the spoken phrase for a chime event.
 *
 *   kind = 'all_complete' | 'per_agent'
 *   bot_name = resolved bot username, or null
 *   machine_fallback = a short machine name to use when bot_name is null
 *                      (e.g. "Mac mini" / "MacBookPro")
 *
 * Returns null when there's nothing to say.
 */
export function speechForChime({ kind, bot_name, machine_fallback }) {
  const name = (bot_name && bot_name.trim()) || (machine_fallback && machine_fallback.trim()) || "";
  if (!name) return null;
  const suffix = kind === "all_complete" ? "all complete" : "subagent complete";
  return `${name} ${suffix}`;
}

export function shortenMachineNameForSpeech(machine) {
  if (!machine || typeof machine !== "string") return "";
  let s = machine.trim().replace(/\.local$/i, "");
  s = s.replace(/^Ethans?[- _]+/i, "");
  s = s.replace(/[-_]+/g, " ");
  return s.trim();
}

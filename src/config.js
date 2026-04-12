import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".claude-bridge");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const KEYS_DIR = join(CONFIG_DIR, "keys");

export function getConfigDir() {
  return CONFIG_DIR;
}

export function getKeysDir() {
  return KEYS_DIR;
}

export function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(KEYS_DIR)) {
    mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadConfig() {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    return { machines: {} };
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return { machines: {} };
  }
}

export function saveConfig(config) {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

export function getMachine(name) {
  const config = loadConfig();
  // Case-insensitive lookup
  const key = Object.keys(config.machines).find(
    (k) => k.toLowerCase() === name.toLowerCase()
  );
  return key ? config.machines[key] : null;
}

export function saveMachine(name, details) {
  const config = loadConfig();
  config.machines[name] = {
    ...details,
    pairedAt: new Date().toISOString(),
  };
  saveConfig(config);
}

export function removeMachine(name) {
  const config = loadConfig();
  const key = Object.keys(config.machines).find(
    (k) => k.toLowerCase() === name.toLowerCase()
  );
  if (key) {
    delete config.machines[key];
    saveConfig(config);
    return true;
  }
  return false;
}

export function listMachines() {
  const config = loadConfig();
  return config.machines;
}

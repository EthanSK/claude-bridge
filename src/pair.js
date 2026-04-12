import { existsSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { join, resolve } from "path";
import chalk from "chalk";
import ora from "ora";
import { saveMachine, ensureConfigDir, getKeysDir } from "./config.js";

/**
 * Try to extract pairing data from a photo.
 * Claude Code can read images natively — this function provides
 * guidance for that workflow. For automated extraction, we look
 * for a claude-bridge:// URI in text or try to parse JSON.
 */
function tryExtractFromText(text) {
  // Look for claude-bridge:// URI with base64 payload
  const uriMatch = text.match(/claude-bridge:\/\/([A-Za-z0-9+/=]+)/);
  if (uriMatch) {
    try {
      const json = Buffer.from(uriMatch[1], "base64").toString("utf8");
      return JSON.parse(json);
    } catch {
      // Not valid base64/JSON
    }
  }

  // Try to parse as raw JSON
  try {
    const data = JSON.parse(text);
    if (data.name && data.host && data.user) {
      return data;
    }
  } catch {
    // Not JSON
  }

  // Try to extract fields from structured text (like the pairing screen output)
  const fields = {};
  const patterns = {
    name: /Machine Name:\s*(.+)/i,
    user: /Username:\s*(.+)/i,
    hostname: /Hostname:\s*(.+)/i,
    host: /Local IP:\s*([0-9.]+)/i,
    port: /SSH Port:\s*(\d+)/i,
    fingerprint: /Fingerprint:\s*(.+)/i,
    code: /Pairing Code:\s*(.+)/i,
  };

  for (const [key, pattern] of Object.entries(patterns)) {
    const match = text.match(pattern);
    if (match) {
      fields[key] = match[1].trim();
    }
  }

  if (fields.name && fields.host && fields.user) {
    return fields;
  }

  return null;
}

export async function pair(photoPath, options) {
  console.log();
  console.log(
    chalk.bold.cyan("  claude-bridge pair")
  );
  console.log();

  let pairingData = null;

  // Manual mode
  if (options.manual || (options.host && options.user)) {
    if (!options.host || !options.user) {
      console.log(
        chalk.red("  Error: --host and --user are required for manual pairing.")
      );
      console.log(
        chalk.dim("  Usage: claude-bridge pair --manual --name myMac --host 192.168.1.10 --user ethan --key ~/.claude-bridge/keys/key")
      );
      process.exit(1);
    }

    pairingData = {
      name: options.name || options.host,
      host: options.host,
      port: options.port || "22",
      user: options.user,
      code: options.code || null,
      fingerprint: null,
      privateKey: null,
    };

    if (options.key) {
      pairingData.privateKeyPath = resolve(options.key);
    }
  }

  // Photo mode
  if (!pairingData && photoPath) {
    const resolvedPath = resolve(photoPath);
    if (!existsSync(resolvedPath)) {
      console.log(chalk.red(`  Error: File not found: ${resolvedPath}`));
      process.exit(1);
    }

    // Check if it's a text file (e.g., copied pairing data)
    const ext = resolvedPath.toLowerCase();
    if (ext.endsWith(".json") || ext.endsWith(".txt")) {
      const spinner = ora("  Reading pairing data...").start();
      try {
        const content = readFileSync(resolvedPath, "utf8");
        pairingData = tryExtractFromText(content);
        if (pairingData) {
          spinner.succeed("  Pairing data extracted from file.");
        } else {
          spinner.fail("  Could not extract pairing data from file.");
          process.exit(1);
        }
      } catch (err) {
        spinner.fail(`  Error reading file: ${err.message}`);
        process.exit(1);
      }
    } else {
      // Image file — Claude Code can read images, but we can't do OCR in pure Node
      console.log(chalk.yellow("  Photo detected: " + resolvedPath));
      console.log();
      console.log(
        chalk.white(
          "  Claude Code can read this image directly! Ask Claude:"
        )
      );
      console.log();
      console.log(
        chalk.dim(
          '  "Read this photo and extract the claude-bridge pairing details,'
        )
      );
      console.log(
        chalk.dim(
          '   then run the pair command with the extracted values."'
        )
      );
      console.log();
      console.log(
        chalk.white("  Or use manual mode with the details from the photo:")
      );
      console.log();
      console.log(
        chalk.dim(
          "  claude-bridge pair --manual --name <name> --host <ip> --user <user> --key <key-path>"
        )
      );
      console.log();
      process.exit(0);
    }
  }

  if (!pairingData) {
    console.log(chalk.red("  Error: No pairing data provided."));
    console.log();
    console.log(chalk.white("  Usage:"));
    console.log(chalk.dim("  claude-bridge pair photo.png          # From a photo"));
    console.log(chalk.dim("  claude-bridge pair pairing.json       # From a JSON file"));
    console.log(chalk.dim("  claude-bridge pair --manual --host ... # Manual entry"));
    console.log();
    process.exit(1);
  }

  // Save the private key if embedded in pairing data
  let privateKeyPath = pairingData.privateKeyPath || null;
  if (pairingData.privateKey && !privateKeyPath) {
    ensureConfigDir();
    const keysDir = getKeysDir();
    const keyFilename = `claude-bridge_${pairingData.name}`;
    privateKeyPath = join(keysDir, keyFilename);
    writeFileSync(privateKeyPath, pairingData.privateKey, { mode: 0o600 });
    console.log(
      chalk.dim(`  Private key saved to ${privateKeyPath}`)
    );
  }

  // Save machine config
  const machineName = options.name || pairingData.name;
  saveMachine(machineName, {
    host: pairingData.host,
    hostname: pairingData.hostname || null,
    port: pairingData.port || "22",
    user: pairingData.user,
    privateKeyPath: privateKeyPath,
    fingerprint: pairingData.fingerprint || null,
    pairingCode: pairingData.code || null,
  });

  console.log();
  console.log(chalk.green.bold(`  [ok] Paired with "${machineName}"!`));
  console.log();
  console.log(chalk.white("  Connection details:"));
  console.log(chalk.dim(`    Host:     ${pairingData.host}`));
  console.log(chalk.dim(`    Port:     ${pairingData.port || "22"}`));
  console.log(chalk.dim(`    User:     ${pairingData.user}`));
  console.log(chalk.dim(`    Key:      ${privateKeyPath || "(system default)"}`));
  console.log();
  console.log(chalk.white("  Try it out:"));
  console.log(chalk.dim(`    claude-bridge status ${machineName}`));
  console.log(chalk.dim(`    claude-bridge run ${machineName} "uname -a"`));
  console.log(chalk.dim(`    claude-bridge connect ${machineName}`));
  console.log();
}

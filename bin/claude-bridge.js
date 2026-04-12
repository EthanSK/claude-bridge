#!/usr/bin/env node

import { Command } from "commander";
import { setup } from "../src/setup.js";
import { pair } from "../src/pair.js";
import { connect } from "../src/connect.js";
import { status } from "../src/status.js";
import { list } from "../src/list.js";
import { run } from "../src/run.js";
import { unpair } from "../src/unpair.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8")
);

const program = new Command();

program
  .name("claude-bridge")
  .description(
    "Let your Claude Code instances talk to each other across machines"
  )
  .version(pkg.version);

program
  .command("setup")
  .description(
    "Run on the TARGET machine. Enables SSH, generates keys, and displays a pairing screen."
  )
  .option("-n, --name <name>", "Machine name (defaults to hostname)")
  .option("-p, --port <port>", "SSH port", "22")
  .option("--no-qr", "Skip QR code display")
  .action(setup);

program
  .command("pair")
  .description(
    "Run on the CONTROLLER machine. Reads a pairing photo or manually enters connection details."
  )
  .argument("[photo]", "Path to a photo of the target pairing screen")
  .option("-m, --manual", "Manually enter connection details")
  .option("-n, --name <name>", "Override machine name")
  .option("-h, --host <host>", "Target hostname or IP")
  .option("-p, --port <port>", "SSH port", "22")
  .option("-u, --user <user>", "SSH username")
  .option("-k, --key <key>", "Path to SSH private key")
  .option("-c, --code <code>", "One-time pairing code from target")
  .action(pair);

program
  .command("connect")
  .description("Open an interactive SSH session to a paired machine.")
  .argument("<machine>", "Machine name")
  .action(connect);

program
  .command("status")
  .description("Check if a paired machine is reachable.")
  .argument("[machine]", "Machine name (omit for all machines)")
  .action(status);

program
  .command("list")
  .description("List all paired machines.")
  .action(list);

program
  .command("run")
  .description("Run a command on a paired machine.")
  .argument("<machine>", "Machine name")
  .argument("<command>", "Command to execute")
  .option("--claude", 'Run as a Claude Code prompt (wraps in claude --print "...")')
  .action(run);

program
  .command("unpair")
  .description("Remove a paired machine.")
  .argument("<machine>", "Machine name")
  .action(unpair);

program.parse();

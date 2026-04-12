import chalk from "chalk";
import { listMachines } from "./config.js";

export async function list() {
  console.log();
  console.log(chalk.bold.cyan("  claude-bridge list"));
  console.log();

  const machines = listMachines();
  const names = Object.keys(machines);

  if (names.length === 0) {
    console.log(chalk.dim("  No paired machines."));
    console.log();
    console.log(chalk.dim("  To pair a machine:"));
    console.log(
      chalk.dim("    1. Run 'npx claude-bridge setup' on the target machine")
    );
    console.log(
      chalk.dim(
        "    2. Send a photo of the pairing screen to the controller Claude"
      )
    );
    console.log(
      chalk.dim("    3. Run 'claude-bridge pair' here with the details")
    );
    console.log();
    return;
  }

  for (const name of names) {
    const m = machines[name];
    console.log(chalk.bold.white(`  ${name}`));
    console.log(chalk.dim(`    Host:       ${m.host}`));
    if (m.hostname) {
      console.log(chalk.dim(`    Hostname:   ${m.hostname}`));
    }
    console.log(chalk.dim(`    Port:       ${m.port || "22"}`));
    console.log(chalk.dim(`    User:       ${m.user}`));
    console.log(
      chalk.dim(`    Key:        ${m.privateKeyPath || "(system default)"}`)
    );
    if (m.pairedAt) {
      console.log(
        chalk.dim(
          `    Paired:     ${new Date(m.pairedAt).toLocaleString()}`
        )
      );
    }
    console.log();
  }

  console.log(
    chalk.dim(`  ${names.length} machine${names.length === 1 ? "" : "s"} paired.`)
  );
  console.log();
}

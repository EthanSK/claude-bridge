import chalk from "chalk";
import { removeMachine, getMachine } from "./config.js";
import { existsSync, unlinkSync } from "fs";

export async function unpair(machineName) {
  console.log();

  const machine = getMachine(machineName);
  if (!machine) {
    console.log(chalk.red(`  Error: Machine "${machineName}" not found.`));
    console.log(
      chalk.dim("  Run 'claude-bridge list' to see paired machines.")
    );
    console.log();
    process.exit(1);
  }

  // Optionally remove the private key
  if (machine.privateKeyPath && existsSync(machine.privateKeyPath)) {
    try {
      unlinkSync(machine.privateKeyPath);
      console.log(chalk.dim(`  Removed key: ${machine.privateKeyPath}`));
    } catch {
      console.log(
        chalk.yellow(`  Warning: Could not remove key at ${machine.privateKeyPath}`)
      );
    }
  }

  removeMachine(machineName);
  console.log(chalk.green(`  [ok] Unpaired "${machineName}".`));
  console.log();
}

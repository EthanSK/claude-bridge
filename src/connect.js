import { spawn } from "child_process";
import chalk from "chalk";
import { getMachine } from "./config.js";

export async function connect(machineName) {
  const machine = getMachine(machineName);
  if (!machine) {
    console.log();
    console.log(
      chalk.red(`  Error: Machine "${machineName}" not found.`)
    );
    console.log(chalk.dim("  Run 'claude-bridge list' to see paired machines."));
    console.log();
    process.exit(1);
  }

  console.log();
  console.log(
    chalk.cyan(`  Connecting to ${chalk.bold(machineName)} (${machine.user}@${machine.host})...`)
  );
  console.log();

  const args = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-p", String(machine.port || 22),
  ];

  if (machine.privateKeyPath) {
    args.push("-i", machine.privateKeyPath);
  }

  args.push(`${machine.user}@${machine.host}`);

  const child = spawn("ssh", args, {
    stdio: "inherit",
  });

  child.on("close", (code) => {
    console.log();
    if (code === 0) {
      console.log(chalk.dim("  Connection closed."));
    } else {
      console.log(chalk.yellow(`  SSH exited with code ${code}.`));
    }
  });

  child.on("error", (err) => {
    console.log(chalk.red(`  Error: ${err.message}`));
    process.exit(1);
  });
}

import chalk from "chalk";
import ora from "ora";
import { getMachine, listMachines } from "./config.js";
import { sshPing, sshExec } from "./ssh.js";

async function checkMachine(name, machine) {
  const spinner = ora(`  Checking ${name}...`).start();

  const ping = await sshPing(name);

  if (!ping.reachable) {
    spinner.fail(
      chalk.red(`  ${name}`) +
        chalk.dim(` (${machine.host}) -- unreachable: ${ping.error}`)
    );
    return { name, reachable: false };
  }

  // Get uptime and basic info
  let info = "";
  try {
    const result = await sshExec(name, "uptime -p 2>/dev/null || uptime", {
      timeout: 5000,
    });
    info = result.stdout.replace(/\n/g, " ").trim();
  } catch {
    info = "connected";
  }

  spinner.succeed(
    chalk.green(`  ${name}`) +
      chalk.dim(` (${machine.user}@${machine.host}:${machine.port})`) +
      chalk.dim(` -- ${ping.latencyMs}ms`) +
      (info ? chalk.dim(` -- ${info}`) : "")
  );

  return { name, reachable: true, latencyMs: ping.latencyMs, info };
}

export async function status(machineName) {
  console.log();
  console.log(chalk.bold.cyan("  claude-bridge status"));
  console.log();

  if (machineName) {
    const machine = getMachine(machineName);
    if (!machine) {
      console.log(chalk.red(`  Error: Machine "${machineName}" not found.`));
      console.log(
        chalk.dim("  Run 'claude-bridge list' to see paired machines.")
      );
      console.log();
      process.exit(1);
    }
    await checkMachine(machineName, machine);
  } else {
    const machines = listMachines();
    const names = Object.keys(machines);

    if (names.length === 0) {
      console.log(chalk.dim("  No paired machines."));
      console.log(
        chalk.dim(
          "  Run 'claude-bridge setup' on the target, then 'claude-bridge pair' here."
        )
      );
      console.log();
      return;
    }

    const results = await Promise.all(
      names.map((name) => checkMachine(name, machines[name]))
    );

    const reachable = results.filter((r) => r.reachable).length;
    console.log();
    console.log(
      chalk.dim(`  ${reachable}/${names.length} machines reachable.`)
    );
  }

  console.log();
}

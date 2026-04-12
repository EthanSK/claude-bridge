import chalk from "chalk";
import ora from "ora";
import { getMachine } from "./config.js";
import { sshExec } from "./ssh.js";

export async function run(machineName, command, options) {
  const machine = getMachine(machineName);
  if (!machine) {
    console.log();
    console.log(chalk.red(`  Error: Machine "${machineName}" not found.`));
    console.log(
      chalk.dim("  Run 'claude-bridge list' to see paired machines.")
    );
    console.log();
    process.exit(1);
  }

  // If --claude flag, wrap the command in a Claude Code invocation
  let finalCommand = command;
  if (options.claude) {
    // Escape single quotes in the prompt
    const escaped = command.replace(/'/g, "'\\''");
    finalCommand = `claude --print '${escaped}'`;
  }

  const label = options.claude ? "Claude prompt" : "command";
  const spinner = ora(
    `  Running ${label} on ${machineName}...`
  ).start();

  try {
    const result = await sshExec(machineName, finalCommand, {
      timeout: options.claude ? 300000 : 60000, // 5min for Claude, 1min for regular
    });

    if (result.code === 0) {
      spinner.succeed(`  ${label} completed on ${machineName} (exit 0)`);
    } else {
      spinner.warn(
        `  ${label} on ${machineName} exited with code ${result.code}`
      );
    }

    if (result.stdout) {
      console.log();
      console.log(chalk.dim("  --- stdout ---"));
      console.log(result.stdout);
    }

    if (result.stderr) {
      console.log();
      console.log(chalk.dim("  --- stderr ---"));
      console.log(chalk.yellow(result.stderr));
    }

    console.log();
    process.exit(result.code || 0);
  } catch (err) {
    spinner.fail(`  Error: ${err.message}`);
    console.log();
    process.exit(1);
  }
}

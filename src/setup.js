import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { hostname, userInfo, networkInterfaces } from "os";
import { join } from "path";
import chalk from "chalk";
import qrcode from "qrcode-terminal";
import { nanoid } from "nanoid";
import { ensureConfigDir, getConfigDir, getKeysDir } from "./config.js";

function getLocalIPs() {
  const nets = networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        results.push({ interface: name, address: net.address });
      }
    }
  }
  return results;
}

function isMacOS() {
  return process.platform === "darwin";
}

function isSSHEnabled() {
  if (!isMacOS()) return true; // Assume enabled on Linux
  try {
    const result = execFileSync(
      "sudo",
      ["systemsetup", "-getremotelogin"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return result.toLowerCase().includes("on");
  } catch {
    return false;
  }
}

function enableSSH() {
  if (!isMacOS()) {
    console.log(
      chalk.yellow("  Non-macOS detected. Ensure SSH server is running (e.g., sshd).")
    );
    return;
  }
  try {
    console.log(chalk.dim("  Enabling Remote Login (may require sudo)..."));
    execFileSync("sudo", ["systemsetup", "-setremotelogin", "on"], {
      stdio: "inherit",
    });
    console.log(chalk.green("  Remote Login enabled."));
  } catch {
    console.log(
      chalk.yellow(
        "  Could not enable Remote Login automatically.\n" +
          "  Enable it manually: System Settings > General > Sharing > Remote Login"
      )
    );
  }
}

function generateKeyPair(machineName) {
  const keysDir = getKeysDir();
  const keyPath = join(keysDir, `claude-bridge_${machineName}`);
  const pubKeyPath = `${keyPath}.pub`;

  if (existsSync(keyPath) && existsSync(pubKeyPath)) {
    console.log(chalk.dim("  Using existing key pair."));
    return { keyPath, pubKeyPath };
  }

  console.log(chalk.dim("  Generating SSH key pair..."));
  execFileSync("ssh-keygen", [
    "-t", "ed25519",
    "-f", keyPath,
    "-N", "",
    "-C", `claude-bridge:${machineName}`,
  ], { stdio: "pipe" });
  console.log(chalk.green("  Key pair generated."));
  return { keyPath, pubKeyPath };
}

function addToAuthorizedKeys(pubKeyPath) {
  const sshDir = join(userInfo().homedir, ".ssh");
  const authKeysPath = join(sshDir, "authorized_keys");

  if (!existsSync(sshDir)) {
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }

  const pubKey = readFileSync(pubKeyPath, "utf8").trim();

  if (existsSync(authKeysPath)) {
    const existing = readFileSync(authKeysPath, "utf8");
    if (existing.includes(pubKey)) {
      console.log(chalk.dim("  Public key already in authorized_keys."));
      return;
    }
  }

  writeFileSync(authKeysPath, pubKey + "\n", { flag: "a", mode: 0o600 });
  console.log(chalk.green("  Public key added to authorized_keys."));
}

function getFingerprint(pubKeyPath) {
  try {
    const result = execFileSync("ssh-keygen", ["-lf", pubKeyPath], {
      encoding: "utf8",
    }).trim();
    // Format: 256 SHA256:xxx comment (ED25519)
    const parts = result.split(" ");
    return parts[1] || result;
  } catch {
    return "unknown";
  }
}

export async function setup(options) {
  const machineName = options.name || hostname().replace(/\.local$/, "");
  const port = options.port || "22";
  const user = userInfo().username;
  const localHostname = hostname();

  console.log();
  console.log(
    chalk.bold.cyan("  +----------------------------------------------+")
  );
  console.log(
    chalk.bold.cyan("  |         claude-bridge  .  setup               |")
  );
  console.log(
    chalk.bold.cyan("  +----------------------------------------------+")
  );
  console.log();

  // Step 1: Check/enable SSH
  console.log(chalk.bold("  1. SSH Server"));
  if (isSSHEnabled()) {
    console.log(chalk.green("  [ok] SSH (Remote Login) is already enabled."));
  } else {
    enableSSH();
  }
  console.log();

  // Step 2: Generate key pair
  console.log(chalk.bold("  2. SSH Key Pair"));
  ensureConfigDir();
  const { keyPath, pubKeyPath } = generateKeyPair(machineName);
  addToAuthorizedKeys(pubKeyPath);
  const fingerprint = getFingerprint(pubKeyPath);
  console.log();

  // Step 3: Generate pairing code
  console.log(chalk.bold("  3. Pairing Code"));
  const pairingCode = nanoid(12);
  const pairingFile = join(getConfigDir(), "pairing-code");
  writeFileSync(pairingFile, pairingCode, { mode: 0o600 });
  console.log(chalk.green("  [ok] One-time pairing code generated."));
  console.log();

  // Step 4: Get network info
  const ips = getLocalIPs();
  const primaryIP = ips.length > 0 ? ips[0].address : "unknown";

  // Step 5: Read private key content for pairing data
  const privateKey = readFileSync(keyPath, "utf8");

  // Build the pairing data object
  const pairingData = {
    name: machineName,
    host: primaryIP,
    hostname: localHostname,
    port: port,
    user: user,
    code: pairingCode,
    fingerprint: fingerprint,
    privateKey: privateKey,
  };

  const pairingJson = JSON.stringify(pairingData);
  const pairingB64 = Buffer.from(pairingJson).toString("base64");

  // Display the pairing screen
  console.log(
    chalk.bold.white(
      "  ============================================================="
    )
  );
  console.log();
  console.log(chalk.bold.cyan("  PAIRING SCREEN -- photograph this and send to controller"));
  console.log();
  console.log(
    chalk.bold.white(
      "  -------------------------------------------------------------"
    )
  );
  console.log();
  console.log(
    chalk.bold("  Machine Name:  ") + chalk.yellow.bold(machineName)
  );
  console.log(
    chalk.bold("  Username:      ") + chalk.white(user)
  );
  console.log(
    chalk.bold("  Hostname:      ") + chalk.white(localHostname)
  );
  console.log(
    chalk.bold("  Local IP:      ") + chalk.white(primaryIP)
  );
  if (ips.length > 1) {
    for (let i = 1; i < ips.length; i++) {
      console.log(
        chalk.bold("  Alt IP:        ") +
          chalk.dim(`${ips[i].address} (${ips[i].interface})`)
      );
    }
  }
  console.log(
    chalk.bold("  SSH Port:      ") + chalk.white(port)
  );
  console.log(
    chalk.bold("  Fingerprint:   ") + chalk.dim(fingerprint)
  );
  console.log(
    chalk.bold("  Pairing Code:  ") + chalk.green.bold(pairingCode)
  );
  console.log();
  console.log(
    chalk.bold.white(
      "  -------------------------------------------------------------"
    )
  );
  console.log();
  console.log(chalk.bold("  Private Key Path: ") + chalk.dim(keyPath));
  console.log();

  // QR code
  if (options.qr !== false) {
    console.log(chalk.bold.cyan("  QR Code (scan or photograph):"));
    console.log();

    // The QR code encodes the base64 pairing data
    const qrData = `claude-bridge://${pairingB64}`;
    await new Promise((resolve) => {
      qrcode.generate(qrData, { small: true }, (qr) => {
        // Indent each line
        const lines = qr.split("\n");
        for (const line of lines) {
          console.log("    " + line);
        }
        resolve();
      });
    });
    console.log();
  }

  // Manual pairing string
  console.log(chalk.bold.cyan("  Manual pairing string (copy-paste):"));
  console.log();
  console.log(chalk.dim(`  claude-bridge pair --manual \\`));
  console.log(chalk.dim(`    --name "${machineName}" \\`));
  console.log(chalk.dim(`    --host "${primaryIP}" \\`));
  console.log(chalk.dim(`    --port ${port} \\`));
  console.log(chalk.dim(`    --user "${user}" \\`));
  console.log(chalk.dim(`    --key "${keyPath}" \\`));
  console.log(chalk.dim(`    --code "${pairingCode}"`));
  console.log();
  console.log(
    chalk.bold.white(
      "  ============================================================="
    )
  );
  console.log();
  console.log(
    chalk.dim(
      "  Tip: Take a photo of this screen and send it to the controller"
    )
  );
  console.log(
    chalk.dim(
      "  Claude. It can read the image and extract the connection details."
    )
  );
  console.log();
  console.log(
    chalk.dim(
      "  Or copy the private key file to the controller machine:"
    )
  );
  console.log(chalk.dim(`  scp "${keyPath}" controller:~/.claude-bridge/keys/`));
  console.log();

  // Security note
  console.log(
    chalk.yellow(
      "  Warning: This pairing code is one-time-use. The private key"
    )
  );
  console.log(
    chalk.yellow(
      "  grants SSH access to this machine. Keep it secure."
    )
  );
  console.log(
    chalk.yellow(
      "  Connection details are stored in ~/.claude-bridge/ (mode 700)."
    )
  );
  console.log();

  // Keep running so the user can photograph the screen
  console.log(
    chalk.bold.green("  [ok] Setup complete. This screen will stay visible.")
  );
  console.log(chalk.dim("  Press Ctrl+C to close."));
  console.log();

  // Keep process alive
  await new Promise(() => {});
}

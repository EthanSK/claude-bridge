// claude-bridge — main entry point for programmatic usage
export { setup } from "./setup.js";
export { pair } from "./pair.js";
export { connect } from "./connect.js";
export { status } from "./status.js";
export { list } from "./list.js";
export { run } from "./run.js";
export { unpair } from "./unpair.js";
export {
  getMachine,
  saveMachine,
  removeMachine,
  listMachines,
  loadConfig,
  saveConfig,
} from "./config.js";
export { sshExec, sshPing } from "./ssh.js";

/**
 * SSH execution layer for sparkdeck control plane
 *
 * Extracted to enable:
 * - Mocking SSH responses in tests
 * - Injecting custom SSH implementations
 * - Better error handling + logging
 */

import { spawn } from "child_process";

const sshUser = (spark) => spark?.ssh?.user || "argo";
const sshHost = (spark) => spark?.ssh?.host || spark?.lanIp;

function sshArgs(spark) {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-o", "StrictHostKeyChecking=accept-new",
    `${sshUser(spark)}@${sshHost(spark)}`,
    "bash", "-s",
  ];
}

/**
 * Run a bash script on the box via `bash -s` on stdin.
 * Returns { stdout, stderr } or error reason in stderr.
 *
 * @param {Object} spark - Spark config { ssh: { user, host }, lanIp, ... }
 * @param {string} script - Bash script to execute
 * @param {number} timeoutMs - Timeout for SSH connection (default 25s)
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function sshRun(spark, script, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const child = spawn("ssh", sshArgs(spark), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("close", () => { clearTimeout(timer); resolve({ stdout, stderr }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ stdout, stderr: String(e) }); });
    child.stdin.write(script);
    child.stdin.end();
  });
}

/**
 * Fire a backgrounded remote command that survives the SSH session closing.
 * Command runs via setsid + nohup, detached from the SSH connection.
 *
 * @param {Object} spark - Spark config
 * @param {string} command - Command to run in background
 * @param {number} timeoutMs - Timeout for SSH handshake (default 15s)
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function sshBgLaunch(spark, command, timeoutMs = 15000) {
  const wrapped =
    `setsid nohup bash -c ${JSON.stringify(command)} > /dev/null 2>&1 < /dev/null & disown; echo LAUNCHED`;
  return sshRun(spark, wrapped, timeoutMs);
}

/** Async sleep utility. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Testing helpers ────────────────────────────────────────────────────────
// Allow tests to inject mock SSH implementations
let _sshRunImpl = sshRun;
let _sshBgLaunchImpl = sshBgLaunch;

export function setSshRunImpl(fn) {
  _sshRunImpl = fn;
}

export function setSshBgLaunchImpl(fn) {
  _sshBgLaunchImpl = fn;
}

export function resetSshImpl() {
  _sshRunImpl = sshRun;
  _sshBgLaunchImpl = sshBgLaunch;
}

// Export the used implementations (tests can inject alternatives)
export { _sshRunImpl as currentSshRun, _sshBgLaunchImpl as currentSshBgLaunch };

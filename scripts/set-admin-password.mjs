#!/usr/bin/env node
/**
 * Set (or change) the sparkdeck admin password.
 *
 * The admin password gates changes to the protected Sparks (spark-a / spark-b by
 * default — see PROTECTED_SPARKS). Non-admins can still freely manage the open
 * Sparks (spark-c / spark-d).
 *
 * Usage:
 *   node scripts/set-admin-password.mjs            # prompts (hidden input)
 *   node scripts/set-admin-password.mjs 'password' # non-interactive (avoid: shell history)
 *
 * Only a salted scrypt hash is written, to config/admin-secret.json (gitignored).
 * The plaintext is never stored. After running, restart the dashboard process
 * (this host is OpenRC — do not use systemctl).
 */
import readline from "readline";
import { saveAdminPassword } from "../server/admin.js";

const MIN_LEN = 6;

function promptHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      const s = char.toString();
      if (s === "\n" || s === "\r" || s === "") process.stdout.write("\n");
      else process.stdout.write("\x1b[2K\x1b[200D" + query + "*".repeat(rl.line.length));
    };
    process.stdin.on("data", onData);
    rl.question(query, (value) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      resolve(value);
    });
  });
}

async function main() {
  const argPw = process.argv[2];
  let pw = argPw;
  if (!pw) {
    pw = await promptHidden("New admin password: ");
    if (pw.length < MIN_LEN) {
      console.error(`Too short — use at least ${MIN_LEN} characters.`);
      process.exit(1);
    }
    const confirm = await promptHidden("Confirm password: ");
    if (pw !== confirm) {
      console.error("Passwords didn't match — nothing changed.");
      process.exit(1);
    }
  } else if (pw.length < MIN_LEN) {
    console.error(`Too short — use at least ${MIN_LEN} characters.`);
    process.exit(1);
  }
  saveAdminPassword(pw);
  console.log("Saved hash to config/admin-secret.json");
  console.log("Now restart the service:  systemctl --user restart sparkdeck.service");
}

main();

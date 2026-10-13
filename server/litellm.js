/**
 * Optional "Sync to LiteLLM": push sparkdeck's per-Spark entries into the fleet's
 * LiteLLM config and reload it — so switching a model in sparkdeck makes it
 * immediately servable via LiteLLM under its stable alias.
 *
 * Merge-safe: only sparkdeck's own aliases (sparka…d) are replaced; any other
 * model_names in the config (gpt-oss, gemma4, coder, …) are preserved. The
 * existing config is backed up before every write.
 *
 * The LiteLLM config is root-owned, so the merge runs as a python3 script under
 * sudo on the LiteLLM host (argo has passwordless sudo there).
 */
import { sshExec } from "./collectors/ssh.js";

const HOST = process.env.LITELLM_HOST || "sparkc.boga-scoville.ts.net";
const USER = process.env.LITELLM_SSH_USER || "argo";
const CONFIG = process.env.LITELLM_CONFIG || "/etc/litellm/config.yaml";
const SERVICE = process.env.LITELLM_SERVICE || "litellm";

function mergeScript(entriesB64, managedB64) {
  return `
import yaml, json, base64, shutil, time, subprocess
CONFIG = ${JSON.stringify(CONFIG)}
SERVICE = ${JSON.stringify(SERVICE)}
new_entries = json.loads(base64.b64decode("${entriesB64}"))
managed = set(json.loads(base64.b64decode("${managedB64}")))
try:
    with open(CONFIG) as f:
        cfg = yaml.safe_load(f) or {}
except FileNotFoundError:
    cfg = {}
ml = cfg.get("model_list") or []
kept = [e for e in ml if (e or {}).get("model_name") not in managed]
cfg["model_list"] = kept + new_entries
bak = CONFIG + ".bak." + time.strftime("%Y%m%d-%H%M%S")
try:
    shutil.copy2(CONFIG, bak)
except Exception:
    bak = None
with open(CONFIG, "w") as f:
    yaml.safe_dump(cfg, f, sort_keys=False, default_flow_style=False)
r = subprocess.run(["systemctl", "restart", SERVICE], capture_output=True, text=True)
print(json.dumps({
    "ok": r.returncode == 0,
    "backup": bak,
    "preserved": [ (e or {}).get("model_name") for e in kept ],
    "synced": [ (e or {}).get("model_name") for e in new_entries ],
    "restart_error": (r.stderr or "").strip()[:200],
}))
`;
}

/** Merge sparkdeck's entries into the LiteLLM config and restart it. */
export async function syncLiteLLM(entries, managedAliases) {
  const entriesB64 = Buffer.from(JSON.stringify(entries)).toString("base64");
  const managedB64 = Buffer.from(JSON.stringify([...managedAliases])).toString("base64");
  const srcB64 = Buffer.from(mergeScript(entriesB64, managedB64)).toString("base64");
  const spark = { id: "litellm", ssh: { host: HOST, user: USER } };
  const out = await sshExec(spark, `echo ${srcB64} | base64 -d | sudo -n python3`, { timeoutMs: 40000 });
  try {
    return JSON.parse(out.trim());
  } catch {
    throw new Error(`LiteLLM sync failed: ${out.slice(0, 300)}`);
  }
}

export const litellmTarget = { host: HOST, config: CONFIG, service: SERVICE };

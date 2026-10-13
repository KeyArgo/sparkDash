/**
 * sparkrun integration — recipe discovery + one-click launch.
 *
 * sparkrun (https://sparkrun.dev) is a separate CLI, installed once on THIS
 * box (the control machine, not the Sparks themselves — it SSHes out to
 * targets on its own, same as this dashboard does). It maintains its own
 * git-based recipe registries with community/official tuned launch configs.
 * This module shells out to it to (a) fetch+cache the recipe catalog and
 * (b) fuzzy-match it against whatever models sparkdeck already knows about
 * per Spark, so the UI can offer "there's a tuned recipe for this" instead
 * of only the hand-rolled vllmLaunchCmd path.
 */
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const SPARKRUN_BIN = process.env.SPARKRUN_BIN || `${process.env.HOME}/.local/bin/sparkrun`;
const CACHE_TTL_MS = 5 * 60 * 1000; // recipe registries don't change minute to minute

let cache = { at: 0, recipes: [] };

function runSparkrunSync(args, timeoutMs = 20000) {
  const res = spawnSync(SPARKRUN_BIN, args, { encoding: "utf8", timeout: timeoutMs });
  return { stdout: res.stdout || "", stderr: res.stderr || "", status: res.status };
}

/** Fetch (with caching) the full recipe catalog as sparkrun sees it. */
export function getRecipes({ forceRefresh = false } = {}) {
  const fresh = Date.now() - cache.at < CACHE_TTL_MS;
  if (fresh && !forceRefresh && cache.recipes.length) return cache.recipes;
  const res = runSparkrunSync(["list", "--json"], 20000);
  try {
    const parsed = JSON.parse(res.stdout);
    if (Array.isArray(parsed)) {
      cache = { at: Date.now(), recipes: parsed };
      return parsed;
    }
  } catch {
    /* fall through — keep serving the last good cache rather than an empty list */
  }
  return cache.recipes;
}

/** Strip a recipe's `model` field down to a bare name for comparison:
 * "unsloth/Qwen3.5-122B-A10B-GGUF:Q4_K_M" -> "Qwen3.5-122B-A10B-GGUF" */
function bareModelName(modelField) {
  const noOrg = String(modelField || "").split("/").pop() || "";
  return noOrg.split(":")[0];
}

/** Loose normalize for fuzzy comparison — same treatment must be applied to
 * both sides or the comparison is meaningless. Deliberately loose (this is
 * a "suggest a possible match" heuristic, not an exact-identity check) —
 * e.g. it will surface an FP8 vLLM recipe as a loose match for an
 * Ollama-pulled tag of the same base model, which is useful, but it also
 * means a quant suffix left inside a directory name (NVFP4 vs FP8) can
 * correctly prevent a match where the formats actually differ. */
function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Substring matches shorter than this are family-name noise
 * ("qwen3" hits every Qwen recipe). Exact equality still counts. */
const MIN_FUZZY_LEN = 8;

/** Score one recipe against an identifier. null = not a match.
 * Ollama tags drop the ":size" suffix before compare. */
export function scoreRecipeMatch(identifier, recipe, { isOllamaTag = false } = {}) {
  const base = isOllamaTag ? String(identifier).split(":")[0] : identifier;
  const normBase = normalize(base);
  const normModel = normalize(bareModelName(recipe?.model));
  const normName = normalize(recipe?.name);
  if (!normBase || (!normModel && !normName)) return null;
  const candidates = [normModel, normName].filter(Boolean);
  let best = null;
  for (const norm of candidates) {
    if (norm === normBase) return 1;
    const shorter = Math.min(norm.length, normBase.length);
    const longer = Math.max(norm.length, normBase.length);
    if (shorter < MIN_FUZZY_LEN) continue;
    if (!(norm.includes(normBase) || normBase.includes(norm))) continue;
    const score = shorter / longer;
    if (score < 0.55) continue;
    if (best == null || score > best) best = score;
  }
  return best;
}

/** Given a model identifier as sparkdeck already knows it (a vLLM checkpoint
 * dir name, or an Ollama tag), return matching recipes best-first. */
export function matchRecipesForModel(identifier, { isOllamaTag = false } = {}) {
  const recipes = getRecipes();
  const matches = [];
  for (const r of recipes) {
    const score = scoreRecipeMatch(identifier, r, { isOllamaTag });
    if (score == null) continue;
    matches.push({ ...r, matchScore: score });
  }
  matches.sort((a, b) => b.matchScore - a.matchScore);
  return matches;
}

/** Build the argv for a recipe launch. Doesn't execute — kept separate so
 * callers (and tests) can inspect exactly what would run. */
const CLUSTER_DIR = path.join(os.homedir(), ".config", "sparkrun", "clusters");

/** Current sparkrun has no `run -u`. A one-host cluster file carries the SSH
 * user (argo on this fleet) so `dev@host` is not what gets tried. */
export function clusterNameFor(host) {
  const slug = String(host || "host")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `sparkdash-${slug || "host"}`;
}

export function ensureSparkrunCluster(host, user) {
  const safeHost = String(host || "").trim();
  const safeUser = String(user || "argo").trim();
  if (!/^[A-Za-z0-9_.:-]+$/.test(safeHost)) throw new Error("invalid sparkrun host");
  if (!/^[A-Za-z0-9_.-]+$/.test(safeUser)) throw new Error("invalid sparkrun user");
  const name = clusterNameFor(safeHost);
  fs.mkdirSync(CLUSTER_DIR, { recursive: true });
  const body = `name: ${name}\nhosts:\n  - ${safeHost}\nuser: ${safeUser}\n`;
  const file = path.join(CLUSTER_DIR, `${name}.yaml`);
  let prev = "";
  try {
    prev = fs.readFileSync(file, "utf8");
  } catch {
    /* first write */
  }
  if (prev !== body) fs.writeFileSync(file, body);
  return name;
}

export function buildRunArgs(recipeName, { host, port, servedName, gpuMem, maxModelLen, cluster } = {}) {
  const args = ["run", recipeName];
  if (cluster) args.push("--cluster", cluster);
  else if (host) args.push("--hosts", host);
  args.push("--no-follow", "--ensure");
  if (port != null) args.push("--port", String(port));
  if (servedName) args.push("--served-model-name", servedName);
  if (gpuMem != null) args.push("--gpu-mem", String(gpuMem));
  if (maxModelLen != null) args.push("--max-model-len", String(maxModelLen));
  return args;
}

export function buildStopArgs(recipeName, { port, cluster } = {}) {
  const args = ["stop", recipeName];
  if (cluster) args.push("--cluster", cluster);
  if (port != null) args.push("--port", String(port));
  return args;
}

const LOG_DIR = path.join(os.homedir(), ".cache", "sparkdeck");

export function recipeRunLogPath(recipeName, host) {
  const safe = `${recipeName}-${host}`.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  return path.join(LOG_DIR, `sparkrun-run-${safe}.log`);
}

/** Fire a detached `sparkrun run` locally (sparkrun does its own SSH out to
 * `host` — this does NOT ssh into the Spark itself, unlike every other
 * control.js action). Resolves once the process has been spawned and
 * detached, not once the model is actually up — same "fire and let the
 * activity log/polling reflect it" contract as the rest of control.js.
 * `--ensure` in buildRunArgs makes this idempotent: calling it again while
 * the recipe is already up just exits 0 instead of double-launching. */
function spawnSparkrun(args, logPath) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = fs.openSync(logPath, "a");
  const child = spawn(SPARKRUN_BIN, args, {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return { pid: child.pid, args, logPath };
}

export function launchRecipeDetached(recipeName, opts) {
  const cluster = ensureSparkrunCluster(opts.host, opts.user);
  const logPath = recipeRunLogPath(recipeName, opts.host);
  const args = buildRunArgs(recipeName, { ...opts, cluster });
  return spawnSparkrun(args, logPath);
}

/** `sparkrun stop <recipe>` against the same one-host cluster used to launch. */
export function stopRecipeDetached(recipeName, opts) {
  const cluster = ensureSparkrunCluster(opts.host, opts.user);
  const logPath = recipeRunLogPath(`stop-${recipeName}`, opts.host);
  const args = buildStopArgs(recipeName, { ...opts, cluster });
  return spawnSparkrun(args, logPath);
}

/** Non-blocking status read for the polling loop in control.js. */
export function readRecipeRunLog(logPath, maxBytes = 2000) {
  try {
    const stat = fs.statSync(logPath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(logPath, "r");
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

// ─── custom recipes (dashboard-managed, "add recipe from the GUI") ──────────
// These are stored as sparkrun recipe YAML files sparkrun can run by path.
const CUSTOM_DIR = path.join(os.homedir(), ".cache", "sparkdeck", "sparkrun-recipes");

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

function recipeYaml(input) {
  const { name, model, runtime, image, command } = input;
  const safeName = String(name || "").replace(/[\n\r]/g, "").trim() || "unnamed";
  const lines = [
    `# sparkrun recipe added from the dashboard`,
    `name: ${yamlScalar(safeName)}`,
    `model: ${yamlScalar(String(model || "").trim())}`,
    `min_nodes: 1`,
  ];
  if (runtime) lines.push(`runtime: ${yamlScalar(runtime)}`);
  if (image) lines.push(`container: ${yamlScalar(image)}`);
  lines.push(`command: |`);
  const cmd = command ? String(command).replace(/[\r\n]+$/, "") : `echo "no command set"`;
  for (const line of cmd.split("\n")) lines.push(`  ${line}`);
  return lines.join("\n") + "\n";
}

export function listCustomRecipes() {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(CUSTOM_DIR); } catch { return out; }
  for (const f of entries) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    const p = path.join(CUSTOM_DIR, f);
    out.push({ name: f.replace(/\.ya?ml$/, ""), model: null, runtime: "local", localPath: p });
  }
  return out;
}

export function addCustomRecipe(input) {
  fs.mkdirSync(CUSTOM_DIR, { recursive: true });
  const name = String(input?.name || "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60) || `recipe-${Date.now()}`;
  const file = path.join(CUSTOM_DIR, `${name}.yaml`);
  fs.writeFileSync(file, recipeYaml(input || {}));
  return { name, localPath: file };
}

/** Save a sparkrun recipe YAML fetched from somewhere else, verbatim. */
export function saveRecipeFile(name, yamlText) {
  const text = String(yamlText || "");
  if (text.length < 8 || text.length > 65536) throw new Error("recipe file is empty or too large");
  if (!/^[\s\S]*\b(name|command|model)\s*:/m.test(text)) throw new Error("not a recipe file");
  fs.mkdirSync(CUSTOM_DIR, { recursive: true });
  const safe = String(name || "imported").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60) || "imported";
  const file = path.join(CUSTOM_DIR, `${safe}.yaml`);
  fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  return { name: safe, localPath: file, source: "yaml" };
}

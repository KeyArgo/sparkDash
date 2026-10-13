/**
 * Per-node serving-config switchboard (Lane E).
 *
 * Each Spark gets a small set of serving SWITCHES — model select, MTP depth
 * (off / 1 / 3), and fp8 KV-cache (on/off) — that TRANSLATE into the exact
 * vLLM launch flags a `vllm serve` line should carry. This module is pure
 * translation + persistence: it never touches SSH, never launches, never kills.
 *
 * Two things are deliberately NOT wired here:
 *  - `applyServingConfigToSpark()` — the live kill-then-launch model switch.
 *    It is a clearly-named, UNCALLED function with a human-wiring TODO. No
 *    route in this app may call it. (See the function for details.)
 *  - The A/B benchmark — `stubRunCtxBenchAB()` is a STUB that references the
 *    existing ctx_bench flow but does NOT run it.
 *
 * Persisted per Spark in config/serving-config.json (gitignored; env override
 * SERVING_CONFIG_PATH for tests).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWrite } from "./util/atomicWrite.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SERVING_CONFIG_PATH =
  process.env.SERVING_CONFIG_PATH || path.join(ROOT, "config", "serving-config.json");

/** Where checkpoints live on every Spark (matches control.js). */
const MODEL_ROOT = process.env.SPARK_MODEL_ROOT || "/home/argo/models";

/** Allowed MTP depths. 0 = speculative decoding off. */
export const MTP_OPTIONS = [0, 1, 3];

/** Single-segment checkpoint name or path with safe segments (no ".."). */
export const MODEL_NAME_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

/** True when a model string is a safe, non-traversing checkpoint path. */
export function isValidModelName(model) {
  if (typeof model !== "string" || model.length === 0 || model.length > 200) return false;
  if (!MODEL_NAME_RE.test(model)) return false;
  // Dot-dot segments would escape MODEL_ROOT — reject them explicitly.
  return !model.split("/").some((seg) => seg === ".." || seg === ".");
}

export const SERVING_CONFIG_DEFAULTS = Object.freeze({
  model: null, // checkpoint name/dir under MODEL_ROOT, or null
  mtp: 0, // 0 | 1 | 3
  fp8Kv: true, // fleet default: fp8 KV cache halves KV memory
  noThink: false, // when true, requests suppress the <think> block (see translate)
  prefixCaching: true, // reuse cached prefixes (system prompt, repo map, history)
  chunkedPrefill: true, // chunk long prefills so a huge prompt doesn't block small ones
});

/** Persisted store shape: { sparks: { [sparkId]: {model, mtp, fp8Kv} } }. */
function emptyStore() {
  return { sparks: {} };
}

export function loadServingConfigStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(SERVING_CONFIG_PATH, "utf8"));
    if (raw && typeof raw === "object" && raw.sparks && typeof raw.sparks === "object") {
      return { sparks: raw.sparks };
    }
    return emptyStore();
  } catch {
    return emptyStore();
  }
}

function saveServingConfigStore(store) {
  atomicWrite(SERVING_CONFIG_PATH, JSON.stringify(store, null, 2) + "\n", 0o644);
}

/** Validate + normalize a raw config object; throws on invalid values. */
export function normalizeConfig(input = {}) {
  const model = input.model == null ? null : String(input.model).trim();
  if (model !== null && !isValidModelName(model)) {
    throw new Error("invalid model — expected a checkpoint name like 'Qwen3.6-27B-FP8'");
  }

  let mtp = Number(input.mtp ?? 0);
  if (!Number.isInteger(mtp)) {
    // tolerate "off" / "on" style strings from naive clients
    if (input.mtp === "off") mtp = 0;
    else if (input.mtp === "on") mtp = 1;
    else throw new Error("invalid mtp — must be one of 0 (off), 1, 3");
  }
  if (!MTP_OPTIONS.includes(mtp)) {
    throw new Error(`invalid mtp — must be one of ${MTP_OPTIONS.join(", ")} (0 = off)`);
  }

  const fp8Kv = input.fp8Kv == null ? true : Boolean(input.fp8Kv);
  const noThink = input.noThink == null ? false : Boolean(input.noThink);
  const prefixCaching = input.prefixCaching == null ? true : Boolean(input.prefixCaching);
  const chunkedPrefill = input.chunkedPrefill == null ? true : Boolean(input.chunkedPrefill);

  return { model, mtp, fp8Kv, noThink, prefixCaching, chunkedPrefill };
}

/** Current serving config for a Spark (defaults merged). */
export function getServingConfig(sparkId) {
  const store = loadServingConfigStore();
  const saved = store.sparks[sparkId] || {};
  return { ...SERVING_CONFIG_DEFAULTS, ...saved };
}

/** Validate + persist a Spark's serving config. Returns the saved config. */
export function saveServingConfig(sparkId, input) {
  const config = normalizeConfig(input);
  const store = loadServingConfigStore();
  store.sparks[sparkId] = config;
  saveServingConfigStore(store);
  return config;
}

/**
 * Build the MTP --speculative-config JSON value as a SINGLE TOKEN with NO
 * spaces. A space inside the JSON breaks shell arg parsing: the fragment is
 * spliced into a remote `bash -s` launch line, where an unquoted space would
 * split the value into multiple argv tokens. Whitespace is stripped from the
 * whole JSON so the value survives as exactly one shell token.
 */
export function buildMtpSpeculativeConfig(modelPath, mtp) {
  return JSON.stringify({
    model: modelPath,
    num_speculative_tokens: mtp,
    mtp_worker: "mtp",
  }).replace(/\s+/g, "");
}

/**
 * TRANSLATE a serving-config toggle state into the correct vLLM launch flags.
 *
 * NOTE on noThink: disabling the <think> reasoning block is a REQUEST-TIME
 * concern (chat_template_kwargs.enable_thinking=false), NOT a vLLM launch flag.
 * There is no `--disable-thinking` server flag for these Qwen3.x checkpoints, so
 * it never goes in argv. Instead it is surfaced as `chatTemplateKwargs`, which the
 * request layer (Hermes proxy / harbormaster router / ctx_bench --no-think) merges
 * into each chat completion. Putting it on argv would be silently wrong.
 *
 * @param {object} config normalized serving config
 * @returns {{
 *   modelPath: string | null,
 *   mtp: number,
 *   fp8Kv: boolean,
 *   noThink: boolean,
 *   prefixCaching: boolean,
 *   chunkedPrefill: boolean,
 *   argv: string[],                 // launch flags — safe programmatic form (no shell)
 *   shell: string,                  // human-readable single line (mtp json has no spaces)
 *   mtpJson: string | null,
 *   chatTemplateKwargs: object | null  // request-time overrides (NOT launch flags)
 * }}
 */
export function translateConfigToFlags(config) {
  const modelPath = config.model ? `${MODEL_ROOT}/${config.model}` : null;
  const argv = [];
  if (modelPath) argv.push(modelPath);
  argv.push("--kv-cache-dtype", config.fp8Kv ? "fp8" : "auto");
  // Prefix caching + chunked prefill are real launch flags with explicit on/off
  // forms in vLLM 0.23 (verified via `vllm serve --help=CacheConfig/SchedulerConfig`
  // on Spark B). Emitting the explicit --no-* form pins intent rather than leaving
  // it to the engine default, so the toggle state is what actually runs.
  argv.push(config.prefixCaching ? "--enable-prefix-caching" : "--no-enable-prefix-caching");
  argv.push(config.chunkedPrefill ? "--enable-chunked-prefill" : "--no-enable-chunked-prefill");
  let mtpJson = null;
  if (config.mtp > 0 && modelPath) {
    mtpJson = buildMtpSpeculativeConfig(modelPath, config.mtp);
    argv.push("--speculative-config", mtpJson);
  }
  const chatTemplateKwargs = config.noThink ? { enable_thinking: false } : null;
  return {
    modelPath,
    mtp: config.mtp,
    fp8Kv: config.fp8Kv,
    noThink: config.noThink,
    prefixCaching: config.prefixCaching,
    chunkedPrefill: config.chunkedPrefill,
    argv,
    shell: argv.join(" "),
    mtpJson,
    chatTemplateKwargs,
  };
}

/**
 * One-click "A/B benchmark" hook — STUB. It references the existing ctx_bench
 * flow but does NOT run it (the flow lives outside this repo / is human-wired).
 * Called by POST /api/sparks/:id/serving-config/ab-bench.
 */
export function stubRunCtxBenchAB(sparkId, config) {
  // TODO(human): wire to the existing ctx_bench flow once its invocation is
  // reviewed. This stub intentionally returns a no-op so nothing executes.
  console.warn(
    `[serving-config] A/B benchmark for ${sparkId} is stubbed — ctx_bench flow not wired`
  );
  return {
    ok: false,
    stubbed: true,
    sparkId,
    message:
      "A/B benchmark hook is stubbed — wiring it to the ctx_bench flow is pending human review.",
    config: config || getServingConfig(sparkId),
  };
}

/**
 * ─── UNCALLED — human wiring required ────────────────────────────────────────
 * The actual live model switch: kill the running vLLM on a Spark, then launch
 * the selected model with the translated flags. This function is DELIBERATELY
 * never invoked by any route or code path in this app — touching a live Spark
 * (kill/launch, GPU memory, nvidia-smi) is human-review-only.
 *
 * TODO(human): when wiring, this must:
 *   1. translateConfigToFlags(config) → argv,
 *   2. SSH-kill the existing vLLM on the target port (see control.js clearGpu),
 *   3. relaunch `vllm serve <argv…>` backgrounded on the box,
 *   4. update progress via control.setPending / logActivity.
 * Until then the function fails closed so it can never be executed by accident.
 */
export function applyServingConfigToSpark(_sparkId, _config) {
  throw new Error(
    "applyServingConfigToSpark is NOT WIRED — live model switch requires human wiring. " +
      "See server/servingConfig.js for the TODO."
  );
}

/**
 * sparkdeck fleet → LiteLLM: ONE stable model entry per Spark, not one per
 * (model × spark).
 *
 * The key idea: address the *Spark*, not the model. Each Spark's vLLM is
 * launched with a fixed --served-model-name equal to its alias (spark-a…d — see
 * the control/switch action), so LiteLLM needs exactly N entries — one per box —
 * that never go stale when you swap the underlying checkpoint. Change the alias
 * in your harness and you get that box's current model with its settings.
 *
 * Optional per-Spark overrides (alias, vLLM port, context) live in
 * config/fleet-litellm.json (gitignored); everything falls back to the
 * registry + live snapshot.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OVERRIDES_PATH =
  process.env.FLEET_LITELLM_PATH || path.join(ROOT, "config", "fleet-litellm.json");

const OLLAMA_PORT = 11434;
const PREFS_PATH = process.env.LAUNCH_PREFS_PATH || path.join(ROOT, "config", "launch-prefs.json");

function loadOverrides() {
  try {
    const o = JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8"));
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

// ─── Launch / inference preferences ─────────────────────────────────────────
// A single "profile" of the settings that should apply to WHATEVER model is
// loaded: context window and gpu utilisation at launch, plus default sampling
// thresholds injected into every generated harness entry. A global `default`
// with optional per-Spark overrides.
const PREFS_DEFAULT = {
  default: {
    context: 131072, // "max" → detect the model's native window; or a number
    gpuUtil: 0.8,
    sampling: {}, // e.g. { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0 }
  },
  models: {}, // per-model overrides keyed by checkpoint dir: { "Kokoro-82M": { context: 512 } }
  sparks: {}, // per-spark overrides: { "spark-a": { context: 131072, sampling: {...} } }
};

export function loadPrefs() {
  try {
    const p = JSON.parse(fs.readFileSync(PREFS_PATH, "utf8"));
    return {
      default: { ...PREFS_DEFAULT.default, ...(p.default || {}) },
      models: p.models && typeof p.models === "object" ? p.models : {},
      sparks: p.sparks && typeof p.sparks === "object" ? p.sparks : {},
    };
  } catch {
    return PREFS_DEFAULT;
  }
}

/**
 * Context for launching `modelDir` on `sparkId`. Precedence: per-model → per-Spark
 * → global default. "Ideal context is the model's, not the box's" lives here.
 */
export function resolveContext(sparkId, modelDir) {
  const p = loadPrefs();
  const m = (modelDir && p.models[modelDir]) || {};
  const s = p.sparks[sparkId] || {};
  return m.context ?? s.context ?? p.default.context;
}

/** Effective prefs for one Spark: global default merged with its override. */
export function resolvePrefs(sparkId) {
  const p = loadPrefs();
  const o = p.sparks[sparkId] || {};
  return {
    context: o.context ?? p.default.context,
    gpuUtil: o.gpuUtil ?? p.default.gpuUtil,
    enforceEager: o.enforceEager ?? p.default.enforceEager ?? false,
    kvCacheDtype: o.kvCacheDtype ?? p.default.kvCacheDtype ?? null,
    reasoningParser: o.reasoningParser ?? p.default.reasoningParser ?? null,
    sampling: { ...(p.default.sampling || {}), ...(o.sampling || {}) },
  };
}

/** Alias a harness uses for this Spark (default = the spark id, e.g. spark-a). */
export function aliasFor(spark, overrides = loadOverrides()) {
  return overrides[spark.id]?.alias || spark.id;
}

/** The Spark's vLLM port: override → first non-Ollama registered port → first. */
export function vllmPortFor(spark, overrides = loadOverrides()) {
  const ov = overrides[spark.id]?.port;
  if (Number.isInteger(ov)) return ov;
  const ports = spark.llmPorts || [];
  return ports.find((p) => p !== OLLAMA_PORT) ?? null;
}

const hostFor = (spark) => spark?.ssh?.host || spark?.lanIp || spark?.id;

/**
 * Build the LiteLLM model_list. `sparks` are registry configs; `snapshotById`
 * (optional) maps spark id → live snapshot so we can stamp the current context
 * window and flag whether the endpoint is actually up right now.
 */
/**
 * Structured LiteLLM entries (one per Spark) — same content as toLiteLLMConfig
 * but as objects, for merging into an existing config during sync.
 */
export function toLiteLLMEntries(sparks, snapshotById = {}) {
  const overrides = loadOverrides();
  const entries = [];
  for (const spark of sparks) {
    const port = vllmPortFor(spark, overrides);
    if (!port) continue;
    const alias = aliasFor(spark, overrides);
    const host = hostFor(spark);
    const snap = snapshotById[spark.id];
    const vllm = snap?.metrics?.llm?.find?.((s) => s.backend === "vllm" && s.available);
    const upstream = vllm?.modelId || alias;
    const ctx = overrides[spark.id]?.context || vllm?.contextLength || null;
    const params = {
      model: `hosted_vllm/${upstream}`,
      api_base: `http://${host}:${port}/v1`,
      api_key: "none",
    };
    for (const [k, v] of Object.entries(resolvePrefs(spark.id).sampling || {})) {
      if (v != null && v !== "") params[k] = v;
    }
    const entry = { model_name: alias, litellm_params: params };
    if (ctx) entry.model_info = { max_input_tokens: ctx };
    entries.push(entry);
  }
  return entries;
}

/** The set of aliases sparkdeck manages, so a sync replaces only its own entries. */
export function managedAliases(sparks) {
  const overrides = loadOverrides();
  return sparks.map((s) => aliasFor(s, overrides));
}

export function toLiteLLMConfig(sparks, snapshotById = {}) {
  const overrides = loadOverrides();
  const lines = [
    "# Generated by sparkdeck — one entry per Spark.",
    "# Each Spark's vLLM is launched with --served-model-name = its alias, so",
    "# these entries stay valid when you swap the model behind them.",
    "model_list:",
  ];
  let emitted = 0;
  for (const spark of sparks) {
    const port = vllmPortFor(spark, overrides);
    if (!port) continue; // no vLLM port known for this box (e.g. Ollama-only)
    const alias = aliasFor(spark, overrides);
    const host = hostFor(spark);
    const snap = snapshotById[spark.id];
    const vllm = snap?.metrics?.llm?.find?.((s) => s.backend === "vllm" && s.available);
    const ctx = overrides[spark.id]?.context || vllm?.contextLength || null;
    // Trailing YAML comment (must start with " #"), never part of the value.
    const liveNote = snap
      ? vllm
        ? `  # live: ${vllm.modelId}`
        : "  # no vLLM up right now"
      : "";
    // model_name (what harnesses type) is ALWAYS the stable alias. The internal
    // upstream `model` follows the live served-name so it routes correctly right
    // now, and converges to the alias once the model is (re)launched via
    // sparkdeck (which stamps --served-model-name = alias).
    const upstream = vllm?.modelId || alias;
    lines.push(`  - model_name: ${alias}${liveNote}`);
    lines.push(`    litellm_params:`);
    lines.push(`      model: hosted_vllm/${upstream}`);
    lines.push(`      api_base: http://${host}:${port}/v1`);
    lines.push(`      api_key: "none"`);
    // Preferred thresholds — applied to EVERY request to this alias, whatever
    // model is behind it. This is the "no matter what model, use my settings".
    const sampling = resolvePrefs(spark.id).sampling || {};
    for (const [k, v] of Object.entries(sampling)) {
      if (v != null && v !== "") lines.push(`      ${k}: ${v}`);
    }
    if (ctx) {
      lines.push(`    model_info:`);
      lines.push(`      max_input_tokens: ${ctx}`);
    }
    emitted++;
  }
  if (!emitted) lines.push("  []  # no Spark has a known vLLM port yet");
  return lines.join("\n") + "\n";
}

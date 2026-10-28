/**
 * TensorFold (LLM engine) telemetry — per-poll snapshot, deltas and client
 * attribution, harvested inside the existing remote SSH batch (see
 * SystemCollector._getRemoteGpu `__TF__` / `__TF_CLIENTS__` sections).
 *
 * Everything here is additive and optional: when the engine's :8888 /metrics
 * endpoint is absent the parsers simply yield nothing and the monitor's
 * snapshot stays null-sided. Existing metric shapes are untouched.
 */

import fs from "node:fs";

/** Port the TensorFold rank-0 engine serves (metrics + API). */
export const TENSORFOLD_PORT = 8888;

/** Model id reported by the fleet's TensorFold deployments. */
export const TENSORFOLD_MODEL = "GLM-5.3-Flash-EXL3";

/**
 * Client IP → human label for the card's `clients:` segment. Unknown IPs are
 * still listed, with a null label the UI renders as the bare address.
 */
export const CLIENT_LABELS = {
  "127.0.0.1": "callisto",
  "10.0.0.100": "callisto", // hub LAN (hermes hub / litellm-buzz)
  "100.107.196.54": "callisto", // hub tailscale
  "10.0.0.50": "spark-a",
  "10.0.0.51": "spark-b",
  "10.0.0.20": "spark-c",
  "10.0.0.21": "spark-d",
  "100.100.238.119": "spark-a",
  "100.75.23.41": "spark-b",
  "100.87.48.89": "spark-c",
  "100.125.158.49": "spark-d",
};

/** spark id → guest-usage.jsonl `spark` pair field. */
export const GUEST_PAIR_BY_SPARK_ID = {
  "spark-a": "A/B",
  "spark-b": "A/B",
  "spark-c": "C/D",
  "spark-d": "C/D",
};

/** Guest-usage join window and input tail, per the fleet spec. */
export const GUEST_USAGE_PATH =
  process.env.SPARKDECK_GUEST_USAGE || "/home/dev/LiteLLM-Buzz/guest-usage.jsonl";
const GUEST_TAIL_LINES = 200;
const GUEST_WINDOW_MS = 10 * 60_000;
const GUEST_CACHE_MS = 15_000;

/** Prometheus text exposure → the counters/gauges this module consumes. */
const TF_METRIC_RES = {
  genTokens: /^tensorfold:generation_tokens_total\s+(\S+)/m,
  promptTokens: /^tensorfold:prompt_tokens_total\s+(\S+)/m,
  decodeSeconds: /^tensorfold_health:decode_seconds_total\s+(\S+)/m,
  prefillSeconds: /^tensorfold_health:prefill_seconds_total\s+(\S+)/m,
  requests: /^tensorfold_health:requests_total\s+(\S+)/m,
  ttftSum: /^tensorfold:time_to_first_token_seconds_sum\s+(\S+)/m,
  ttftCount: /^tensorfold:time_to_first_token_seconds_count\s+(\S+)/m,
  latSum: /^tensorfold:request_latency_seconds_sum\s+(\S+)/m,
  latCount: /^tensorfold:request_latency_seconds_count\s+(\S+)/m,
  kvRatio: /^tensorfold:kv_cache_usage_ratio(?:\{[^}]*\})?\s+(\S+)/m,
  running: /^tensorfold:requests_running\s+(\S+)/m,
  waiting: /^tensorfold:requests_waiting\s+(\S+)/m,
};

/**
 * Parse a `__TF__` section (prometheus exposition) into a raw snapshot, or
 * null when the engine did not answer. Values are numbers; absent metrics
 * are null so partial exposures degrade gracefully.
 * @param {string} text
 * @returns {Record<string, number | null> | null}
 */
export function parseTensorfoldMetrics(text) {
  const body = String(text ?? "");
  if (!body.trim()) return null;
  const out = { ok: true };
  for (const [key, re] of Object.entries(TF_METRIC_RES)) {
    const m = re.exec(body);
    const n = m ? Number(m[1]) : NaN;
    out[key] = Number.isFinite(n) ? n : null;
  }
  // At least the token counters must be present to trust the section.
  if (out.genTokens == null && out.promptTokens == null) return null;
  return out;
}

/**
 * Parse `ss -Htn state established '( sport = :8888 )'` output into the unique
 * peer (client) IPs. The peer is the last address:port on each line; works
 * with or without the state column. IPv6 peers are kept in bracket form's
 * bare-address best effort; unparseable lines are skipped.
 * @param {string} text
 * @returns {string[]}
 */
export function parseTfClients(text) {
  const peers = [];
    for (const line of String(text ?? "").split(/\r?\n/)) {
    const matches = [...line.matchAll(/([0-9a-fA-F.:\[\]]+):(\d+)(?=\s|$)/g)];
    if (!matches.length) continue;
    const last = matches[matches.length - 1];
    let ip = last[1].replace(/^\[/, "").replace(/\]$/, "");
    if (!ip || ip === "*") continue;
    // The listening socket's own row (local == :8888 with peer 0.0.0.0:*) is
    // not an established client; ss state filter already excludes listeners.
    if (!peers.includes(ip)) peers.push(ip);
  }
  return peers;
}

/** Attach `label` from CLIENT_LABELS; unknown IPs pass through with null. */
export function labelClient(ip) {
  return { ip, label: CLIENT_LABELS[ip] ?? null };
}

/**
 * Rate derivation against the previous raw snapshot. First poll (or a counter
 * reset / long gap) yields null rates; gauge fields always pass through.
 * @param {{ at: number, metrics: Record<string, number|null>, clients: string[] } | null} prev
 * @param {{ at: number, metrics: Record<string, number|null>, clients: string[] }} cur
 * @returns {{ tok_per_s: number | null, decode_tps: number | null, prefill_s: number | null, ttft_s: number | null }}
 */
export function deriveTfDeltas(prev, cur) {
  const nulls = { tok_per_s: null, decode_tps: null, prefill_s: null, ttft_s: null };
  if (!prev?.at || !cur?.at) return nulls;
  const dt = (cur.at - prev.at) / 1000;
  // Reset or stale gap: reseed from this sample, report no rate once.
  if (!(dt > 0) || dt > 120) return nulls;
  const delta = (key) => {
    const a = prev.metrics[key];
    const b = cur.metrics[key];
    if (a == null || b == null || b < a) return null; // b < a: engine restarted
    return b - a;
  };
  const gen = delta("genTokens");
  const decMs = delta("decodeSeconds");
  const prefillS = delta("prefillSeconds");
  const reqs = delta("requests");
  const ttftSum = delta("ttftSum");
  const ttftCount = delta("ttftCount");
  const div = (num, den) => (num == null || den == null || !(den > 0) ? null : num / den);
  return {
    tok_per_s: div(gen, dt),
    decode_tps: div(decMs, dt),
    prefill_s: div(prefillS, reqs),
    ttft_s: div(ttftSum, ttftCount),
  };
}

// ─── guest-usage.jsonl join ────────────────────────────────
let guestCache = { at: 0, lines: [] };

function loadGuestLines(now = Date.now()) {
  if (now - guestCache.at < GUEST_CACHE_MS) return guestCache.lines;
  let lines = [];
  try {
    const raw = fs.readFileSync(GUEST_USAGE_PATH, "utf-8");
    lines = raw.split(/\r?\n/).slice(-GUEST_TAIL_LINES);
  } catch {
    lines = [];
  }
  guestCache = { at: now, lines };
  return guestCache.lines;
}

/**
 * alias → request count from the guest-usage tail whose `spark` equals `pair`
 * within the last 10 minutes. Missing/unreadable file → {}.
 * @param {string} pair "A/B" | "C/D"
 * @param {number} [now] epoch ms (tests)
 */
export function guestCountsFor(pair, now = Date.now()) {
  if (!pair) return {};
  const counts = {};
  for (const line of loadGuestLines(now)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.spark !== pair) continue;
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts) || now - ts > GUEST_WINDOW_MS || now - ts < -30_000) continue;
    const alias = typeof entry.key_alias === "string" ? entry.key_alias : null;
    if (!alias) continue;
    counts[alias] = (counts[alias] ?? 0) + 1;
  }
  return counts;
}

/** Test hook: drop the module-level guest cache. */
export function resetGuestCache() {
  guestCache = { at: 0, lines: [] };
}


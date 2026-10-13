/**
 * sparkdeck control plane — ported from spark-control (Flask).
 *
 * Runs the model-management actions the monitoring base never had: load/switch a
 * vLLM checkpoint, stop a port, warm an Ollama model, restart vLLM/Ollama, import
 * a GGUF, pull a new model, and copy a model box-to-box. The remote commands are
 * carried over near-verbatim from spark-control because each encodes a hard-won
 * fix (see comments): the EngineCore-aware vLLM kill, the fresh-connection GPU
 * check, the base64 rsync file-list pipe, the LAN-vs-Tailscale transfer host.
 *
 * Unlike the Flask original this does NOT force a poll after each action — the
 * SparkMonitor already polls every ~2s, so state refreshes on its own. Progress
 * is tracked in-memory (pending + activity log) and read via getControlStatus().
 */
import * as sparkrun from "./sparkrun.js";
import { sshRun, sshBgLaunch, sleep } from "./ssh.js";

// ─── Fleet constants (argo's layout on every Spark) ─────────────────────────
const MODEL_ROOT = process.env.SPARK_MODEL_ROOT || "/home/argo/models";
const VLLM_VENV = process.env.SPARK_VLLM_VENV || "/home/argo/vllm-venv";
const SGLANG_VENV = process.env.SPARK_SGLANG_VENV || "/home/argo/sglang-venv";
const OLLAMA_MODELS_DIR = "/usr/share/ollama/.ollama/models";

/** Same-site boxes copy over LAN (fast); cross-site falls back to Tailscale. */
const SITE_MAP = { "spark-a": "site1", "spark-b": "site1", "spark-c": "site2", "spark-d": "site2" };

const ARCH_TOOL_PARSER = {
  gemma4: "gemma4",
  Gemma4ForConditionalGeneration: "gemma4",
  qwen3_5: "qwen3_xml",
  qwen3_5_moe: "qwen3_xml",
  "qwen3.5": "qwen3_xml",
  Qwen3ForCausalLM: "qwen3_xml",
  Qwen3MoeForCausalLM: "qwen3_xml",
  Qwen3_5ForConditionalGeneration: "qwen3_xml",
  Qwen3_5MoeForConditionalGeneration: "qwen3_xml",
};

export const NAME_RE = /^[A-Za-z0-9_.-]+$/;
export const MODEL_DIR_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
export const PULL_TAG_RE = /^[A-Za-z0-9_.\-/:]+$/;

const sshUser = (spark) => spark?.ssh?.user || "argo";
const sshHost = (spark) => spark?.ssh?.host || spark?.lanIp;

// ─── In-memory progress state ───────────────────────────────────────────────
const pending = new Map(); // sparkId -> { msg, pct }
const activity = []; // newest first, capped

function logActivity(msg) {
  activity.unshift({ ts: new Date().toISOString(), msg });
  activity.length = Math.min(activity.length, 40);
}
function setPending(id, msg, pct = null) {
  if (msg == null) pending.delete(id);
  else pending.set(id, { msg, pct });
}
export function getControlStatus() {
  return { pending: Object.fromEntries(pending), activity };
}

function parseProgressPct(text) {
  const matches = [...String(text).matchAll(/(\d{1,3})%/g)].map((m) => parseInt(m[1], 10));
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i] >= 0 && matches[i] <= 100) return matches[i];
  }
  return null;
}

// ─── SSH helpers are now in ssh.js (imported above) ────────────────────────

// ─── systemd (user) persistence for vLLM ────────────────────────────────────
// Launches used to be plain `setsid nohup ... & disown` — invisible to any
// supervisor, gone the moment the process crashed or the box rebooted. Every
// vLLM launch now gets its own `systemctl --user` unit: Restart=on-failure
// survives crashes, enable+lingering (already set fleet-wide) survives
// reboots, and stopping it via the dashboard disables it so it stays down
// until explicitly relaunched — "persist until told not to."
export function vllmUnitName(port) {
  return `vllm-port-${port}`;
}

/** Distinct prefix from vllmUnitName so the two engines never collide in
 * systemd's unit namespace even when pointed at the same port number (they
 * can't both actually bind that port at once, but their unit *bookkeeping*
 * must stay unambiguous — doSwitch/doSwitchSglang each only look for their
 * own unit name before deciding whether to stop-first or legacy-clear). */
export function sglangUnitName(port) {
  return `sglang-port-${port}`;
}

export async function systemdUnitExists(spark, unitName) {
  const res = await sshRun(
    spark,
    `systemctl --user list-unit-files ${unitName}.service 2>/dev/null | grep -c ${unitName}`,
    10000
  );
  return res.stdout.trim() !== "0" && res.stdout.trim() !== "";
}

/** Write+enable a systemd --user unit for a vLLM launch command. */
export async function systemdLaunch(spark, unitName, command, label) {
  const unitContent =
    // StartLimitIntervalSec belongs in [Unit], not [Service] — systemd
    // silently ignores it in the wrong section (confirmed live: a unit ran
    // with it misplaced and just logged "Unknown key name... ignoring",
    // meaning systemd's default 5-restarts/10s start-limit was silently
    // still in effect the whole time, not the "never throttle" intent).
    // TimeoutStopSec is short on purpose: vLLM is stateless, unlike the
    // ChromaDB embedding case that taught this fleet "never kill mid-write"
    // — there's nothing here a fast SIGKILL can corrupt, and the default
    // 90s graceful-shutdown wait (confirmed live: a 35B model's stop sat
    // for the full 90s before force-killing) reads as a hang to anyone
    // watching the dashboard.
    `[Unit]\nDescription=sparkdeck-managed: ${unitName}\nAfter=network.target\nStartLimitIntervalSec=0\n\n` +
    `[Service]\nType=simple\nExecStart=/bin/bash -c ${JSON.stringify(command)}\n` +
    `Restart=on-failure\nRestartSec=5\nTimeoutStopSec=10\n\n` +
    `[Install]\nWantedBy=default.target\n`;
  const unitB64 = Buffer.from(unitContent).toString("base64");
  const script =
    `mkdir -p ~/.config/systemd/user && ` +
    `echo ${unitB64} | base64 -d > ~/.config/systemd/user/${unitName}.service && ` +
    `systemctl --user daemon-reload && ` +
    `systemctl --user reset-failed ${unitName} 2>/dev/null; ` +
    `systemctl --user enable --now ${unitName} && echo UNIT_STARTED`;
  const res = await sshRun(spark, script, 20000);
  if (!res.stdout.includes("UNIT_STARTED")) {
    logActivity(`${label}: systemd unit ${unitName} failed to start — ${(res.stdout + res.stderr).trim().slice(0, 200)}`);
    return false;
  }
  return true;
}

/** Stop+disable a sparkdeck-managed unit — stays down until relaunched,
 * won't come back on next boot either. systemd's cgroup-based kill also
 * catches the detached EngineCore worker that a plain pkill can miss. */
export async function systemdStop(spark, unitName) {
  await sshRun(
    spark,
    `systemctl --user disable --now ${unitName} 2>/dev/null; systemctl --user reset-failed ${unitName} 2>/dev/null; true`,
    20000
  );
}

// ─── Preflight OOM guard ─────────────────────────────────────────────────────
/** Refuse a launch that would clearly overrun the box's memory rather than
 * let vLLM start, allocate, and OOM mid-load. Compares currently-used GPU
 * memory (whatever's already loaded — Ollama, another vLLM instance, etc.)
 * against what this launch is about to request. This is NOT a full
 * per-model VRAM estimate (that needs config.json/architecture-aware math,
 * like sparkrun's own estimator) — it's a simpler "don't launch into memory
 * that's obviously already spoken for" guard. earlyoom (installed fleet-wide)
 * remains the reactive last line of defense for system-RAM pressure this
 * doesn't cover. */
export async function checkGpuHeadroom(spark, gpuUtil, label) {
  // GB10's unified memory doesn't report through the normal
  // `nvidia-smi --query-gpu=memory.used,memory.total` path — both fields
  // come back literally "[N/A]" on this hardware (confirmed live, not just
  // in docs), which would make this whole check silently no-op. Per-process
  // usage via --query-compute-apps DOES work (also confirmed live, e.g. a
  // running vLLM engine reporting real MiB), and `free` gives the real
  // total — this unified box's "GPU memory" IS its system RAM.
  const [usedRes, totalRes] = await Promise.all([
    sshRun(spark, "nvidia-smi --query-compute-apps=used_memory --format=csv,noheader,nounits 2>/dev/null", 10000),
    sshRun(spark, "free -b 2>/dev/null | awk '/^Mem:/{print $2}'", 10000),
  ]);
  const usedMiB = usedRes.stdout
    .split("\n")
    .map((l) => parseInt(l.trim(), 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => a + b, 0);
  const used = usedMiB * 1024 * 1024;
  const total = parseInt(totalRes.stdout.trim(), 10);
  if (!Number.isFinite(total) || total <= 0) {
    logActivity(`${label}: preflight GPU check unavailable — proceeding without it`);
    return true;
  }
  const usedPct = used / total;
  const requestedPct = parseFloat(gpuUtil);
  const projected = usedPct + (Number.isFinite(requestedPct) ? requestedPct : 0);
  const SAFE_CEILING = 0.95;
  if (projected > SAFE_CEILING) {
    logActivity(
      `${label}: launch REJECTED — ${Math.round(usedPct * 100)}% GPU memory already in use, this ` +
        `launch requests ${Math.round(requestedPct * 100)}% more (projected ${Math.round(projected * 100)}%, ` +
        `over the ${Math.round(SAFE_CEILING * 100)}% safety ceiling). Stop something first or lower gpu-memory-utilization.`
    );
    return false;
  }
  return true;
}

// ─── Engine kill (EngineCore-aware, vLLM + SGLang) + GPU-clear check ────────
// A vLLM-only grep here was a real, confirmed bug (multi-reviewer bug hunt,
// 2026-08-14): gpuIsClear/killVllmCmd only ever matched "vllm" process names,
// so a kill against an SGLang launch always reported the GPU as cleared
// immediately, even if the process was still resident — the "verify it
// actually stopped" guarantee silently no-op'd for the second engine. Both
// setproctitle to their own namespaced prefix (confirmed live: vLLM uses
// "VLLM::EngineCore", SGLang uses "sglang::scheduler"/"sglang::data_parallel_
// controller"), so the fix is the same pattern extended to both, not a
// different mechanism.
const ENGINE_PROC_GREP = "vllm::|sglang::";

/** Build kill command for a vLLM or SGLang process on a port.
 * Kills by venv path AND by setproctitle name (both engines), then polls
 * nvidia-smi until GPU clears. */
export function killEngineCmd(port) {
  // A plain `fuser -k <port>/tcp` only kills the API server; its detached
  // EngineCore/scheduler worker survives holding GPU memory, so the next
  // launch OOMs. Kill by venv-path AND by the namespaced setproctitle name
  // for both engines, then poll nvidia-smi until no matching compute process
  // remains.
  return (
    `pkill -9 -f '${VLLM_VENV}/bin/python' >/dev/null 2>&1; ` +
    `pkill -9 -f '${SGLANG_VENV}/bin/python' >/dev/null 2>&1; ` +
    `pkill -9 -i -f '${ENGINE_PROC_GREP}' >/dev/null 2>&1; ` +
    `fuser -k ${port}/tcp >/dev/null 2>&1; ` +
    "for i in $(seq 1 8); do " +
    `remaining=$(nvidia-smi --query-compute-apps=process_name --format=csv,noheader 2>/dev/null | grep -ciE '${ENGINE_PROC_GREP}'); ` +
    'if [ "${remaining:-0}" -eq 0 ]; then echo GPU_CLEAR; break; fi; ' +
    "sleep 2; done; echo KILL_DONE"
  );
}
/** @deprecated use killEngineCmd — kept as an alias so any external caller
 * relying on the old name doesn't silently break. */
export const killVllmCmd = killEngineCmd;

/** Check if GPU vLLM/SGLang processes are cleared (no active compute apps).
 * Fresh-connection fallback: SIGKILL of a huge CUDA alloc can drop the SSH
 * session that issued it, masking a successful kill. A new connection tells
 * the truth.
 * @param {Object} spark - Spark config
 * @param {number} retries - Number of retry attempts (default 3)
 * @param {number} delay - Delay between retries in ms (default 3000)
 * @returns {Promise<boolean>} true if GPU is clear
 */
export async function gpuIsClear(spark, retries = 3, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    const res = await sshRun(
      spark,
      `nvidia-smi --query-compute-apps=process_name --format=csv,noheader 2>/dev/null | grep -ciE '${ENGINE_PROC_GREP}'`,
      15000
    );
    if (res.stdout.trim() === "0") return true;
    await sleep(delay);
  }
  return false;
}

/** Kill whichever engine (vLLM or SGLang) is on a port and verify GPU memory
 * clears. Tries direct kill first, then fresh-connection verification.
 * @param {Object} spark - Spark config
 * @param {number} port - engine's port
 * @param {string} label - Label for activity logging
 * @returns {Promise<boolean>} true if GPU successfully cleared
 */
export async function clearGpu(spark, port, label) {
  let cleared = false;
  try {
    const res = await sshRun(spark, killEngineCmd(port), 25000);
    cleared = res.stdout.includes("GPU_CLEAR");
  } catch {
    /* fall through to fresh-connection check */
  }
  if (!cleared) cleared = await gpuIsClear(spark);
  if (!cleared) logActivity(`${label}: warning — GPU memory may not have fully cleared`);
  return cleared;
}

/** Stop whatever engine (vLLM or SGLang) is currently on a port, regardless
 * of which one is about to launch there. Confirmed real bug (multi-reviewer
 * bug hunt, 2026-08-14): doSwitch and doSwitchSglang each only checked their
 * OWN unit name before launching — switching a port from vLLM to SGLang (or
 * back) left the old engine running, so the new one either failed to bind
 * the port or, worse, systemdLaunch reported success while the old process
 * silently kept the port/GPU memory.
 *
 * Also waits for GPU memory to actually release after a systemd stop before
 * returning, closing a related race: the systemd path previously returned
 * immediately after `systemctl --user disable --now`, with no equivalent to
 * the polling the legacy clearGpu fallback already did — a big model still
 * mid-SIGTERM (TimeoutStopSec=10) could be counted as already-cleared by the
 * headroom check that runs right after this. */
export async function stopAnyEngineOnPort(spark, port, label) {
  const vUnit = vllmUnitName(port);
  const sUnit = sglangUnitName(port);
  const [vExists, sExists] = await Promise.all([
    systemdUnitExists(spark, vUnit),
    systemdUnitExists(spark, sUnit),
  ]);
  if (!vExists && !sExists) {
    // No systemd unit we manage on this port — fall back to the legacy
    // pkill/fuser sweep for anything launched before this port had a unit.
    return clearGpu(spark, port, label);
  }
  if (vExists) await systemdStop(spark, vUnit);
  if (sExists) await systemdStop(spark, sUnit);
  const cleared = await gpuIsClear(spark);
  if (!cleared) logActivity(`${label}: warning — GPU memory may not have fully cleared after stopping :${port}`);
  return cleared;
}

/** Build complete vLLM serve command with all flags.
 * @param {string} modelPath - Path to model directory
 * @param {number} port - Port for vLLM API
 * @param {string} servedName - Model name as exposed to litellm
 * @param {number} maxLen - Max context length
 * @param {number} gpuUtil - GPU memory utilization (0.0-1.0)
 * @param {string} toolParser - Tool-call parser (optional, e.g. "auto_tool_choice")
 * @param {Object} opts - Optional flags (enforceEager, kvCacheDtype, reasoningParser)
 * @returns {string} Complete bash command for vllm serve
 */
export function vllmLaunchCmd(modelPath, port, servedName, maxLen, gpuUtil, toolParser, opts = {}) {
  const { enforceEager, kvCacheDtype, reasoningParser } = opts;
  const toolFlags = toolParser
    ? `--enable-auto-tool-choice --tool-call-parser ${toolParser} `
    : "";
  // --enforce-eager disables torch.compile/CUDA graphs. Slower decode, but
  // avoids the Triton AOT-compile step, which some boxes can't memory-map
  // ("failed to map segment from shared object").
  const eager = enforceEager ? "--enforce-eager " : "";
  // fp8 KV cache halves KV memory → longer context / more concurrency on GB10.
  const kv = kvCacheDtype ? `--kv-cache-dtype ${kvCacheDtype} ` : "";
  // Separates <think>…</think> into reasoning_content instead of leaking into content.
  const reason = reasoningParser ? `--reasoning-parser ${reasoningParser} ` : "";
  return (
    `PATH=${VLLM_VENV}/bin:$PATH ${VLLM_VENV}/bin/vllm serve ${modelPath} ` +
    `--host 0.0.0.0 --port ${port} --served-model-name ${servedName} ` +
    `--max-model-len ${maxLen} --gpu-memory-utilization ${gpuUtil} ` +
    `--max-num-seqs 16 --max-num-batched-tokens 8192 ` +
    `--enable-prefix-caching --trust-remote-code ${eager}${kv}${reason}${toolFlags}` +
    `> /home/${"argo"}/vllm-${servedName}.log 2>&1`
  );
}

/** Build complete SGLang launch_server command. Mirrors vllmLaunchCmd's shape;
 * flags follow the community-vetted @sparkrun-transitional sglang recipes
 * (confirmed working on GB10 — triton attention backend, mem-fraction-static
 * for GB10's unified-memory budgeting), trimmed to the generic subset —
 * model-specific tuning (speculative decode, fp8-gemm-backend) stays out of
 * this generic launcher the same way vllmLaunchCmd doesn't hardcode those. */
export function sglangLaunchCmd(modelPath, port, servedName, maxLen, gpuUtil, toolParser, opts = {}) {
  const { reasoningParser, attentionBackend } = opts;
  const toolFlag = toolParser ? `--tool-call-parser ${toolParser} ` : "";
  const reason = reasoningParser ? `--reasoning-parser ${reasoningParser} ` : "";
  const backend = attentionBackend || "triton";
  // TRITON_CACHE_DIR override is required, not cosmetic — confirmed live on
  // Spark E that /home/argo/.triton/cache is root-owned (leftover from some
  // earlier root-run process), which makes every triton-backend sglang
  // launch crash on its first real inference with a JIT-cache
  // PermissionError. Redirecting to a fresh path under argo's own .cache
  // sidesteps the broken shared directory entirely, no root needed.
  return (
    `TRITON_CACHE_DIR=/home/argo/.cache/sparkdeck-triton ` +
    `PATH=${SGLANG_VENV}/bin:$PATH ${SGLANG_VENV}/bin/python3 -m sglang.launch_server ` +
    `--model-path ${modelPath} --served-model-name ${servedName} ` +
    `--host 0.0.0.0 --port ${port} --context-length ${maxLen} ` +
    `--mem-fraction-static ${gpuUtil} --tp-size 1 --attention-backend ${backend} ` +
    `--trust-remote-code ${reason}${toolFlag}` +
    `> /home/${"argo"}/sglang-${servedName}.log 2>&1`
  );
}

// ─── Actions ────────────────────────────────────────────────────────────────
/** Read a checkpoint's native context window from its config.json on the box. */
async function detectNativeContext(spark, modelDir) {
  const res = await sshRun(
    spark,
    `grep -oE '"max_position_embeddings"[^0-9]*[0-9]+' ${MODEL_ROOT}/${modelDir}/config.json 2>/dev/null | grep -oE '[0-9]+' | head -1`,
    15000
  );
  const n = parseInt(res.stdout.trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function doSwitch(spark, { modelDir, servedName, port, maxLen, gpuUtil, arch, enforceEager, kvCacheDtype, reasoningParser }) {
  const label = spark.name;
  setPending(spark.id, `launching ${servedName} on port ${port}...`);
  try {
    // "max" → load at the model's own maximum context. On GB10 unified memory a
    // full native window can OOM; if it does, the vLLM log shows it and the pref
    // can be capped to a number per Spark.
    let effMaxLen = maxLen;
    if (maxLen === "max" || maxLen === "auto") {
      const native = await detectNativeContext(spark, modelDir);
      effMaxLen = native || 131072;
      logActivity(`${label}: loading at ${native ? "native max" : "fallback"} context ${effMaxLen}`);
    }
    const unitName = vllmUnitName(port);
    // Stop whatever's on this port first, EITHER engine — see
    // stopAnyEngineOnPort's doc comment for why this can't just check its
    // own unit name (a port previously running SGLang must also be stopped
    // when switching it to vLLM).
    await stopAnyEngineOnPort(spark, port, label);

    const headroomOk = await checkGpuHeadroom(spark, gpuUtil, label);
    if (!headroomOk) return;

    const toolParser = arch ? ARCH_TOOL_PARSER[arch] : null;
    if (!toolParser) logActivity(`${label}: no known tool-call parser for this architecture — launching without tool-calling`);
    const cmd = vllmLaunchCmd(`${MODEL_ROOT}/${modelDir}`, port, servedName, effMaxLen, gpuUtil, toolParser, { enforceEager, kvCacheDtype, reasoningParser });
    const started = await systemdLaunch(spark, unitName, cmd, label);
    if (started) logActivity(`${label}: switching to ${servedName} (${modelDir}) on :${port} — persists via systemd (${unitName})`);
  } catch (e) {
    logActivity(`${label}: switch error — ${e}`);
  } finally {
    setTimeout(() => setPending(spark.id, null), 18000);
  }
}

export async function doSwitchSglang(spark, { modelDir, servedName, port, maxLen, gpuUtil, toolParser, reasoningParser, attentionBackend }) {
  const label = spark.name;
  setPending(spark.id, `launching ${servedName} (sglang) on port ${port}...`);
  try {
    let effMaxLen = maxLen;
    if (maxLen === "max" || maxLen === "auto") {
      const native = await detectNativeContext(spark, modelDir);
      effMaxLen = native || 131072;
      logActivity(`${label}: loading at ${native ? "native max" : "fallback"} context ${effMaxLen}`);
    }
    const unitName = sglangUnitName(port);
    // Same stop-first sequencing as doSwitch: stopAnyEngineOnPort checks
    // BOTH engines' unit names so a port previously running vLLM is stopped
    // too, and always re-verify GPU headroom live rather than trust our own
    // bookkeeping — this is the same guard that correctly rejects a launch
    // into Spark B's untracked ~97GB job.
    await stopAnyEngineOnPort(spark, port, label);

    const headroomOk = await checkGpuHeadroom(spark, gpuUtil, label);
    if (!headroomOk) return;

    const cmd = sglangLaunchCmd(`${MODEL_ROOT}/${modelDir}`, port, servedName, effMaxLen, gpuUtil, toolParser, { reasoningParser, attentionBackend });
    const started = await systemdLaunch(spark, unitName, cmd, label);
    if (started) logActivity(`${label}: switching to ${servedName} (${modelDir}, sglang) on :${port} — persists via systemd (${unitName})`);
  } catch (e) {
    logActivity(`${label}: sglang switch error — ${e}`);
  } finally {
    setTimeout(() => setPending(spark.id, null), 18000);
  }
}

export async function doKill(spark, { port }) {
  const label = spark.name;
  setPending(spark.id, `stopping process on port ${port}...`);
  try {
    // stopAnyEngineOnPort checks both unit namespaces — a port can be
    // running either engine, and only checking vllmUnitName would silently
    // miss an sglang launch, falling through to a vLLM-only pkill that
    // can't find or stop it.
    const cleared = await stopAnyEngineOnPort(spark, port, label);
    logActivity(`${label}: stopped process on :${port}${cleared ? "" : " (warning: GPU memory may not have fully cleared)"}`);
  } catch (e) {
    logActivity(`${label}: stop error — ${e}`);
  } finally {
    setPending(spark.id, null);
  }
}

export async function doWarm(spark, { model }) {
  const label = spark.name;
  setPending(spark.id, `warming ${model} in Ollama...`);
  try {
    const payload = JSON.stringify({ model, prompt: "hi", stream: false });
    const cmd = `curl -s -m 90 -X POST http://localhost:11434/api/generate -d ${JSON.stringify(payload)} >/dev/null 2>&1`;
    await sshRun(spark, cmd, 100000);
    logActivity(`${label}: warmed ${model} into memory`);
  } catch (e) {
    logActivity(`${label}: warm error — ${e}`);
  } finally {
    setPending(spark.id, null);
  }
}

/** Restart the vLLM server on a port with the exact same command it's already
 * running — for a hung/misbehaving process, not for switching models. Reads the
 * live cmdline off the box so it doesn't depend on parsed launch metadata. */
export async function doRestartVllm(spark, { port }) {
  const label = spark.name;
  setPending(spark.id, `restarting vLLM on port ${port}...`);
  try {
    const unitName = vllmUnitName(port);
    if (await systemdUnitExists(spark, unitName)) {
      // systemd-managed: a plain restart re-runs the same ExecStart, and
      // Restart=on-failure means this path is mostly a manual convenience —
      // the unit would have already tried to recover a hung/failed process.
      const res = await sshRun(spark, `systemctl --user restart ${unitName} 2>&1 && echo RESTARTED`, 25000);
      if (res.stdout.includes("RESTARTED")) logActivity(`${label}: restarted vLLM on :${port} (${unitName})`);
      else logActivity(`${label}: restart of ${unitName} may have failed — ${(res.stdout + res.stderr).trim().slice(0, 200)}`);
      return;
    }
    // Give an honest error rather than a misleading one if this port is
    // actually running SGLang, not vLLM — confirmed real bug (multi-reviewer
    // hunt, 2026-08-14): without this check, the legacy pgrep below (which
    // only ever matches "vllm serve") silently finds nothing for an SGLang
    // port and reports "no running vLLM", even though a live server IS
    // running there, just the wrong engine for this restart function.
    if (await systemdUnitExists(spark, sglangUnitName(port))) {
      logActivity(`${label}: :${port} is running SGLang, not vLLM — restart it via the SGLang panel instead`);
      return;
    }
    // Legacy path: a vLLM process launched before this port had a unit.
    const probe = await sshRun(
      spark,
      `pgrep -af 'vllm serve' 2>/dev/null | grep -- '--port ${port}' | head -1`,
      15000
    );
    const line = probe.stdout.trim();
    const m = line.match(/(vllm serve .*)$/) || line.match(/(\S*vllm\b.*)$/);
    if (!m) {
      logActivity(`${label}: restart error — no running vLLM on :${port} to restart`);
      return;
    }
    const runningCmd = m[1];
    await clearGpu(spark, port, label);
    const cmd = `PATH=${VLLM_VENV}/bin:$PATH ${VLLM_VENV}/bin/${runningCmd} > /home/argo/vllm-restart-${port}.log 2>&1`;
    const res = await sshBgLaunch(spark, cmd);
    if (!res.stdout.includes("LAUNCHED"))
      logActivity(`${label}: restart on :${port} may have failed to start`);
    else logActivity(`${label}: restarted vLLM on :${port} (legacy, not yet systemd-managed — relaunch via Switch to migrate it)`);
  } catch (e) {
    logActivity(`${label}: restart error — ${e}`);
  } finally {
    setTimeout(() => setPending(spark.id, null), 18000);
  }
}

export async function doRestartOllama(spark) {
  const label = spark.name;
  setPending(spark.id, "restarting Ollama service...");
  try {
    const res = await sshRun(spark, "sudo -n systemctl restart ollama 2>&1 && echo RESTART_OK", 30000);
    if (res.stdout.includes("RESTART_OK")) logActivity(`${label}: Ollama service restarted`);
    else logActivity(`${label}: Ollama restart may have failed — ${(res.stdout + res.stderr).trim().slice(0, 200)}`);
  } catch (e) {
    logActivity(`${label}: Ollama restart error — ${e}`);
  } finally {
    setPending(spark.id, null);
  }
}

export async function doGgufImport(spark, { ggufPath, modelName }) {
  const label = spark.name;
  setPending(spark.id, `importing ${modelName} into Ollama (can take several minutes)...`);
  try {
    const fullPath = `${MODEL_ROOT}/${ggufPath}`;
    const remoteLog = `/home/${sshUser(spark)}/ollama-import-${modelName}.log`;
    const cmd =
      `modelfile=$(mktemp) && echo 'FROM ${fullPath}' > "$modelfile" && ` +
      `ollama create ${modelName} -f "$modelfile" > ${remoteLog} 2>&1; rm -f "$modelfile"`;
    const res = await sshBgLaunch(spark, cmd);
    if (!res.stdout.includes("LAUNCHED")) {
      logActivity(`${label}: GGUF import of ${ggufPath} may have failed to start`);
      return;
    }
    for (let i = 0; i < 40; i++) {
      await sleep(15000);
      const check = await sshRun(
        spark,
        `ollama list 2>/dev/null | awk '{print $1}' | grep -Fx '${modelName}' && echo ---FOUND---; ` +
          `grep -a '^Error' ${remoteLog} 2>/dev/null | tail -1; tail -c 200 ${remoteLog} 2>/dev/null`,
        15000
      );
      if (check.stdout.includes("---FOUND---")) {
        logActivity(`${label}: imported ${ggufPath} into Ollama as '${modelName}'`);
        return;
      }
      const errLine = check.stdout.replace("---FOUND---", "").trim();
      if (errLine.startsWith("Error")) {
        logActivity(`${label}: GGUF import failed — ${errLine.slice(0, 200)} (source may be corrupt)`);
        return;
      }
      setPending(spark.id, `importing ${modelName} into Ollama...`, parseProgressPct(check.stdout));
    }
    logActivity(`${label}: GGUF import of ${ggufPath} still running after 10 min — check ${remoteLog}`);
  } catch (e) {
    logActivity(`${label}: GGUF import error — ${e}`);
  } finally {
    setPending(spark.id, null);
  }
}

export async function doPullModel(spark, { modelTag }) {
  const label = spark.name;
  setPending(spark.id, `pulling ${modelTag} (can take a long time for large models)...`);
  try {
    const safeName = modelTag.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
    const remoteLog = `/home/${sshUser(spark)}/ollama-pull-${safeName}.log`;
    const cmd = `ollama pull '${modelTag}' > ${remoteLog} 2>&1`;
    const res = await sshBgLaunch(spark, cmd);
    if (!res.stdout.includes("LAUNCHED")) {
      logActivity(`${label}: pull of ${modelTag} may have failed to start`);
      return;
    }
    for (let i = 0; i < 120; i++) {
      await sleep(15000);
      const check = await sshRun(
        spark,
        `ollama list 2>/dev/null | awk '{print $1}' | grep -Fx '${modelTag}' && echo ---FOUND---; ` +
          `tail -c 300 ${remoteLog} 2>/dev/null`,
        15000
      );
      if (check.stdout.includes("---FOUND---")) {
        logActivity(`${label}: pulled '${modelTag}' — ready to warm/use`);
        return;
      }
      const low = check.stdout.toLowerCase();
      if (low.includes("error") && !low.includes("pulling")) {
        logActivity(`${label}: pull of ${modelTag} failed — ${check.stdout.replace("---FOUND---", "").trim().slice(-200)}`);
        return;
      }
      setPending(spark.id, `pulling ${modelTag}...`, parseProgressPct(check.stdout));
    }
    logActivity(`${label}: pull of ${modelTag} still running after 30 min — check ${remoteLog}`);
  } catch (e) {
    logActivity(`${label}: pull error — ${e}`);
  } finally {
    setPending(spark.id, null);
  }
}

/** Launch a model via a sparkrun recipe. sparkrun runs locally and SSHes out.
 * The SSH user is carried by a one-host cluster file (current sparkrun has
 * no `run -u`). `--ensure` makes a second click a no-op while it is up. */
export async function doSparkrunRun(spark, { recipeName, port, servedName, gpuMem, maxModelLen }) {
  const label = spark.name;
  setPending(spark.id, `launching ${recipeName} via sparkrun...`);
  try {
    const host = sshHost(spark);
    const user = sshUser(spark);
    const { logPath } = sparkrun.launchRecipeDetached(recipeName, {
      host, user, port, servedName, gpuMem, maxModelLen,
    });
    for (let i = 0; i < 80; i++) {
      await sleep(15000);
      const text = sparkrun.readRecipeRunLog(logPath);
      const errMatch = text.match(/^Error:.*$/m);
      if (errMatch) {
        logActivity(`${label}: sparkrun launch of ${recipeName} failed — ${errMatch[0].slice(0, 200)}`);
        return;
      }
      if (/\[6\/6\] Post-launch hooks/.test(text)) {
        logActivity(`${label}: launched ${recipeName} via sparkrun (${servedName || recipeName}) — persists as a sparkrun-managed container`);
        return;
      }
      const stepMatch = [...text.matchAll(/^\[(\d)\/6\]\s+(.+)$/gm)].pop();
      setPending(spark.id, stepMatch ? `sparkrun: ${stepMatch[2]} (${stepMatch[1]}/6)...` : `launching ${recipeName} via sparkrun...`);
    }
    logActivity(`${label}: sparkrun launch of ${recipeName} still running after 20 min — check ${logPath}`);
  } catch (e) {
    logActivity(`${label}: sparkrun launch error — ${e}`);
  } finally {
    setPending(spark.id, null);
  }
}

/** Stop the sparkrun workload for this recipe on this Spark. */
export async function doSparkrunStop(spark, { recipeName, port }) {
  const label = spark.name;
  setPending(spark.id, `stopping ${recipeName}...`);
  try {
    const host = sshHost(spark);
    const user = sshUser(spark);
    const { logPath } = sparkrun.stopRecipeDetached(recipeName, { host, user, port });
    for (let i = 0; i < 12; i++) {
      await sleep(4000);
      const text = sparkrun.readRecipeRunLog(logPath);
      const errMatch = text.match(/^Error:.*$/m);
      if (errMatch) {
        logActivity(`${label}: sparkrun stop of ${recipeName} failed — ${errMatch[0].slice(0, 200)}`);
        return;
      }
      if (/Workload stopped/i.test(text)) {
        logActivity(`${label}: unloaded ${recipeName}`);
        return;
      }
    }
    logActivity(`${label}: sparkrun stop of ${recipeName} still finishing — check ${logPath}`);
  } catch (e) {
    logActivity(`${label}: sparkrun stop error — ${e}`);
  } finally {
    setPending(spark.id, null);
  }
}

/** Unload one resident Ollama model without restarting the daemon. */
export async function doOllamaStop(spark, { model }) {
  const label = spark.name;
  const tag = String(model || "").trim();
  setPending(spark.id, `unloading ${tag} from Ollama...`);
  try {
    const res = await sshRun(spark, `ollama stop ${JSON.stringify(tag)} 2>&1; echo STOP_DONE`, 30000);
    if (res.stdout.includes("STOP_DONE")) logActivity(`${label}: unloaded Ollama model ${tag}`);
    else logActivity(`${label}: Ollama unload of ${tag} may have failed — ${(res.stdout + res.stderr).trim().slice(0, 200)}`);
  } catch (e) {
    logActivity(`${label}: Ollama unload error — ${e}`);
  } finally {
    setPending(spark.id, null);
  }
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Clone a GitHub recipe (Mia or anywhere else) onto the Spark and run start.sh.
 * Unload runs stop.sh, then compose down, then kills start.sh. */
export async function doGitRecipe(spark, { url, action }) {
  const label = spark.name;
  const user = sshUser(spark);
  const m = String(url || "").match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) {
    logActivity(`${label}: refused recipe URL`);
    return;
  }
  const slug = `${m[1]}--${m[2]}`.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const dir = `/home/${user}/recipes/${slug}`;
  const log = `/home/${user}/recipes/${slug}.log`;
  const starting = action !== "stop";
  setPending(spark.id, starting ? `loading ${m[2]}...` : `unloading ${m[2]}...`);
  try {
    const script = starting
      ? `
mkdir -p /home/${user}/recipes
if [ ! -d ${shQuote(dir)}/.git ]; then
  git clone --depth 1 ${shQuote(url)} ${shQuote(dir)}
else
  git -C ${shQuote(dir)} pull --ff-only || true
fi
if [ ! -f ${shQuote(dir)}/start.sh ]; then echo 'NO_START'; exit 0; fi
setsid nohup bash ${shQuote(dir)}/start.sh > ${shQuote(log)} 2>&1 < /dev/null &
echo LAUNCHED
`
      : `
if [ -x ${shQuote(dir)}/stop.sh ]; then
  bash ${shQuote(dir)}/stop.sh > ${shQuote(log)} 2>&1
  echo STOPPED
elif [ -f ${shQuote(dir)}/docker-compose.yml ] || [ -f ${shQuote(dir)}/compose.yml ] || [ -f ${shQuote(dir)}/compose.yaml ]; then
  (cd ${shQuote(dir)} && docker compose down) > ${shQuote(log)} 2>&1
  echo STOPPED
else
  pkill -f ${shQuote(dir + "/start.sh")} >/dev/null 2>&1 || true
  echo STOPPED
fi
`;
    const res = await sshRun(spark, script, starting ? 120000 : 60000);
    const out = `${res.stdout}\n${res.stderr}`;
    if (out.includes("NO_START")) {
      logActivity(`${label}: ${url} has no start.sh — not launched`);
      return;
    }
    if (out.includes("LAUNCHED")) {
      logActivity(`${label}: started ${m[2]} from ${url} — log ${log}`);
      return;
    }
    if (out.includes("STOPPED")) {
      logActivity(`${label}: unloaded ${m[2]}`);
      return;
    }
    logActivity(`${label}: recipe ${starting ? "load" : "unload"} of ${m[2]} failed — ${out.trim().slice(-240)}`);
  } catch (e) {
    logActivity(`${label}: recipe ${starting ? "load" : "unload"} error — ${e}`);
  } finally {
    setPending(spark.id, null);
  }
}

export async function readGitRecipeLog(spark, url) {
  const user = sshUser(spark);
  const m = String(url || "").match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return "";
  const slug = `${m[1]}--${m[2]}`.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const log = `/home/${user}/recipes/${slug}.log`;
  const res = await sshRun(spark, `tail -c 4000 ${shQuote(log)} 2>/dev/null || true`, 15000);
  return res.stdout || "";
}

function transferHost(srcSpark, dstSpark) {
  const s = SITE_MAP[srcSpark.id], d = SITE_MAP[dstSpark.id];
  if (s && s === d && dstSpark.lanIp) return dstSpark.lanIp;
  return dstSpark.ssh?.host || dstSpark.lanIp;
}

const RESOLVE_OLLAMA_MANIFEST_SH = (tag) => `
tag=${JSON.stringify(tag)}
name="\${tag%%:*}"
ver="\${tag#*:}"
if [ "$name" = "$tag" ]; then ver="latest"; fi
case "$name" in
  */*)
    first_seg="\${name%%/*}"
    case "$first_seg" in
      *.*) manifest_rel="manifests/$name/$ver" ;;
      *) manifest_rel="manifests/registry.ollama.ai/$name/$ver" ;;
    esac
    ;;
  *)
    manifest_rel="manifests/registry.ollama.ai/library/$name/$ver" ;;
esac
manifest="${OLLAMA_MODELS_DIR}/$manifest_rel"
if [ ! -f "$manifest" ]; then echo "MANIFEST_NOT_FOUND: $manifest_rel"; exit 1; fi
echo "$manifest_rel"
grep -oE '"digest":"sha256:[a-f0-9]+"' "$manifest" | grep -oE 'sha256:[a-f0-9]+' | sed 's/sha256:/blobs\\/sha256-/' | sort -u
`;

export async function doCopyModel(srcSpark, dstSpark, { kind, name }) {
  const label = srcSpark.name;
  const dstId = dstSpark.id.replace("spark-", "").toUpperCase();
  const target = transferHost(srcSpark, dstSpark);
  const user = sshUser(srcSpark);
  const safeName = name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const remoteLog = `/home/${user}/copy-${safeName}-to-${dstSpark.id}.log`;
  setPending(srcSpark.id, `copying ${name} to Spark ${dstId}...`);
  try {
    let cmd;
    if (kind === "ollama") {
      // manifests/blobs are owned by the system "ollama" user; resolve the file
      // list as root (base64-piped to dodge shell-quoting), then rsync with
      // --rsync-path='sudo rsync' so the remote write side is elevated.
      const resolveB64 = Buffer.from(RESOLVE_OLLAMA_MANIFEST_SH(name)).toString("base64");
      const resolved = await sshRun(srcSpark, `echo ${resolveB64} | base64 -d | sudo -n bash`, 15000);
      const lines = resolved.stdout.trim().split("\n").filter((l) => l.trim());
      if (!lines.length || lines[0].startsWith("MANIFEST_NOT_FOUND")) {
        logActivity(`${label}: copy of ${name} failed — couldn't resolve Ollama manifest (${resolved.stdout.trim().slice(0, 150)})`);
        return;
      }
      const fileListB64 = Buffer.from(lines.join("\n")).toString("base64");
      cmd =
        `sudo -n chmod -R o+rX ${OLLAMA_MODELS_DIR}/manifests 2>/dev/null; ` +
        `echo ${fileListB64} | base64 -d | ` +
        `rsync -a --info=progress2 --rsync-path='sudo rsync' --files-from=- ${OLLAMA_MODELS_DIR}/ ${user}@${target}:${OLLAMA_MODELS_DIR}/ ` +
        `> ${remoteLog} 2>&1; ` +
        `ssh -o BatchMode=yes -o ConnectTimeout=15 ${user}@${target} 'sudo -n chown -R ollama:ollama ${OLLAMA_MODELS_DIR}' >> ${remoteLog} 2>&1; ` +
        `echo COPY_DONE >> ${remoteLog}`;
    } else if (kind === "vllm") {
      cmd =
        `ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new ${user}@${target} ` +
        `'sudo -n chmod u+w ${MODEL_ROOT} 2>/dev/null; true'; ` +
        `rsync -a --info=progress2 ${MODEL_ROOT}/${name}/ ${user}@${target}:${MODEL_ROOT}/${name}/ ` +
        `> ${remoteLog} 2>&1; echo COPY_DONE >> ${remoteLog}`;
    } else {
      logActivity(`${label}: copy error — unknown kind '${kind}'`);
      return;
    }
    const res = await sshBgLaunch(srcSpark, cmd);
    if (!res.stdout.includes("LAUNCHED")) {
      logActivity(`${label}: copy of ${name} may have failed to start`);
      return;
    }
    for (let i = 0; i < 240; i++) {
      await sleep(15000);
      const check = await sshRun(srcSpark, `tail -c 500 ${remoteLog} 2>/dev/null`, 15000);
      // error check MUST precede COPY_DONE (chained with ';', so DONE prints even on failure)
      if (/rsync error|No such file or directory|Could not resolve hostname/.test(check.stdout)) {
        logActivity(`${label}: copy of ${name} to Spark ${dstId} failed — ${check.stdout.trim().slice(-200)}`);
        return;
      }
      if (check.stdout.includes("COPY_DONE")) {
        logActivity(`${label}: copied ${name} to Spark ${dstId}`);
        return;
      }
      setPending(srcSpark.id, `copying ${name} to Spark ${dstId}...`, parseProgressPct(check.stdout));
    }
    logActivity(`${label}: copy of ${name} to Spark ${dstId} still running after 60 min — check ${remoteLog}`);
  } catch (e) {
    logActivity(`${label}: copy error — ${e}`);
  } finally {
    setPending(srcSpark.id, null);
  }
}

/**
 * Find a model the configured port list missed.
 *
 * Ports come from three places, so a recipe is not skipped just because it
 * picked something other than the saved list:
 *   - ports written in sparkrun recipe files (8000, 8888, 52001, …)
 *   - ports actually listening on the Spark
 *   - the --port on a live vLLM / SGLang / llama.cpp / EXL3 process
 *
 * A headless tensor-parallel worker has no API. Its model name still comes
 * off the command line.
 */
import fs from "fs";
import os from "os";
import path from "path";

/** Ports engines use when a recipe does not say. Mia uses 8888, sparkrun mostly 8000. */
export const DEFAULT_SERVE_PORTS = [8000, 8009, 8080, 8096, 8099, 8888, 11434, 30000, 5000];

const REGISTRY_ROOT =
  process.env.SPARKRUN_REGISTRY_DIR ||
  path.join(os.homedir(), ".cache", "sparkrun", "registries");

const SERVE_LINE = /vllm serve|sglang|launch_server|llama-server|llama-cli|serve_openai|exllama|text-generation-launcher|trtllm/;

let recipePortCache = { at: 0, root: "", ports: null };

export function parseServeLine(line) {
  const text = String(line || "");
  if (!SERVE_LINE.test(text)) return null;
  const named = text.match(/--served-model-name(?:=|\s+)("[^"]+"|\S+)/);
  let modelId = named ? named[1].replace(/^"|"$/g, "") : null;
  if (!modelId) {
    const positional = text.match(/vllm serve\s+(\S+)/);
    modelId = positional ? positional[1].split("/").pop() : null;
  }
  if (!modelId) return null;
  const portMatch = text.match(/--port(?:=|\s+)(\d+)/);
  const port = portMatch ? Number(portMatch[1]) : null;
  const headless = /(?:^|\s)--headless(?:\s|$)/.test(text);
  let backend = "vllm";
  if (/sglang/.test(text)) backend = "sglang";
  else if (/llama-server|llama-cli/.test(text)) backend = "llama.cpp";
  else if (/exllama|serve_openai/.test(text) && !/vllm serve/.test(text)) backend = "exl3";
  return { modelId, port, headless, backend };
}

/** Every --port on a serve command, even when the model name is missing. */
export function portsFromProcessText(text) {
  const ports = new Set();
  for (const line of String(text || "").split("\n")) {
    if (!SERVE_LINE.test(line)) continue;
    const match = line.match(/--port(?:=|\s+)(\d{2,5})\b/);
    if (!match) continue;
    const port = Number(match[1]);
    if (port >= 1024 && port <= 65535) ports.add(port);
  }
  return [...ports];
}

/** `port: 8000` and `--port 8000` inside a recipe file. */
export function portsInRecipeText(text) {
  const ports = new Set();
  const patterns = [/^\s*port\s*:\s*["']?(\d{2,5})\b/gim, /--port(?:=|\s+)(\d{2,5})\b/g];
  for (const pattern of patterns) {
    for (const match of String(text || "").matchAll(pattern)) {
      const port = Number(match[1]);
      if (port >= 1024 && port <= 65535) ports.add(port);
    }
  }
  return [...ports];
}

function walkRecipeFiles(dir, ports) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRecipeFiles(full, ports);
      continue;
    }
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    let text = "";
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    for (const port of portsInRecipeText(text)) ports.add(port);
  }
}

/** Defaults plus every port named by a sparkrun recipe on disk. Cached for 10 minutes. */
export function collectRecipePorts(root = REGISTRY_ROOT) {
  const now = Date.now();
  if (recipePortCache.ports && recipePortCache.root === root && now - recipePortCache.at < 10 * 60 * 1000) {
    return recipePortCache.ports;
  }
  const ports = new Set(DEFAULT_SERVE_PORTS);
  walkRecipeFiles(root, ports);
  const list = [...ports].sort((a, b) => a - b);
  recipePortCache = { at: now, root, ports: list };
  return list;
}

/**
 * Local ports from `ss -lnt`. Skips loopback (the dashboard cannot open those
 * on a remote Spark) and privileged ports that are not model servers.
 */
export function parseListeningPorts(text) {
  const ports = new Set();
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || /^Netid\b/.test(line) || /^State\b/.test(line)) continue;
    const parts = line.split(/\s+/);
    let local = null;
    if (parts[0] === "LISTEN") local = parts[3];
    else if (parts[1] === "LISTEN") local = parts[4];
    if (!local) continue;
    if (local.startsWith("127.") || local.startsWith("[::1]")) continue;
    const match = local.match(/:(\d+)$/);
    if (!match) continue;
    const port = Number(match[1]);
    if (port >= 1024 && port <= 65535) ports.add(port);
  }
  return [...ports];
}

export function splitDiscoverOutput(text) {
  const raw = String(text || "");
  const marker = "---SS---";
  const idx = raw.indexOf(marker);
  if (idx < 0) return { ps: raw, ss: "" };
  return { ps: raw.slice(0, idx), ss: raw.slice(idx + marker.length) };
}

const GPU_ENGINE = /vllm|sglang|ollama|llama|exllama|trtllm|text-generation/i;

/** A GPU process that means a model is resident, even when no port answers. */
export function gpuHoldsModel(processes) {
  const hits = (Array.isArray(processes) ? processes : [])
    .filter((proc) => proc && GPU_ENGINE.test(String(proc.name || "")) && Number(proc.vramMB) >= 256)
    .sort((a, b) => Number(b.vramMB) - Number(a.vramMB));
  if (!hits.length) return null;
  const top = hits[0];
  const name = String(top.name);
  let backend = "vllm";
  if (/sglang/i.test(name)) backend = "sglang";
  else if (/ollama/i.test(name)) backend = "ollama";
  else if (/llama/i.test(name)) backend = "llama.cpp";
  else if (/exllama/i.test(name)) backend = "exl3";
  return { backend, processName: name, vramMB: Number(top.vramMB) || 0, pid: top.pid ?? null };
}

/**
 * What the page should show. A model on the GPU counts as loaded even when
 * every probed port is empty. The name comes from the serve command when we
 * have it, otherwise from the GPU process.
 */
export function mergeLoadedView({ ports = [], llm = [], resident = null, processes = [] } = {}) {
  const visiblePorts = [...ports];
  const visibleLlm = Array.isArray(llm) ? [...llm] : [];
  const hasModel = () => visibleLlm.some((row) => row?.modelId);
  if (resident?.modelId && resident.headless && !visibleLlm.some((row) => row?.modelId === resident.modelId)) {
    visiblePorts.push(resident.port || 0);
    visibleLlm.push(residentMetric(resident));
  }
  if (!hasModel()) {
    const gpu = gpuHoldsModel(processes);
    if (gpu) {
      visiblePorts.push(0);
      visibleLlm.push({
        ...residentMetric({
          backend: gpu.backend,
          modelId: resident?.modelId || gpu.processName,
          headless: true,
          port: 0,
        }),
        gpuResident: true,
      });
    }
  }
  return { ports: visiblePorts, llm: visibleLlm };
}

/** Ports worth an HTTP check: recipe files, listeners, and live --port flags. */
export function candidatePorts({ listening = [], processPorts = [], recipePorts = [] } = {}) {
  const ports = new Set();
  for (const list of [recipePorts, listening, processPorts]) {
    for (const port of list) {
      const n = Number(port);
      if (n >= 1024 && n <= 65535) ports.add(n);
    }
  }
  return [...ports];
}

export function parseServeOutput(text) {
  const infos = String(text || "")
    .split("\n")
    .map(parseServeLine)
    .filter(Boolean);
  return {
    serving: infos.find((info) => !info.headless && info.port) || null,
    worker: infos.find((info) => info.headless) || null,
  };
}

export function residentMetric(info) {
  return {
    available: true,
    backend: info.backend,
    modelId: info.modelId,
    modelPath: null,
    contextLength: null,
    gpuMemoryUtilization: null,
    slotsActive: 1,
    slotsTotal: 1,
    generationTps: 0,
    prefillTps: 0,
    cachedPrefillTps: null,
    uncachedPrefillTps: null,
    totalOutputTokens: 0,
    posture: null,
    error: null,
    headless: true,
  };
}

/** True when this port is an OpenAI server with a model loaded, or Ollama with one resident. */
export async function portServesModel(host, port, timeoutMs = 1500) {
  if (!host || !port) return false;
  const base = `http://${host}:${port}`;
  for (const path of ["/v1/models", "/api/ps"]) {
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (path === "/v1/models" && Array.isArray(data?.data) && data.data.length > 0) return true;
      if (path === "/api/ps" && Array.isArray(data?.models) && data.models.length > 0) return true;
    } catch {
      /* closed or not a model server */
    }
  }
  return false;
}

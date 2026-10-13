import { sshExec } from "./ssh.js";

const REMOTE_SCRIPT = String.raw`
python3 << 'PYEOF'
import json, os, glob, subprocess, sys, re

MODEL_ROOT = "/home/argo/models"
result = {"modelDirs": [], "ggufFiles": [], "ollamaTags": [], "vllmProcs": []}

# model_dirs
try:
    for entry in sorted(os.listdir(MODEL_ROOT)):
        d = os.path.join(MODEL_ROOT, entry)
        cfg = os.path.join(d, "config.json")
        if os.path.isdir(d) and os.path.isfile(cfg):
            try:
                with open(cfg) as f:
                    data = json.load(f)
            except:
                data = {}
            arch = (data.get("architectures") or [None])[0]
            present = set(os.path.basename(x) for x in glob.glob(os.path.join(d, "*.safetensors")))
            # Authoritative completeness: the index lists every shard the model
            # needs; check they're all present. Fall back to single-file / count.
            index = os.path.join(d, "model.safetensors.index.json")
            if os.path.isfile(index):
                try:
                    wm = json.load(open(index)).get("weight_map", {})
                    required = set(wm.values())
                    shards = len(required)
                    complete = shards > 0 and required.issubset(present)
                except:
                    shards = len(present); complete = shards > 0
            elif "model.safetensors" in present:
                shards = 1; complete = True
            else:
                shards = len(present); complete = shards > 0
            result["modelDirs"].append({
                "name": entry,
                "complete": complete,
                "shards": shards,
                "arch": arch or None
            })
except:
    pass

# gguf_files
try:
    for f in sorted(glob.glob(os.path.join(MODEL_ROOT, "*.gguf"))):
        result["ggufFiles"].append(os.path.basename(f))
except:
    pass

# ollama_tags
try:
    out = subprocess.check_output(["ollama", "list"], stderr=subprocess.DEVNULL, timeout=15).decode()
    for line in out.strip().splitlines():
        parts = line.strip().split(None, 1)
        if parts and parts[0] != "NAME":
            result["ollamaTags"].append(parts[0])
except:
    pass

# vllm_procs
try:
    out = subprocess.check_output(["pgrep", "-af", "vllm serve"], stderr=subprocess.DEVNULL, timeout=10).decode()
    for line in out.strip().splitlines():
        line = line.strip()
        if not line or "vllm serve" not in line:
            continue
        parts = line.split()
        port = served_name = model_path = None
        max_model_len = gpu_mem_util = None
        for i, p in enumerate(parts):
            if p == "--port" and i + 1 < len(parts):
                port = int(parts[i + 1])
            elif p == "--served-model-name" and i + 1 < len(parts):
                served_name = parts[i + 1]
            elif p == "--max-model-len" and i + 1 < len(parts):
                max_model_len = int(parts[i + 1])
            elif p == "--gpu-memory-utilization" and i + 1 < len(parts):
                gpu_mem_util = float(parts[i + 1])
        for i, p in enumerate(parts):
            if p == "serve" and i + 1 < len(parts) and not parts[i + 1].startswith("-"):
                model_path = parts[i + 1]
                break
        # pgrep matches the API server AND worker/wrapper lines; only the real
        # serve invocation carries --port. Skip portless lines and dedupe.
        if port is None:
            continue
        result["vllmProcs"].append({
            "port": port,
            "servedName": served_name or None,
            "modelPath": model_path or None,
            "maxModelLen": max_model_len,
            "gpuMemUtil": gpu_mem_util
        })
    _seen = set()
    result["vllmProcs"] = [
        x for x in result["vllmProcs"]
        if not (x["port"] in _seen or _seen.add(x["port"]))
    ]
except:
    pass

print(json.dumps(result))
PYEOF
`;

export async function collectInventory(spark) {
  const output = await sshExec(spark, REMOTE_SCRIPT, { timeoutMs: 30000 });
  try {
    const parsed = JSON.parse(output);
    return {
      modelDirs: parsed.modelDirs || [],
      ggufFiles: parsed.ggufFiles || [],
      ollamaTags: parsed.ollamaTags || [],
      vllmProcs: parsed.vllmProcs || [],
    };
  } catch (err) {
    throw new Error(
      `Failed to parse inventory JSON from ${spark.id}: ${err.message}`
    );
  }
}

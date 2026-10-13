/**
 * Live check: the running dashboard must agree with the Sparks.
 * If a GPU process is holding a model, the API has to name something loaded.
 * Does not start or stop a model.
 */
const BASE = process.env.SPARKDASH_URL || "http://127.0.0.1:5555";

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function gpuHoldsModel(processes) {
  return (Array.isArray(processes) ? processes : []).find(
    (proc) => /vllm|sglang|ollama|llama|exllama|trtllm/i.test(String(proc?.name || "")) && Number(proc?.vramMB) >= 256
  );
}

const failures = [];

const health = await get("/api/health");
if (health.status !== 200 || !health.body?.ok) failures.push(`health ${health.status}`);

const recipes = await get("/api/recipes");
const list = recipes.body?.recipes || [];
const sparkrun = list.filter((r) => r.source === "sparkrun").length;
const mia = list.filter((r) => r.source === "mia").length;
if (recipes.status !== 200 || sparkrun < 1) failures.push("sparkrun catalog is empty");
if (mia < 1) failures.push(`Mia catalog missing (${recipes.body?.miaError || "no recipes"})`);

const bad = await fetch(`${BASE}/api/recipes/import`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "nope" }),
});
if (bad.status !== 400) failures.push(`bad recipe import returned ${bad.status}, expected 400`);

const sparks = await get("/api/sparks");
const ids = (sparks.body?.sparks || []).map((s) => s.id);
if (!ids.length) failures.push("no sparks listed");

for (const id of ids) {
  const snap = await get(`/api/sparks/${encodeURIComponent(id)}/metrics`);
  if (snap.status !== 200) {
    failures.push(`${id} metrics ${snap.status}`);
    continue;
  }
  const gpu = gpuHoldsModel(snap.body?.metrics?.gpu?.processes);
  const loaded = (snap.body?.metrics?.llm || []).filter((row) => row?.modelId);
  if (gpu && loaded.length === 0) {
    failures.push(
      `${id} GPU has ${gpu.name} using ${gpu.vramMB} MB, but the dashboard shows nothing loaded`
    );
  } else if (gpu) {
    console.log(`${id}: ${loaded.map((row) => row.modelId).join(", ")} (gpu ${gpu.name})`);
  } else {
    console.log(`${id}: no GPU model`);
  }
}

console.log(`catalog: ${sparkrun} sparkrun, ${mia} Mia`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("live check ok");

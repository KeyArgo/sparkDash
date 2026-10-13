import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("ollama /api/ps is the loaded model, not the first installed tag", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 11434);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/api/version")) return jsonRes({ version: "0.9.0" });
    if (u.endsWith("/api/ps")) {
      return jsonRes({
        models: [{ name: "qwen3.6:35b-a3b", model: "qwen3.6:35b-a3b", context_length: 32768 }],
      });
    }
    if (u.endsWith("/v1/models")) {
      return jsonRes({ data: [{ id: "qwen3:8b", owned_by: "library" }] });
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "ollama");
  const snap = await probe.probe();
  assert.equal(snap.backend, "ollama");
  assert.equal(snap.modelId, "qwen3.6:35b-a3b");
  assert.equal(snap.available, true);
  assert.equal(snap.contextLength, 32768);
  assert.equal(snap.generationTps, 0);
});

test("ollama with an empty /api/ps is up and has nothing loaded", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 11434);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/api/version")) return jsonRes({ version: "0.9.0" });
    if (u.endsWith("/api/ps")) return jsonRes({ models: [] });
    if (u.endsWith("/v1/models")) {
      return jsonRes({ data: [{ id: "qwen3:8b", owned_by: "library" }] });
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const snap = await probe.probe();
  assert.equal(snap.backend, "ollama");
  assert.equal(snap.modelId, null);
  assert.equal(snap.available, false);
});

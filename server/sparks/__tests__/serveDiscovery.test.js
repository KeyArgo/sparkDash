import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  candidatePorts,
  collectRecipePorts,
  gpuHoldsModel,
  mergeLoadedView,
  parseListeningPorts,
  parseServeLine,
  parseServeOutput,
  portsInRecipeText,
  residentMetric,
} from "../serveDiscovery.js";

const HEAD =
  "python3 /usr/local/bin/vllm serve /root/models--Mia-AiLab--GLM-5.3-Flash-EXL3-TR3-4bpw/snapshots/abc --served-model-name GLM-5.3-Flash-EXL3 --port 8888 --tensor-parallel-size 2 --nnodes 2 --node-rank 0";

const WORKER =
  "python3 /usr/local/bin/vllm serve /root/models--Mia-AiLab--GLM-5.3-Flash-EXL3-TR3-4bpw/snapshots/abc --served-model-name GLM-5.3-Flash-EXL3 --port 8888 --tensor-parallel-size 2 --nnodes 2 --node-rank 1 --headless";

test("head command is the API on :8888", () => {
  const info = parseServeLine(HEAD);
  assert.equal(info.modelId, "GLM-5.3-Flash-EXL3");
  assert.equal(info.port, 8888);
  assert.equal(info.headless, false);
  assert.equal(info.backend, "vllm");
});

test("worker command is headless and still names the model", () => {
  const found = parseServeOutput(WORKER);
  assert.equal(found.serving, null);
  assert.equal(found.worker.modelId, "GLM-5.3-Flash-EXL3");
  assert.equal(found.worker.headless, true);
  const metric = residentMetric(found.worker);
  assert.equal(metric.available, true);
  assert.equal(metric.modelId, "GLM-5.3-Flash-EXL3");
  assert.equal(metric.headless, true);
});

test("recipe files and listeners both contribute ports", () => {
  const fromYaml = portsInRecipeText("port: 8000\ncommand: vllm serve m --port 52001\n");
  assert.deepEqual(fromYaml.sort((a, b) => a - b), [8000, 52001]);
  const listening = parseListeningPorts(`
State  Recv-Q Send-Q Local Address:Port Peer Address:Port
LISTEN 0      128    127.0.0.1:11000    0.0.0.0:*
LISTEN 0      2048   0.0.0.0:8888       0.0.0.0:*
LISTEN 0      4096   *:11434            *:*
LISTEN 0      128    0.0.0.0:22         0.0.0.0:*
`);
  assert.deepEqual(listening.sort((a, b) => a - b), [8888, 11434]);
  const ports = candidatePorts({ listening, recipePorts: collectRecipePorts("/no/such/registries") });
  for (const expected of [8000, 8888, 11434, 30000]) {
    assert.ok(ports.includes(expected), `missing ${expected}`);
  }
  assert.equal(ports.includes(22), false);
  assert.equal(ports.includes(11000), false);
});

test("GPU resident model is shown when every port is empty", () => {
  const processes = [{ pid: 3442355, name: "VLLM::Worker_TP0", vramMB: 103549 }];
  assert.equal(gpuHoldsModel(processes)?.backend, "vllm");
  const view = mergeLoadedView({
    ports: [8096, 11434, 8080],
    llm: [null, null, null],
    processes,
  });
  assert.ok(view.llm.some((row) => row?.modelId === "VLLM::Worker_TP0"));
  const named = mergeLoadedView({
    ports: [8096],
    llm: [{ modelId: null, available: false }],
    resident: { modelId: "GLM-5.3-Flash-EXL3", headless: true, backend: "vllm", port: 8888 },
    processes,
  });
  assert.ok(named.llm.some((row) => row?.modelId === "GLM-5.3-Flash-EXL3"));
});

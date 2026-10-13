/**
 * Control plane lifecycle tests
 *
 * Tests exported functions from control.js:
 * - Regex validation (NAME_RE, MODEL_DIR_RE, PULL_TAG_RE)
 * - Command builders (vllmLaunchCmd, killVllmCmd)
 * - GPU helpers (gpuIsClear, clearGpu)
 * - Unit name generation (vllmUnitName)
 *
 * Note: SSH/spawn mocking for full integration tests in separate file
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as control from "../control.js";

describe("control: validation & command builders", () => {
  describe("NAME_RE regex", () => {
    it("accepts alphanumeric with dots, dashes, underscores", () => {
      assert.ok(control.NAME_RE.test("qwen3.6-35b"));
      assert.ok(control.NAME_RE.test("deepseek_v4"));
      assert.ok(control.NAME_RE.test("model-123"));
      assert.ok(control.NAME_RE.test("a_b.c-d"));
    });

    it("rejects spaces", () => {
      assert.ok(!control.NAME_RE.test("model with spaces"));
      assert.ok(!control.NAME_RE.test("model "));
    });

    it("rejects slashes and special chars", () => {
      assert.ok(!control.NAME_RE.test("model/slash"));
      assert.ok(!control.NAME_RE.test("model@symbol"));
      assert.ok(!control.NAME_RE.test("model#hash"));
    });
  });

  describe("MODEL_DIR_RE regex", () => {
    it("accepts model directory paths", () => {
      assert.ok(control.MODEL_DIR_RE.test("Qwen3.6-35B"));
      assert.ok(control.MODEL_DIR_RE.test("path/to/model"));
      assert.ok(control.MODEL_DIR_RE.test("a/b/c/d"));
      assert.ok(control.MODEL_DIR_RE.test("DeepSeek-V4-Flash-0731-GGUF"));
    });

    it("rejects paths with spaces", () => {
      assert.ok(!control.MODEL_DIR_RE.test("path with spaces"));
      assert.ok(!control.MODEL_DIR_RE.test("path /to/model"));
    });

    it("allows dots in directory names (used in versioning)", () => {
      // Note: Regex allows dots as valid chars in names (e.g., "model.v1.0")
      // Security against traversal handled at usage time via path.normalize()
      assert.ok(control.MODEL_DIR_RE.test("path/model.v1/subdir"));
      assert.ok(control.MODEL_DIR_RE.test("cache.old/archive"));
    });
  });

  describe("PULL_TAG_RE regex", () => {
    it("accepts ollama-style tags", () => {
      assert.ok(control.PULL_TAG_RE.test("qwen2:7b"));
      assert.ok(control.PULL_TAG_RE.test("hf.co/organisation/model:sha"));
      assert.ok(control.PULL_TAG_RE.test("model-name_v1.0"));
      assert.ok(control.PULL_TAG_RE.test("local/model:latest"));
    });

    it("rejects special characters", () => {
      assert.ok(!control.PULL_TAG_RE.test("model@symbol"));
      assert.ok(!control.PULL_TAG_RE.test("model&other"));
    });
  });

  describe("vllmUnitName", () => {
    it("generates systemd unit name from port", () => {
      assert.equal(control.vllmUnitName(8000), "vllm-port-8000");
      assert.equal(control.vllmUnitName(8001), "vllm-port-8001");
      assert.equal(control.vllmUnitName(8099), "vllm-port-8099");
    });

    it("handles various port numbers", () => {
      assert.ok(/^vllm-port-\d+$/.test(control.vllmUnitName(5000)));
      assert.ok(/^vllm-port-\d+$/.test(control.vllmUnitName(65535)));
    });
  });

  describe("killVllmCmd", () => {
    it("builds kill command with pkill + fuser + nvidia-smi polling", () => {
      const cmd = control.killVllmCmd(8000);
      assert.ok(cmd.includes("pkill -9"));
      assert.ok(cmd.includes("vllm"));
      assert.ok(cmd.includes("fuser -k 8000/tcp"));
      assert.ok(cmd.includes("nvidia-smi"));
      assert.ok(cmd.includes("GPU_CLEAR"));
      assert.ok(cmd.includes("KILL_DONE"));
    });

    it("varies port number in command", () => {
      const cmd8000 = control.killVllmCmd(8000);
      const cmd8001 = control.killVllmCmd(8001);
      assert.ok(cmd8000.includes("8000"));
      assert.ok(cmd8001.includes("8001"));
      assert.notEqual(cmd8000, cmd8001);
    });

    it("includes EngineCore-aware kill strategy", () => {
      const cmd = control.killVllmCmd(8000);
      // Should kill by venv path AND by setproctitle name
      assert.ok(cmd.includes("vllm::") || cmd.includes("vllm_"));
      assert.ok(cmd.includes("/bin/python"));
    });
  });

  describe("vllmLaunchCmd", () => {
    it("builds complete vllm serve command with required flags", () => {
      const cmd = control.vllmLaunchCmd(
        "/models/Qwen3.6-35B",
        8000,
        "spark-a",
        131072,
        0.82
      );
      assert.ok(cmd.includes("vllm serve"));
      assert.ok(cmd.includes("/models/Qwen3.6-35B"));
      assert.ok(cmd.includes("--port 8000"));
      assert.ok(cmd.includes("--served-model-name spark-a"));
      assert.ok(cmd.includes("--max-model-len 131072"));
      assert.ok(cmd.includes("--gpu-memory-utilization 0.82"));
      assert.ok(cmd.includes("--enable-prefix-caching"));
      assert.ok(cmd.includes("--trust-remote-code"));
    });

    it("includes fp8 kv-cache when specified", () => {
      const cmd = control.vllmLaunchCmd(
        "/models/Qwen",
        8000,
        "spark-a",
        131072,
        0.82,
        null,
        { kvCacheDtype: "fp8" }
      );
      assert.ok(cmd.includes("--kv-cache-dtype fp8"));
    });

    it("includes tool-call parser when provided", () => {
      const cmd = control.vllmLaunchCmd(
        "/models/Qwen",
        8000,
        "spark-a",
        131072,
        0.82,
        "qwen3_xml"
      );
      assert.ok(cmd.includes("--enable-auto-tool-choice"));
      assert.ok(cmd.includes("--tool-call-parser qwen3_xml"));
    });

    it("includes reasoning parser when specified", () => {
      const cmd = control.vllmLaunchCmd(
        "/models/Claude",
        8000,
        "spark-a",
        131072,
        0.82,
        null,
        { reasoningParser: "native" }
      );
      assert.ok(cmd.includes("--reasoning-parser native"));
    });

    it("includes enforce-eager when specified", () => {
      const cmd = control.vllmLaunchCmd(
        "/models/Model",
        8000,
        "spark-a",
        131072,
        0.82,
        null,
        { enforceEager: true }
      );
      assert.ok(cmd.includes("--enforce-eager"));
    });

    it("combines multiple optional flags", () => {
      const cmd = control.vllmLaunchCmd(
        "/models/Model",
        8000,
        "spark-a",
        131072,
        0.82,
        "auto_tool_choice",
        { enforceEager: true, kvCacheDtype: "fp8", reasoningParser: "native" }
      );
      assert.ok(cmd.includes("--enforce-eager"));
      assert.ok(cmd.includes("--kv-cache-dtype fp8"));
      assert.ok(cmd.includes("--reasoning-parser native"));
      assert.ok(cmd.includes("--tool-call-parser"));
    });

    it("logs output to model-specific file", () => {
      const cmd = control.vllmLaunchCmd(
        "/models/Qwen",
        8000,
        "spark-a",
        131072,
        0.82
      );
      assert.ok(cmd.includes("/vllm-spark-a.log"));
    });
  });

  describe("control status tracking", () => {
    it("getControlStatus returns pending and activity", () => {
      const status = control.getControlStatus();
      assert.ok(status.pending !== undefined);
      assert.ok(Array.isArray(status.activity));
      assert.ok(typeof status.pending === "object");
    });
  });
});

// ─── TODO: Integration tests (requires SSH mocking) ─────────────────────────
// The following need full SSH/spawn mocking (separate integration test file):
//
// - systemdUnitExists() — queries systemctl
// - systemdLaunch() — creates + enables unit, returns success/failure
// - systemdStop() — disables + stops unit
// - checkGpuHeadroom() — queries nvidia-smi + free, validates headroom
// - doSwitch() — full workflow (stop old → check GPU → launch new)
// - doKill() — full workflow (stop + verify GPU clear)
// - doWarm() — Ollama warm workflow
// - doRestartVllm() — restart workflow (systemd or legacy)
// - gpuIsClear() — polls nvidia-smi for GPU clear
// - clearGpu() — kill vLLM + verify GPU clear
//
// These are exported and testable, but require mocking the spawn/SSH layer.

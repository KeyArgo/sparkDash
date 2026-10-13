import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdeck-profiles-test-"));
const fleetPath = path.join(tmpDir, "fleet-litellm.json");
const prefsPath = path.join(tmpDir, "launch-prefs.json");

fs.writeFileSync(
  fleetPath,
  JSON.stringify({
    "spark-b": { alias: "sparkb" },
  }),
);

fs.writeFileSync(
  prefsPath,
  JSON.stringify({
    default: { context: 131072, gpuUtil: 0.8 },
    models: { "Kokoro-82M": { context: 512 } },
    sparks: { "spark-b": { context: 65536 } },
  }),
);

process.env.FLEET_LITELLM_PATH = fleetPath;
process.env.LAUNCH_PREFS_PATH = prefsPath;

const profiles = await import("../profiles.js");

describe("profiles", () => {
  describe("aliasFor", () => {
    it("returns the override alias when fleet-litellm maps spark-b -> sparkb", () => {
      assert.equal(profiles.aliasFor({ id: "spark-b" }), "sparkb");
    });

    it("returns the spark id when no override exists", () => {
      assert.equal(profiles.aliasFor({ id: "spark-a" }), "spark-a");
    });
  });

  describe("vllmPortFor", () => {
    it("returns the first non-Ollama port from llmPorts", () => {
      assert.equal(
        profiles.vllmPortFor({ id: "spark-b", llmPorts: [8099, 11434] }),
        8099,
      );
    });

    it("returns null when only Ollama port is available", () => {
      assert.equal(
        profiles.vllmPortFor({ id: "spark-c", llmPorts: [11434] }),
        null,
      );
    });
  });

  describe("resolveContext", () => {
    it("per-model override in launch-prefs takes precedence over spark and default", () => {
      assert.equal(profiles.resolveContext("spark-b", "Kokoro-82M"), 512);
    });

    it("spark override is used when no model override matches", () => {
      assert.equal(profiles.resolveContext("spark-b", "SomeOtherModel"), 65536);
    });

    it("default context is used when no overrides apply", () => {
      assert.equal(profiles.resolveContext("spark-c", "Foo"), 131072);
    });
  });

  describe("toLiteLLMConfig", () => {
    it("produces YAML with the override alias and api_base from ssh host + port", () => {
      const sparks = [
        { id: "spark-b", ssh: { host: "h" }, llmPorts: [8099] },
      ];
      const result = profiles.toLiteLLMConfig(sparks, {});
      assert.ok(result.includes("model_name: sparkb"), `missing alias in:\n${result}`);
      assert.ok(
        result.includes("api_base: http://h:8099/v1"),
        `missing api_base in:\n${result}`,
      );
    });
  });
});

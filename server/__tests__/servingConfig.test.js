import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdeck-serving-config-test-"));
const servingPath = path.join(tmpDir, "serving-config.json");
process.env.SERVING_CONFIG_PATH = servingPath;

const servingConfig = await import("../servingConfig.js");

const serverIndexPath = fileURLToPath(
  new URL("../index.js", import.meta.url)
);

describe("servingConfig", () => {
  describe("normalizeConfig", () => {
    it("defaults model null, mtp 0, fp8Kv true, noThink false, caching on", () => {
      assert.deepEqual(servingConfig.normalizeConfig({}), {
        model: null,
        mtp: 0,
        fp8Kv: true,
        noThink: false,
        prefixCaching: true,
        chunkedPrefill: true,
      });
    });

    it("accepts a full valid config", () => {
      assert.deepEqual(
        servingConfig.normalizeConfig({
          model: "Qwen3.6-27B-FP8",
          mtp: 3,
          fp8Kv: false,
          noThink: true,
          prefixCaching: false,
          chunkedPrefill: false,
        }),
        {
          model: "Qwen3.6-27B-FP8",
          mtp: 3,
          fp8Kv: false,
          noThink: true,
          prefixCaching: false,
          chunkedPrefill: false,
        }
      );
    });

    it("coerces truthy/falsy noThink to a boolean", () => {
      assert.equal(servingConfig.normalizeConfig({ noThink: 1 }).noThink, true);
      assert.equal(servingConfig.normalizeConfig({ noThink: 0 }).noThink, false);
      assert.equal(servingConfig.normalizeConfig({}).noThink, false);
    });

    it("rejects mtp values outside off/1/3", () => {
      assert.throws(() => servingConfig.normalizeConfig({ mtp: 2 }), /invalid mtp/);
      assert.throws(() => servingConfig.normalizeConfig({ mtp: -1 }), /invalid mtp/);
      assert.throws(() => servingConfig.normalizeConfig({ mtp: 100 }), /invalid mtp/);
    });

    it("rejects traversal model names", () => {
      assert.throws(
        () => servingConfig.normalizeConfig({ model: "../etc/passwd" }),
        /invalid model/
      );
    });

    it("coerces 'off'/'on' string mtp", () => {
      assert.equal(servingConfig.normalizeConfig({ mtp: "off" }).mtp, 0);
      assert.equal(servingConfig.normalizeConfig({ mtp: "on" }).mtp, 1);
    });
  });

  describe("translateConfigToFlags", () => {
    it("translates fp8Kv on to --kv-cache-dtype fp8, off to auto", () => {
      assert.ok(
        servingConfig.translateConfigToFlags({ model: null, mtp: 0, fp8Kv: true }).argv.includes("fp8")
      );
      const off = servingConfig.translateConfigToFlags({ model: null, mtp: 0, fp8Kv: false });
      assert.equal(off.argv[off.argv.indexOf("--kv-cache-dtype") + 1], "auto");
    });

    it("omits --speculative-config when mtp is off", () => {
      const out = servingConfig.translateConfigToFlags({ model: "M", mtp: 0, fp8Kv: true });
      assert.equal(out.mtpJson, null);
      assert.ok(!out.argv.includes("--speculative-config"));
      assert.ok(!out.shell.includes("--speculative-config"));
    });

    it("emits MTP speculative config for depth 1", () => {
      const out = servingConfig.translateConfigToFlags({
        model: "Qwen3.6-27B-FP8",
        mtp: 1,
        fp8Kv: true,
      });
      const idx = out.argv.indexOf("--speculative-config");
      assert.ok(idx >= 0);
      const json = out.argv[idx + 1];
      assert.ok(json.includes('"num_speculative_tokens":1'));
      assert.ok(json.includes('"mtp_worker":"mtp"'));
      assert.ok(json.includes('"model":"/home/argo/models/Qwen3.6-27B-FP8"'));
    });

    it("emits MTP speculative config for depth 3", () => {
      const out = servingConfig.translateConfigToFlags({
        model: "M3",
        mtp: 3,
        fp8Kv: true,
      });
      const json = out.mtpJson;
      assert.ok(json.includes('"num_speculative_tokens":3'));
    });

    it("the MTP speculative-config JSON is a single token with NO spaces", () => {
      const out = servingConfig.translateConfigToFlags({
        model: "Qwen3.6-27B-FP8",
        mtp: 3,
        fp8Kv: true,
      });
      const json = out.mtpJson;
      // No whitespace anywhere in the JSON value
      assert.ok(!/\s/.test(json), `expected no whitespace in: ${json}`);
      // The shell fragment must split the --speculative-config flag + value
      // into exactly two shell tokens — the value must not fragment further.
      const tokens = out.shell.split(" ");
      const i = tokens.indexOf("--speculative-config");
      assert.ok(i >= 0);
      assert.equal(tokens[i + 1], json);
      assert.equal(tokens[i + 2], undefined);
    });

    it("model select translates to a model path", () => {
      const out = servingConfig.translateConfigToFlags({
        model: "Qwen3.6-27B-FP8",
        mtp: 0,
        fp8Kv: true,
      });
      assert.equal(out.modelPath, "/home/argo/models/Qwen3.6-27B-FP8");
      assert.equal(out.argv[0], "/home/argo/models/Qwen3.6-27B-FP8");
    });

    it("returns a flat shell line (safe for bash -s splicing)", () => {
      const out = servingConfig.translateConfigToFlags({
        model: "M",
        mtp: 1,
        fp8Kv: false,
      });
      assert.equal(out.shell, out.argv.join(" "));
      assert.ok(out.shell.startsWith("/home/argo/models/M "));
    });

    it("noThink is a request-time override, NOT a launch flag", () => {
      const on = servingConfig.translateConfigToFlags({
        model: "M",
        mtp: 0,
        fp8Kv: true,
        noThink: true,
      });
      // surfaced as chat_template_kwargs for the request layer
      assert.deepEqual(on.chatTemplateKwargs, { enable_thinking: false });
      assert.equal(on.noThink, true);
      // and it must NEVER leak into vLLM launch flags / the shell line
      assert.ok(!on.argv.includes("--disable-thinking"));
      assert.ok(!on.shell.includes("enable_thinking"));
      assert.ok(!on.shell.includes("thinking"));
    });

    it("noThink off yields no chat override", () => {
      const off = servingConfig.translateConfigToFlags({
        model: "M",
        mtp: 0,
        fp8Kv: true,
        noThink: false,
      });
      assert.equal(off.chatTemplateKwargs, null);
      assert.equal(off.noThink, false);
    });

    it("prefix caching on/off maps to the explicit vLLM flag", () => {
      const on = servingConfig.translateConfigToFlags({
        model: "M", mtp: 0, fp8Kv: true, prefixCaching: true, chunkedPrefill: true,
      });
      assert.ok(on.argv.includes("--enable-prefix-caching"));
      assert.ok(!on.argv.includes("--no-enable-prefix-caching"));
      const off = servingConfig.translateConfigToFlags({
        model: "M", mtp: 0, fp8Kv: true, prefixCaching: false, chunkedPrefill: true,
      });
      assert.ok(off.argv.includes("--no-enable-prefix-caching"));
      assert.ok(!off.argv.includes("--enable-prefix-caching"));
    });

    it("chunked prefill on/off maps to the explicit vLLM flag", () => {
      const on = servingConfig.translateConfigToFlags({
        model: "M", mtp: 0, fp8Kv: true, prefixCaching: true, chunkedPrefill: true,
      });
      assert.ok(on.argv.includes("--enable-chunked-prefill"));
      assert.ok(!on.argv.includes("--no-enable-chunked-prefill"));
      const off = servingConfig.translateConfigToFlags({
        model: "M", mtp: 0, fp8Kv: true, prefixCaching: true, chunkedPrefill: false,
      });
      assert.ok(off.argv.includes("--no-enable-chunked-prefill"));
      assert.ok(!off.argv.includes("--enable-chunked-prefill"));
    });

    it("caching flags survive as single shell tokens (no spaces)", () => {
      const out = servingConfig.translateConfigToFlags({
        model: "M", mtp: 0, fp8Kv: true, prefixCaching: true, chunkedPrefill: false,
      });
      const tokens = out.shell.split(" ");
      assert.ok(tokens.includes("--enable-prefix-caching"));
      assert.ok(tokens.includes("--no-enable-chunked-prefill"));
    });
  });

  describe("persistence", () => {
    before(() => {
      try {
        fs.unlinkSync(servingPath);
      } catch {}
    });

    it("round-trips a per-Spark config through the JSON store", () => {
      servingConfig.saveServingConfig("spark-e", {
        model: "Qwen3.6-35B-A3B-NVFP4",
        mtp: 3,
        fp8Kv: true,
      });
      const saved = servingConfig.getServingConfig("spark-e");
      assert.equal(saved.model, "Qwen3.6-35B-A3B-NVFP4");
      assert.equal(saved.mtp, 3);
      assert.equal(saved.fp8Kv, true);
      assert.ok(fs.existsSync(servingPath));
    });

    it("sparks not yet saved get defaults", () => {
      const fresh = servingConfig.getServingConfig("spark-zzz");
      assert.deepEqual(fresh, {
        model: null,
        mtp: 0,
        fp8Kv: true,
        noThink: false,
        prefixCaching: true,
        chunkedPrefill: true,
      });
    });

    it("does not leak one Spark's config into another", () => {
      assert.equal(servingConfig.getServingConfig("spark-a").model, null);
    });
  });

  describe("A/B benchmark stub", () => {
    it("returns a stubbed no-op (never runs ctx_bench)", () => {
      const res = servingConfig.stubRunCtxBenchAB("spark-e", { model: "M", mtp: 1, fp8Kv: true });
      assert.equal(res.ok, false);
      assert.equal(res.stubbed, true);
      assert.equal(res.sparkId, "spark-e");
      assert.match(res.message, /stubbed/i);
    });
  });

  describe("live model switch is UNCALLED", () => {
    it("applyServingConfigToSpark exists but fails closed", () => {
      assert.equal(typeof servingConfig.applyServingConfigToSpark, "function");
      assert.throws(
        () => servingConfig.applyServingConfigToSpark("spark-e", { model: "M" }),
        /NOT WIRED/
      );
    });

    it("no route in server/index.js calls applyServingConfigToSpark", () => {
      const source = fs.readFileSync(serverIndexPath, "utf8");
      // A call would look like "applyServingConfigToSpark(" — must never appear
      // (the module only imports servingConfig as a namespace).
      assert.ok(
        !source.includes("applyServingConfigToSpark("),
        "server/index.js must NOT call the human-wiring live switch"
      );
      assert.ok(
        !source.includes("servingConfig.applyServingConfigToSpark("),
        "servingConfig.applyServingConfigToSpark must not be invoked in index.js"
      );
      assert.ok(
        !source.includes(".applyServingConfigToSpark("),
        "no call of applyServingConfigToSpark anywhere in index.js"
      );
    });
  });
});

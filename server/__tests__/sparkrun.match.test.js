import { test } from "node:test";
import { strict as assert } from "node:assert";
import { scoreRecipeMatch } from "../sparkrun.js";

test("short ollama tags do not match every recipe in the family", () => {
  const qwen = { name: "@eugr/qwen3.6-35b-a3b-fp8", model: "Qwen/Qwen3.6-35B-A3B-FP8" };
  assert.equal(scoreRecipeMatch("qwen3:8b", qwen, { isOllamaTag: true }), null);
  assert.equal(scoreRecipeMatch("qwen3.5:9b", qwen, { isOllamaTag: true }), null);
});

test("a real checkpoint name still matches its recipe", () => {
  const recipe = {
    name: "@eugr/deepseek-v4-flash-0731",
    model: "deepseek-ai/DeepSeek-V4-Flash-0731",
  };
  const score = scoreRecipeMatch("DeepSeek-V4-Flash-0731-hf", recipe);
  assert.ok(score != null && score >= 0.55);
});

test("exact normalized names score 1", () => {
  const recipe = { name: "laguna", model: "Laguna-S-2.1" };
  assert.equal(scoreRecipeMatch("Laguna-S-2.1", recipe), 1);
});

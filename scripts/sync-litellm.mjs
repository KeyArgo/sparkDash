#!/usr/bin/env node
/**
 * Sync sparkdeck's per-Spark entries into the fleet LiteLLM config, then reload
 * LiteLLM. Run this WHEN YOU WANT to update LiteLLM — it is deliberately an
 * explicit command, not an automatic web action, because it rewrites and
 * restarts your production LiteLLM.
 *
 * Merge-safe: only sparkdeck's own aliases (sparka…d) are replaced; every other
 * model_name in the config is preserved, and the config is backed up first.
 *
 * Usage:
 *   node scripts/sync-litellm.mjs           # sync + reload
 *   node scripts/sync-litellm.mjs --dry-run # print what WOULD change, no write
 *
 * Target host/config/service are configurable via LITELLM_HOST / LITELLM_CONFIG
 * / LITELLM_SERVICE env vars (defaults: sparkc, /etc/litellm/config.yaml, litellm).
 */
import { SparkRegistry } from "../server/sparks/SparkRegistry.js";
import { toLiteLLMEntries, managedAliases } from "../server/profiles.js";
import { syncLiteLLM, litellmTarget } from "../server/litellm.js";

const registry = new SparkRegistry();
const entries = toLiteLLMEntries(registry.sparks, {});
const managed = managedAliases(registry.sparks);

console.log(`LiteLLM target: ${litellmTarget.host}:${litellmTarget.config} (service ${litellmTarget.service})`);
console.log("Will sync aliases:", entries.map((e) => e.model_name).join(", ") || "(none)");

if (process.argv.includes("--dry-run")) {
  console.log("\n--- entries that would be written ---");
  console.log(JSON.stringify(entries, null, 2));
  console.log("\n(dry run — nothing changed)");
  process.exit(0);
}

if (!entries.length) {
  console.error("No Spark has a known vLLM port — nothing to sync.");
  process.exit(1);
}

try {
  const result = await syncLiteLLM(entries, managed);
  console.log("\nSync result:", JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  console.error("Sync failed:", err.message);
  process.exit(1);
}

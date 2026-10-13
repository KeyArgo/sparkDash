/**
 * Tessera plugin registry — the plugin system for sparkdeck.
 *
 * A plugin is a module in server/plugins/<name>.js that exports a manifest:
 *
 *   {
 *     id: "tessera",
 *     name: "Tessera Console",
 *     version: "1.0.0",
 *     description: "...",
 *     mount(app) { ... },        // register Express routes (optional)
 *     contribute(admin) { ... }  // sync extra WS snapshot data keyed by id (optional)
 *   }
 *
 * The manifest may be the default export, or exported as `plugin` /
 * `<id>Plugin`. The registry auto-discovers every `.js` file here at load
 * (excluding index.js and test files), mounts each plugin's routes, and makes
 * the plugin list available at GET /api/plugins.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {Map<string, object>} */
const plugins = new Map();

/**
 * Import one plugin module and normalize its manifest.
 * @param {string} file
 * @returns {Promise<object | null>}
 */
async function loadPlugin(file) {
  try {
    const mod = await import(`./${file}`);
    const manifest =
      (mod.default && typeof mod.default === "object" && mod.default.id
        ? mod.default
        : null) ||
      (mod.plugin && typeof mod.plugin === "object" && mod.plugin.id
        ? mod.plugin
        : null);
    if (!manifest || typeof manifest.mount !== "function") {
      console.warn(`[plugins] skip ${file}: no valid manifest (needs id + mount)`);
      return null;
    }
    return { ...manifest };
  } catch (err) {
    console.warn(`[plugins] failed to load ${file}:`, err?.message || err);
    return null;
  }
}

/**
 * Discover and mount all plugins onto an Express app.
 * Idempotent per plugin id (first registration wins).
 * @param {import("express").Express} app
 * @returns {Promise<Array<{ id: string, name: string, version: string, description?: string }>>}
 */
export async function loadPlugins(app) {
  const files = fs
    .readdirSync(__dirname)
    .filter(
      (f) =>
        f.endsWith(".js") &&
        f !== "index.js" &&
        !f.startsWith("_") &&
        !f.endsWith(".test.js")
    );

  for (const file of files) {
    const plugin = await loadPlugin(file);
    if (!plugin) continue;
    if (plugins.has(plugin.id)) {
      console.warn(`[plugins] duplicate id "${plugin.id}" (${file}) — skipping`);
      continue;
    }
    plugins.set(plugin.id, plugin);
    try {
      plugin.mount(app);
    } catch (err) {
      console.warn(`[plugins] "${plugin.id}" mount failed:`, err?.message || err);
    }
    console.log(`[plugins] loaded "${plugin.id}" v${plugin.version}`);
  }

  return listPlugins();
}

/**
 * Public metadata for the GET /api/plugins endpoint.
 * @returns {Array<{ id: string, name: string, version: string, description?: string }>}
 */
export function listPlugins() {
  return [...plugins.values()].map(({ id, name, version, description }) => ({
    id,
    name,
    version,
    description,
  }));
}

/** @param {string} id */
export function getPlugin(id) {
  return plugins.get(id) || null;
}

/**
 * Collect each plugin's contribute() output into { [pluginId]: data }.
 * Sync-only so it can run on every snapshot broadcast. A plugin's contribution
 * can never break the broadcast — failures are swallowed.
 * @param {boolean} admin
 * @returns {Record<string, unknown> | null}
 */
export function collectPluginSnapshot(admin) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const plugin of plugins.values()) {
    if (typeof plugin.contribute !== "function") continue;
    try {
      const data = plugin.contribute(admin);
      if (data != null) out[plugin.id] = data;
    } catch {
      /* non-fatal */
    }
  }
  return Object.keys(out).length ? out : null;
}

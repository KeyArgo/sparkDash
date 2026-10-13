import type { PluginManifest } from "./types";

/**
 * Frontend plugin registry — the Tessera plugin system (client side).
 * Plugins register themselves once at import time (see plugins/index.ts),
 * then UI slots (Settings dialog, later: sidebar / routes) render whatever
 * plugins provide.
 */

const registry = new Map<string, PluginManifest>();

export function registerPlugin(plugin: PluginManifest): void {
  if (!plugin || typeof plugin.id !== "string" || !plugin.id) {
    throw new Error("[plugins] registerPlugin requires a manifest with an id");
  }
  if (registry.has(plugin.id)) {
    console.warn(`[plugins] duplicate registration "${plugin.id}" — ignoring`);
    return;
  }
  registry.set(plugin.id, plugin);
}

/** All registered plugins, in registration order. */
export function getPlugins(): PluginManifest[] {
  return [...registry.values()];
}

export function getPlugin(id: string): PluginManifest | undefined {
  return registry.get(id);
}

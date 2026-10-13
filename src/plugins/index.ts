/**
 * Tessera plugin system — frontend entry.
 * Importing this module registers all built-in plugins.
 */
import "./tessera";

export { registerPlugin, getPlugins, getPlugin } from "./registry";
export type { PluginManifest, PluginSettingsContext, PluginInfo } from "./types";

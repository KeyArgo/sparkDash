import type { ComponentType } from "react";
import type { Settings } from "../api/types";

/**
 * Context passed to plugin UI components (settings panels today; sidebar /
 * page slots later).
 */
export interface PluginSettingsContext {
  /** Current live settings draft (plugin-owned fields only). */
  settings: Settings | null;
  /** Merge a partial settings patch into the draft. */
  updateSettings: (patch: Partial<Settings>) => void;
}

/**
 * Frontend plugin manifest. Register via registerPlugin().
 */
export interface PluginManifest {
  /** Stable id (must match the backend plugin id where applicable). */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Rendered in the Settings dialog's Plugins section. */
  SettingsPanel?: ComponentType<PluginSettingsContext>;
}

/** GET /api/plugins response row. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
}

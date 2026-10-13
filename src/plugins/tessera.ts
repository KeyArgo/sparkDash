import { registerPlugin } from "./registry";
import { TesseraPlugin } from "../components/plugins/TesseraPlugin";
import type { PluginManifest } from "./types";

/**
 * Built-in Tessera plugin. Registers its settings panel so the Settings dialog
 * renders it via the plugin slot.
 */
const tesseraPlugin: PluginManifest = {
  id: "tessera",
  name: "Tessera Console",
  version: "1.0.0",
  description:
    "Health checks and console integration for the Tessera dashboard.",
  SettingsPanel: TesseraPlugin,
};

registerPlugin(tesseraPlugin);

import { useState, useEffect, useCallback } from "react";
import { Panel } from "../ui/Panel";
import { GearIcon } from "../ui/icons";
import {
  fetchServingConfig,
  saveServingConfig,
  runAbBenchmark,
  fetchInventory,
  type ServingConfig,
  type ServingConfigMtp,
  type TranslatedServingConfig,
} from "../../api/client";

interface ServingConfigPanelProps {
  sparkId: string;
  locked: boolean;
}

const MTP_OPTIONS: Array<{ label: string; value: ServingConfigMtp }> = [
  { label: "Off", value: 0 },
  { label: "1", value: 1 },
  { label: "3", value: 3 },
];

export function ServingConfigPanel({ sparkId, locked }: ServingConfigPanelProps) {
  const [config, setConfig] = useState<ServingConfig | null>(null);
  const [translated, setTranslated] = useState<TranslatedServingConfig | null>(null);
  const [modelDirs, setModelDirs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [benchMsg, setBenchMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchServingConfig(sparkId)
      .then((res) => {
        if (cancelled) return;
        setConfig(res.config);
        setTranslated(res.translated);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    fetchInventory(sparkId)
      .then((inv) => {
        if (!cancelled) setModelDirs((inv.modelDirs || []).map((d) => d.name));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sparkId]);

  const update = (patch: Partial<ServingConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
    setError(null);
  };

  const handleSave = async () => {
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      const res = await saveServingConfig(sparkId, config);
      setConfig(res.config);
      setTranslated(res.translated);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleAbBench = async () => {
    setBusy(true);
    setError(null);
    setBenchMsg(null);
    try {
      const res = await runAbBenchmark(sparkId);
      setBenchMsg(res.stubbed ? res.message : "Benchmark finished");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Serving config"
      icon={<GearIcon />}
      className="panel-serving-config"
      bodyClassName="space-y-3"
    >
      {locked && (
        <p className="text-[10px] italic text-muted">
          Admin lock — serving config controls disabled
        </p>
      )}

      {error && (
        <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {benchMsg && (
        <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
          {benchMsg}
        </div>
      )}

      {config && (
        <div className="space-y-3">
          {/* Model select */}
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-muted">Model</div>
            <select
              value={config.model ?? ""}
              onChange={(e) => update({ model: e.target.value || null })}
              disabled={locked}
              className="w-full rounded border border-border bg-surface-elevated px-2 py-1 text-xs text-text outline-none focus:border-accent disabled:opacity-50"
            >
              <option value="">(none selected)</option>
              {modelDirs.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          {/* MTP depth */}
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-muted">MTP (speculative tokens)</div>
            <div className="flex gap-1.5">
              {MTP_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={locked}
                  onClick={() => update({ mtp: opt.value })}
                  className={`rounded px-2.5 py-1 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                    config.mtp === opt.value
                      ? "bg-accent text-white"
                      : "border border-border bg-surface-elevated text-muted hover:bg-surface-hover"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* fp8-KV cache */}
          <label className="flex items-center gap-3 text-xs text-muted">
            <button
              type="button"
              role="switch"
              aria-checked={config.fp8Kv}
              disabled={locked}
              onClick={() => update({ fp8Kv: !config.fp8Kv })}
              className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${
                config.fp8Kv ? "is-on" : ""
              }`}
            >
              <span
                className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                  config.fp8Kv ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
            fp8 KV cache
          </label>

          {/* No thinking (request-time: enable_thinking=false) */}
          <label className="flex items-center gap-3 text-xs text-muted">
            <button
              type="button"
              role="switch"
              aria-checked={config.noThink}
              disabled={locked}
              onClick={() => update({ noThink: !config.noThink })}
              className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${
                config.noThink ? "is-on" : ""
              }`}
            >
              <span
                className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                  config.noThink ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
            <span>
              Stop thinking
              <span className="block text-[9px] not-italic text-muted/70">
                suppress &lt;think&gt; — faster, restores MTP (request-time)
              </span>
            </span>
          </label>

          {/* Prefix caching (long-conversation lever) */}
          <label className="flex items-center gap-3 text-xs text-muted">
            <button
              type="button"
              role="switch"
              aria-checked={config.prefixCaching}
              disabled={locked}
              onClick={() => update({ prefixCaching: !config.prefixCaching })}
              className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${
                config.prefixCaching ? "is-on" : ""
              }`}
            >
              <span
                className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                  config.prefixCaching ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
            <span>
              Prefix caching
              <span className="block text-[9px] not-italic text-muted/70">
                reuse cached system prompt / repo map / history — cuts long-chat TTFT
              </span>
            </span>
          </label>

          {/* Chunked prefill (long-context TTFT lever) */}
          <label className="flex items-center gap-3 text-xs text-muted">
            <button
              type="button"
              role="switch"
              aria-checked={config.chunkedPrefill}
              disabled={locked}
              onClick={() => update({ chunkedPrefill: !config.chunkedPrefill })}
              className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${
                config.chunkedPrefill ? "is-on" : ""
              }`}
            >
              <span
                className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                  config.chunkedPrefill ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
            <span>
              Chunked prefill
              <span className="block text-[9px] not-italic text-muted/70">
                chunk long prompts so a big context doesn&apos;t stall small requests
              </span>
            </span>
          </label>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={locked || busy || !dirty}
              onClick={() => void handleSave()}
              className="rounded bg-accent px-2.5 py-1 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "Saving…" : dirty ? "Save switches" : "Saved"}
            </button>
            <button
              type="button"
              disabled={locked || busy}
              onClick={() => void handleAbBench()}
              className="rounded border border-border px-2.5 py-1 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-50"
            >
              A/B benchmark (stub)
            </button>
          </div>

          {/* Translated flags preview */}
          {translated && (
            <div className="space-y-1 rounded-md border border-border bg-surface-elevated p-2">
              <div className="text-[10px] uppercase tracking-wide text-muted">
                Translated vLLM flags
              </div>
              <pre className="whitespace-pre-wrap break-all font-tabular text-[10px] leading-snug text-text">
                {translated.shell || "(no flags — select a model)"}
              </pre>
              {translated.mtpJson && (
                <p className="text-[9px] text-muted">
                  MTP value is a single token (no spaces) so shell arg parsing is safe.
                </p>
              )}
              {translated.chatTemplateKwargs && (
                <p className="text-[9px] text-muted">
                  + request-time override:{" "}
                  <code className="font-tabular">
                    chat_template_kwargs={JSON.stringify(translated.chatTemplateKwargs)}
                  </code>{" "}
                  (sent per chat request, not a launch flag)
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

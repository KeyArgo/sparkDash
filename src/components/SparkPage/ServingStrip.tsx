import { useState } from "react";
import type { LlmMetrics } from "../../api/types";
import { killPort, ollamaStop } from "../../api/client";

function label(backend: string | null | undefined): string {
  if (backend === "vllm") return "vLLM";
  if (backend === "sglang") return "sgLang";
  if (backend === "llama.cpp") return "llama.cpp";
  if (backend === "exl3") return "EXL3";
  if (backend === "ollama") return "Ollama";
  if (backend === "ds4") return "ds4";
  if (backend === "q27") return "q27";
  return backend || "idle";
}

/**
 * Always-visible row of whatever is actually resident on each LLM port,
 * with live tok/s and an unload that matches the engine.
 */
export function ServingStrip({
  sparkId,
  ports,
  llms,
  locked = false,
}: {
  sparkId: string;
  ports: number[];
  llms: Array<LlmMetrics | null | undefined>;
  locked?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function unload(port: number, llm: LlmMetrics | null | undefined) {
    setErr(null);
    setBusy(String(port));
    try {
      if (llm?.backend === "ollama" && llm.modelId) {
        for (const model of llm.modelId.split(",").map((s) => s.trim()).filter(Boolean)) {
          await ollamaStop(sparkId, model);
        }
      } else {
        await killPort(sparkId, port);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const rows = ports.map((port, i) => ({ port, llm: llms[i] ?? null }));
  const any = rows.some((r) => r.llm?.modelId);

  return (
    <div className="md:col-span-2 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-text">Loaded now</span>
        {!any && <span className="text-[11px] text-muted">nothing resident</span>}
      </div>
      <div className="flex flex-col gap-1">
        {(rows.some((row) => row.llm?.modelId) ? rows.filter((row) => row.llm?.modelId) : rows).map(({ port, llm }) => {
          const model = llm?.modelId;
          const gen = llm?.generationTps ?? 0;
          const pre = llm?.prefillTps ?? 0;
          const worker = Boolean(llm?.headless);
          return (
            <div key={port} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="font-tabular text-muted">{worker ? "worker" : `:${port}`}</span>
              <span className="text-text">{label(llm?.backend)}</span>
              <span className="min-w-0 flex-1 truncate text-text-strong" title={model || ""}>
                {model || "nothing loaded"}
              </span>
              {worker ? (
                <span className="text-muted">tok/s on the head Spark</span>
              ) : (
                <>
                  <span className="font-tabular text-accent" title="Generation tok/s">
                    {gen.toFixed(1)} tok/s
                  </span>
                  <span className="font-tabular text-muted" title="Prefill tok/s">
                    {pre.toFixed(1)} prefill
                  </span>
                </>
              )}
              {model && !locked && !worker && (
                <button
                  type="button"
                  disabled={busy === String(port)}
                  onClick={() => void unload(port, llm)}
                  className="rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-surface-hover disabled:opacity-50"
                >
                  {busy === String(port) ? "…" : "Unload"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {err && <p className="mt-1 text-[11px] text-danger">{err}</p>}
    </div>
  );
}

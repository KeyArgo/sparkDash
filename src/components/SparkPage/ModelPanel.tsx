import { useState, useEffect, useCallback } from "react";
import { Panel } from "../ui/Panel";
import { BotIcon } from "../ui/icons";
import {
  fetchInventory,
  fetchControlStatus,
  switchModel,
  killPort,
  warmModel,
  restartVllm,
  pullModel,
  restartOllama,
  importGguf,
  copyModel,
  sparkrunRun,
  fetchSparks,
  type InventoryResponse,
  type ControlStatusResponse,
  type SparkrunRecipe,
} from "../../api/client";
import type { SparkConfig } from "../../api/types";

interface ModelPanelProps {
  sparkId: string;
  locked: boolean;
  vllmPort?: number;
}

function ollamaHref(tag: string): string {
  if (tag.startsWith("hf.co/")) {
    return "https://huggingface.co/" + tag.slice(6).split(":")[0];
  }
  return "https://ollama.com/library/" + tag.split(":")[0];
}

/** Link for a local vLLM checkpoint dir (e.g. "Qwen3.6-35B-A3B-heretic-NVFP4"):
 * best-effort HuggingFace search — checkpoint dirs are local copies of HF
 * models, so search by the bare name. If it looks like an org/repo path,
 * link straight to that model page. */
function dirHref(name: string): string {
  const bare = name.replace(/^\/+|\/+$/g, "").split("/").pop() || name;
  return `https://huggingface.co/models?search=${encodeURIComponent(bare)}`;
}

/** Extract model name from modelPath (e.g., "/home/argo/models/Qwen3.6-35B" → "Qwen3.6-35B") */
function extractModelName(modelPath: string | null | undefined): string {
  if (!modelPath) return "Unknown";
  // Remove trailing slashes, get last path component
  const normalized = modelPath.replace(/\/+$/, "");
  const name = normalized.split("/").pop() || "Unknown";
  return name;
}

/** Best-match sparkrun recipe indicator. Single-node recipes get a one-click
 * launch (sparkrun runs its own tuned container, distinct from this
 * dashboard's hand-rolled vllmLaunchCmd path); multi-node recipes are
 * informational only for now — launching those needs picking a second
 * Spark, which this panel (one Spark per view) has no natural place for yet. */
function SparkrunBadge({
  recipes,
  locked,
  busy,
  onLaunch,
}: {
  recipes: SparkrunRecipe[] | undefined;
  locked: boolean;
  busy: boolean;
  onLaunch: (recipe: SparkrunRecipe) => void;
}) {
  if (!recipes || recipes.length === 0) return null;
  const best = recipes[0];
  const shortName = best.name.split("/").pop() ?? best.name;
  if ((best.min_nodes ?? 1) > 1) {
    return (
      <span
        title={`${best.name} — needs ${best.min_nodes} nodes, not launchable from a single-Spark panel`}
        className="rounded border border-border px-1.5 py-0.5 text-[9px] text-muted"
      >
        recipe: {shortName} ({best.min_nodes}n)
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`Launch via sparkrun recipe ${best.name} (tuned image + flags, separate from this panel's own launcher)`}
      disabled={locked || busy}
      onClick={() => onLaunch(best)}
      className="rounded border border-accent/50 px-1.5 py-0.5 text-[9px] text-accent hover:bg-accent/10 disabled:opacity-50"
    >
      {busy ? "Launching…" : `⚡ ${shortName}`}
    </button>
  );
}

export function ModelPanel({ sparkId, locked, vllmPort }: ModelPanelProps) {
  const [inventory, setInventory] = useState<InventoryResponse | null>(null);
  const [controlStatus, setControlStatus] = useState<ControlStatusResponse | null>(null);
  const [pullTag, setPullTag] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [sparks, setSparks] = useState<SparkConfig[]>([]);
  const [ggufCollapsed, setGgufCollapsed] = useState(true);
  const [selectedGguf, setSelectedGguf] = useState("");
  const [ggufModelName, setGgufModelName] = useState("");
  const [copyDst, setCopyDst] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchSparks()
      .then((res) => setSparks(res.sparks ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const fetch = () => {
      fetchInventory(sparkId).then(setInventory).catch(() => {});
    };
    fetch();
    const t = setInterval(fetch, 10_000);
    return () => clearInterval(t);
  }, [sparkId]);

  useEffect(() => {
    const fetch = () => {
      fetchControlStatus().then(setControlStatus).catch(() => {});
    };
    fetch();
    const t = setInterval(fetch, 3_000);
    return () => clearInterval(t);
  }, []);

  const exec = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy((b) => ({ ...b, [key]: true }));
      try {
        await fn();
      } catch (err) {
        console.error(err);
      } finally {
        setBusy((b) => ({ ...b, [key]: false }));
      }
    },
    []
  );

  const pending = controlStatus?.pending?.[sparkId];
  const otherSparks = sparks.filter((s) => s.id !== sparkId);

  return (
    <Panel
      title="Models"
      icon={<BotIcon />}
      className="panel-models"
      bodyClassName="space-y-3"
    >
      {locked && (
        <p className="text-[10px] italic text-muted">
          Admin lock — model controls disabled
        </p>
      )}

      {pending && (
        <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
          <div className="flex items-center justify-between">
            <span>{pending.msg}</span>
            {pending.pct != null && <span className="font-tabular">{pending.pct}%</span>}
          </div>
          {pending.pct != null && pending.pct > 0 && (
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-warning/20">
              <div
                className="h-full rounded-full bg-warning transition-all"
                style={{ width: `${pending.pct}%` }}
              />
            </div>
          )}
        </div>
      )}

      {inventory?.vllmProcs && inventory.vllmProcs.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted">
            Running vLLM
          </div>
          {inventory.vllmProcs.map((proc) => {
            const displayName = extractModelName(proc.modelPath);
            const isAlias = proc.servedName && proc.servedName !== displayName;
            return (
            <div
              key={proc.port}
              className="flex items-center justify-between rounded-md border border-border bg-surface-elevated px-3 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <a
                  href={dirHref(displayName)}
                  target="_blank"
                  rel="noreferrer"
                  title="Search this model on HuggingFace"
                  className="block truncate text-xs text-text font-medium underline decoration-dotted decoration-text/40 underline-offset-2 hover:text-accent"
                >
                  {displayName}
                </a>
                <div className="text-[10px] text-muted">
                  {isAlias ? `${proc.servedName} · ` : ""} :{proc.port}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={locked || busy[`restart-${proc.port}`]}
                  onClick={() =>
                    exec(`restart-${proc.port}`, () =>
                      restartVllm(sparkId, proc.port)
                    )
                  }
                  className="rounded border border-border px-2 py-0.5 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-50"
                >
                  Restart
                </button>
                <button
                  type="button"
                  disabled={locked || busy[`kill-${proc.port}`]}
                  onClick={() =>
                    exec(`kill-${proc.port}`, () =>
                      killPort(sparkId, proc.port)
                    )
                  }
                  className="rounded border border-border px-2 py-0.5 text-[10px] text-danger hover:bg-danger/10 disabled:opacity-50"
                >
                  Stop
                </button>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {inventory?.modelDirs && inventory.modelDirs.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted">
            Checkpoints
          </div>
          {inventory.modelDirs.map((dir) => (
            <div
              key={dir.name}
              className="flex items-center justify-between rounded-md border border-border bg-surface-elevated px-3 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <a
                  href={dirHref(dir.name)}
                  target="_blank"
                  rel="noreferrer"
                  title="Search this checkpoint on HuggingFace"
                  className="block truncate text-xs text-text underline decoration-dotted decoration-text/40 underline-offset-2 hover:text-accent"
                >
                  {dir.name}
                </a>
                <div className="text-[10px] text-muted">
                  {dir.arch}
                  {dir.complete ? "" : ` · ${dir.shards} shards`}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {otherSparks.length > 0 && (
                  <>
                    <select
                      value={copyDst[dir.name] ?? ""}
                      onChange={(e) =>
                        setCopyDst((d) => ({ ...d, [dir.name]: e.target.value }))
                      }
                      disabled={locked}
                      className="max-w-[80px] rounded border border-border bg-surface-elevated px-1 py-0.5 text-[10px] text-text outline-none disabled:opacity-50"
                    >
                      <option value="">Copy to…</option>
                      {otherSparks.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={locked || !copyDst[dir.name] || busy[`copy-${dir.name}`]}
                      onClick={() =>
                        exec(`copy-${dir.name}`, () =>
                          copyModel(sparkId, {
                            dst: copyDst[dir.name],
                            kind: "vllm",
                            name: dir.name,
                          })
                        )
                      }
                      className="rounded border border-border px-2 py-0.5 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-50"
                    >
                      Copy
                    </button>
                  </>
                )}
                <SparkrunBadge
                  recipes={inventory.sparkrunMatchesByDir?.[dir.name]}
                  locked={locked}
                  busy={!!busy[`sparkrun-${dir.name}`]}
                  onLaunch={(recipe) =>
                    exec(`sparkrun-${dir.name}`, () =>
                      sparkrunRun(sparkId, {
                        recipeName: recipe.name,
                        port: inventory.vllmProcs?.[0]?.port ?? vllmPort ?? 8000,
                        servedName: undefined,
                      })
                    )
                  }
                />
                <button
                  type="button"
                  disabled={locked || busy[`load-${dir.name}`]}
                  onClick={() =>
                    exec(`load-${dir.name}`, () =>
                      switchModel(sparkId, {
                        modelDir: dir.name,
                        port: inventory.vllmProcs?.[0]?.port ?? vllmPort ?? 8000,
                        arch: dir.arch || undefined,
                      })
                    )
                  }
                  className="rounded bg-accent px-2 py-0.5 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                >
                  {busy[`load-${dir.name}`] ? "Loading…" : "Load"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {inventory?.ollamaTags && inventory.ollamaTags.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wide text-muted">
              Ollama models
            </div>
            <button
              type="button"
              disabled={locked || busy["restart-ollama"]}
              onClick={() =>
                exec("restart-ollama", () => restartOllama(sparkId))
              }
              className="rounded border border-border px-2 py-0.5 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-50"
            >
              Restart Ollama
            </button>
          </div>
          {inventory.ollamaTags.map((tag) => (
            <div
              key={tag}
              className="flex items-center justify-between rounded-md border border-border bg-surface-elevated px-3 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <a
                  href={ollamaHref(tag)}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-xs text-text underline-offset-2 hover:underline"
                >
                  {tag}
                </a>
              </div>
              <div className="flex items-center gap-1">
                {otherSparks.length > 0 && (
                  <>
                    <select
                      value={copyDst[tag] ?? ""}
                      onChange={(e) =>
                        setCopyDst((d) => ({ ...d, [tag]: e.target.value }))
                      }
                      disabled={locked}
                      className="max-w-[80px] rounded border border-border bg-surface-elevated px-1 py-0.5 text-[10px] text-text outline-none disabled:opacity-50"
                    >
                      <option value="">Copy to…</option>
                      {otherSparks.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={locked || !copyDst[tag] || busy[`copy-${tag}`]}
                      onClick={() =>
                        exec(`copy-${tag}`, () =>
                          copyModel(sparkId, {
                            dst: copyDst[tag],
                            kind: "ollama",
                            name: tag,
                          })
                        )
                      }
                      className="rounded border border-border px-2 py-0.5 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-50"
                    >
                      Copy
                    </button>
                  </>
                )}
                <SparkrunBadge
                  recipes={inventory.sparkrunMatchesByTag?.[tag]}
                  locked={locked}
                  busy={!!busy[`sparkrun-tag-${tag}`]}
                  onLaunch={(recipe) =>
                    exec(`sparkrun-tag-${tag}`, () =>
                      sparkrunRun(sparkId, { recipeName: recipe.name })
                    )
                  }
                />
                <button
                  type="button"
                  disabled={locked || busy[`warm-${tag}`]}
                  onClick={() =>
                    exec(`warm-${tag}`, () => warmModel(sparkId, tag))
                  }
                  className="rounded border border-border px-2 py-0.5 text-[10px] text-text hover:bg-surface-hover disabled:opacity-50"
                >
                  Warm
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {inventory?.ggufFiles && inventory.ggufFiles.length > 0 && (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setGgufCollapsed((c) => !c)}
            disabled={locked}
            className="flex w-full items-center justify-between text-[10px] uppercase tracking-wide text-muted disabled:opacity-50"
          >
            <span>GGUF import</span>
            <span>{ggufCollapsed ? "\u25B8" : "\u25BE"}</span>
          </button>
          {!ggufCollapsed && (
            <div className="space-y-2 rounded-md border border-border bg-surface-elevated p-2">
              <select
                value={selectedGguf}
                onChange={(e) => setSelectedGguf(e.target.value)}
                disabled={locked}
                className="w-full rounded border border-border bg-surface-elevated px-2 py-1 text-xs text-text outline-none focus:border-accent disabled:opacity-50"
              >
                <option value="">Select a GGUF file…</option>
                {inventory.ggufFiles.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Model name"
                value={ggufModelName}
                onChange={(e) => setGgufModelName(e.target.value)}
                disabled={locked}
                className="w-full rounded border border-border bg-surface-elevated px-2 py-1 text-xs text-text outline-none focus:border-accent disabled:opacity-50"
              />
              <button
                type="button"
                disabled={
                  locked || !selectedGguf || !ggufModelName.trim() || busy["gguf-import"]
                }
                onClick={() =>
                  exec("gguf-import", () =>
                    importGguf(sparkId, selectedGguf, ggufModelName.trim())
                  ).then(() => {
                    setSelectedGguf("");
                    setGgufModelName("");
                  })
                }
                className="w-full rounded bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {busy["gguf-import"] ? "Importing\u2026" : "Import"}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-wide text-muted">
          Pull model
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="ollama tag"
            value={pullTag}
            onChange={(e) => setPullTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && pullTag.trim() && !locked) {
                exec(pullTag.trim(), () =>
                  pullModel(sparkId, pullTag.trim())
                ).then(() => setPullTag(""));
              }
            }}
            disabled={locked}
            className="min-w-0 flex-1 rounded-md border border-border bg-surface-elevated px-2 py-1 font-tabular text-xs text-text outline-none focus:border-accent disabled:opacity-50"
          />
          <button
            type="button"
            disabled={locked || !pullTag.trim() || busy["pull"]}
            onClick={() => {
              exec(pullTag.trim(), () =>
                pullModel(sparkId, pullTag.trim())
              ).then(() => setPullTag(""));
            }}
            className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            Pull
          </button>
        </div>
      </div>

      {controlStatus?.activity && controlStatus.activity.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted">
            Activity
          </div>
          <div className="max-h-24 space-y-0.5 overflow-y-auto">
            {controlStatus.activity
              .slice(0, 10)
              .map((a, i) => (
                <div
                  key={i}
                  className="text-[10px] leading-snug text-muted"
                >
                  <span className="font-tabular">
                    {new Date(a.ts).toLocaleTimeString()}
                  </span>{" "}
                  {a.msg}
                </div>
              ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

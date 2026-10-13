import { useState, useEffect, useCallback, type FormEvent } from "react";
import {
  fetchRecipes,
  importRecipe,
  loadRecipe,
  unloadRecipe,
  fetchRecipeLog,
  type SparkrunRecipe,
} from "../../api/client";

const SOURCES = [
  { id: "all", label: "All" },
  { id: "sparkrun", label: "sparkrun" },
  { id: "mia", label: "Mia" },
  { id: "git", label: "Saved links" },
] as const;

function sourceOf(r: SparkrunRecipe): string {
  if (r.source) return r.source;
  if (r.localPath) return "custom";
  return "sparkrun";
}

/**
 * One catalog for sparkrun, Mia's GitHub recipes, and a pasted URL.
 * Load and unload both go through the dashboard — they do not start a model
 * until the button is pressed.
 */
export function SparkRunPanel({ sparkId, locked = false }: { sparkId: string; locked?: boolean }) {
  const [recipes, setRecipes] = useState<SparkrunRecipe[]>([]);
  const [miaError, setMiaError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [source, setSource] = useState<(typeof SOURCES)[number]["id"]>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const [url, setUrl] = useState("");

  const refresh = useCallback(() => {
    setLoading(true);
    fetchRecipes()
      .then((d) => {
        setRecipes(d.recipes || []);
        setMiaError(d.miaError || null);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(refresh, [refresh]);

  const shown = recipes.filter((r) => {
    const src = sourceOf(r);
    if (source === "sparkrun" && src !== "sparkrun" && src !== "custom" && src !== "yaml") return false;
    if (source === "mia" && src !== "mia") return false;
    if (source === "git" && src !== "git") return false;
    if (!q) return true;
    const hay = `${r.name || ""} ${r.model || ""} ${r.runtime || ""} ${r.url || ""}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  async function act(kind: "load" | "unload", r: SparkrunRecipe) {
    const key = r.url || r.localPath || r.name;
    setBusy(`${kind}:${key}`);
    setErr(null);
    const body = {
      source: sourceOf(r),
      name: r.name,
      url: r.url,
      localPath: r.localPath,
    };
    try {
      if (kind === "load") await loadRecipe(sparkId, body);
      else await unloadRecipe(sparkId, body);
      await new Promise((wait) => setTimeout(wait, 1200));
      const l = await fetchRecipeLog(sparkId, { source: body.source, name: r.localPath || r.name, url: r.url });
      setLog(l.log || (kind === "load" ? "load started — log empty yet" : "unload requested"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onImport(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    const pasted = url.trim();
    if (!pasted) return;
    try {
      await importRecipe(pasted);
      setUrl("");
      refresh();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <strong className="text-sm text-text">Recipes</strong>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter"
          className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-xs text-text"
        />
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded border border-border px-2 py-1 text-[11px] text-muted hover:bg-surface-hover disabled:opacity-50"
        >
          refresh
        </button>
      </div>
      <div className="mb-2 flex flex-wrap gap-1">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSource(s.id)}
            className={`rounded px-2 py-0.5 text-[11px] ${
              source === s.id ? "bg-accent text-white" : "border border-border text-muted hover:bg-surface-hover"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <form onSubmit={onImport} className="mb-2 flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="GitHub repo, raw recipe YAML, or sparkrun name"
          className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-xs text-text"
        />
        <button
          type="submit"
          disabled={locked || !url.trim()}
          className="rounded border border-border px-2 py-1 text-[11px] text-text hover:bg-surface-hover disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {miaError && source !== "sparkrun" && (
        <p className="mb-1 text-[11px] text-muted">Mia catalog: {miaError}</p>
      )}
      {err && <p className="mb-1 text-[11px] text-danger">{err}</p>}
      <div className="max-h-80 overflow-y-auto">
        {loading && <p className="text-xs text-muted">loading…</p>}
        {!loading && shown.length === 0 && <p className="text-xs text-muted">no recipes</p>}
        {shown.map((r, i) => {
          const key = r.url || r.localPath || r.name || `r${i}`;
          const src = sourceOf(r);
          return (
            <div key={key} className="flex items-center gap-2 border-b border-border/60 py-1">
              <button
                type="button"
                disabled={locked || busy === `load:${key}`}
                onClick={() => void act("load", r)}
                className="w-14 shrink-0 rounded bg-accent px-2 py-0.5 text-[11px] text-white disabled:opacity-50"
              >
                {busy === `load:${key}` ? "…" : "Load"}
              </button>
              <button
                type="button"
                disabled={locked || busy === `unload:${key}`}
                onClick={() => void act("unload", r)}
                className="w-16 shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-muted disabled:opacity-50"
              >
                {busy === `unload:${key}` ? "…" : "Unload"}
              </button>
              <span className="min-w-0 flex-1 truncate text-xs text-text" title={r.url || r.model || r.name}>
                {r.name}
              </span>
              <span className="shrink-0 text-[10px] text-muted">
                {src}
                {r.runtime ? ` · ${r.runtime}` : ""}
                {r.min_nodes && r.min_nodes > 1 ? ` · ${r.min_nodes} nodes` : ""}
              </span>
            </div>
          );
        })}
      </div>
      {log && (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-border bg-black/20 p-2 text-[10px] text-muted">
          {log}
        </pre>
      )}
    </div>
  );
}

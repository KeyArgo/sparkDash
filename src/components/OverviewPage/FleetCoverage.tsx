import { useState } from "react";
import { fetchFleetCoverage, type FleetCoverage } from "../../api/client";
import { Panel } from "../ui/Panel";
import { RotateIcon } from "../ui/icons";

export function FleetCoverage() {
  const [data, setData] = useState<FleetCoverage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const result = await fetchFleetCoverage();
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setLoading(false);
    }
  }

  const sortedModels = data
    ? [...data.models].sort((a, b) => {
        const aMissing = a.missing.length > 0 ? 0 : 1;
        const bMissing = b.missing.length > 0 ? 0 : 1;
        return aMissing - bMissing;
      })
    : [];

  const fullyReplicated = data
    ? data.models.filter((m) => m.missing.length === 0).length
    : 0;

  return (
    <Panel
      title="Fleet Coverage"
      icon={<RotateIcon className="h-3.5 w-3.5" />}
      actions={
        <button
          type="button"
          onClick={scan}
          disabled={loading}
          className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted hover:text-accent transition-colors disabled:opacity-50"
        >
          {loading ? "Scanning…" : "Scan fleet"}
        </button>
      }
    >
      {error && <p className="text-[11px] text-danger">{error}</p>}
      {loading && !data && (
        <p className="text-[11px] text-muted">Scanning all Sparks for model coverage…</p>
      )}
      {data && (
        <>
          <p className="mb-3 text-[11px] text-muted">
            {fullyReplicated} of {data.models.length} models fully replicated
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-border text-left text-muted">
                  <th className="pb-1.5 pr-3 font-medium">Model</th>
                  {data.sparks.map((s) => (
                    <th
                      key={s.id}
                      className="pb-1.5 px-2 font-medium whitespace-nowrap"
                      title={s.id}
                    >
                      {s.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedModels.map((m) => (
                  <tr
                    key={`${m.kind}:${m.name}`}
                    className="border-b border-border last:border-0"
                  >
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      <span className="font-medium text-text-strong">{m.name}</span>
                      <span className="ml-1.5 rounded bg-accent/15 px-1 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                        {m.kind}
                      </span>
                    </td>
                    {data.sparks.map((s) => {
                      const present = m.present.includes(s.id);
                      const missing = m.missing.includes(s.id);
                      return (
                        <td key={s.id} className="py-1.5 px-2 text-center">
                          {present ? (
                            <span className="text-success">✓</span>
                          ) : missing ? (
                            <span className="text-danger">—</span>
                          ) : (
                            <span className="text-muted">·</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

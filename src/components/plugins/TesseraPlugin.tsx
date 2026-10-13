import { useEffect, useState } from "react";
import type { PluginSettingsContext } from "../../plugins/types";

export function TesseraPlugin({ settings, updateSettings }: PluginSettingsContext) {
  const [status, setStatus] = useState<"unknown" | "connected" | "disconnected">(
    "unknown"
  );
  const [loading, setLoading] = useState(false);

  const tesseraUrl = settings?.tesseraUrl || "http://localhost:5056";
  const tesseraEnabled = settings?.tesseraEnabled !== false;

  useEffect(() => {
    if (!tesseraEnabled) {
      setStatus("unknown");
      return;
    }

    let cancelled = false;
    const checkHealth = async () => {
      setLoading(true);
      try {
        const response = await fetch(
          `/api/plugins/tessera/health?url=${encodeURIComponent(tesseraUrl)}`,
          { method: "GET" }
        );
        if (cancelled) return;
        setStatus(response.ok ? "connected" : "disconnected");
      } catch {
        if (!cancelled) setStatus("disconnected");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 30000); // Poll every 30s
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tesseraEnabled, tesseraUrl]);

  if (!settings) return null;

  return (
    <div className="tessera-plugin">
      <div className="tessera-plugin__header">
        <h3 className="tessera-plugin__title">Tessera Console</h3>
        <div className="tessera-plugin__status">
          <div className={`tessera-status-dot ${status}`} />
          <span className="tessera-status-text">
            {status === "unknown"
              ? "—"
              : status === "connected"
                ? "Connected"
                : "Disconnected"}
          </span>
        </div>
      </div>

      <div className="tessera-plugin__url-field">
        <label htmlFor="tessera-url" className="tessera-plugin__label">
          Tessera URL
        </label>
        <input
          id="tessera-url"
          type="text"
          value={tesseraUrl}
          onChange={(e) => {
            updateSettings?.({ tesseraUrl: e.target.value });
          }}
          placeholder="http://localhost:5056"
          className="tessera-plugin__input"
        />
      </div>

      {status === "connected" && (
        <button
          type="button"
          className="tessera-plugin__button"
          onClick={() => {
            window.open(tesseraUrl, "tessera-console", "width=1200,height=800");
          }}
        >
          Open Tessera Console
        </button>
      )}

      {loading && (
        <p className="tessera-plugin__loading">Checking connection…</p>
      )}
    </div>
  );
}

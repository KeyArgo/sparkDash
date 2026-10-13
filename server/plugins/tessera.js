/**
 * Tessera plugin for sparkdeck.
 * Provides health checks and integration with the Tessera console.
 */

export async function checkTesseraHealth(url) {
  if (!url) {
    return { reachable: false, error: "No URL provided" };
  }

  try {
    const normalizedUrl = url.replace(/\/$/, "");
    // Try the Tessera health endpoint
    const response = await fetch(`${normalizedUrl}/api/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      return { reachable: true, status: "healthy" };
    }

    // If health endpoint doesn't exist, try checking the root
    const rootResponse = await fetch(normalizedUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });

    return {
      reachable: rootResponse.ok,
      status: rootResponse.ok ? "reachable" : "unreachable",
    };
  } catch (err) {
    return {
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Plugin manifest — registered by the Tessera plugin registry.
 */
export const tesseraPlugin = {
  id: "tessera",
  name: "Tessera Console",
  version: "1.0.0",
  description:
    "Health checks and console integration for the Tessera dashboard.",
  /**
   * Mount Tessera plugin endpoints on an Express app.
   * @param {import("express").Express} app
   */
  mount(app) {
    app.get("/api/plugins/tessera/health", async (req, res) => {
      const { url } = req.query;

      if (!url) {
        return res.status(400).json({ error: "Missing 'url' query parameter" });
      }

      try {
        const result = await checkTesseraHealth(url);
        res.json(result);
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : "Internal server error",
        });
      }
    });
  },
  /**
   * No per-snapshot contribution yet — the health endpoint + settings panel
   * are the current surface. (Return null to stay out of the WS payload.)
   * @returns {null}
   */
  contribute() {
    return null;
  },
};

export default tesseraPlugin;

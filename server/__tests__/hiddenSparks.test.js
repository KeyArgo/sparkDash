import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import express from "express";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdeck-hidden-test-"));
process.env.SPARKDECK_ADMIN_SECRET = path.join(tmpDir, "admin-secret.json");
process.env.SPARKDECK_SESSION_KEY = path.join(tmpDir, ".session-secret");
process.env.HIDDEN_SPARKS = "spark-e";

const { hiddenSparkGuard, makeAdminCookie } = await import("../admin.js");

const serverIndexPath = fileURLToPath(new URL("../index.js", import.meta.url));

/**
 * Route-level test of the hidden-spark guard.
 *
 * The full app IS exported from server/index.js, but importing it boots the
 * real HTTP listener and starts a live SparkMonitor per box — which SSHes the
 * fleet — so it can't be imported in a unit test. Instead the production
 * guard middleware (admin.hiddenSparkGuard, exactly what index.js mounts) is
 * exercised through a real express app + real HTTP, which is behaviorally
 * equivalent for the guard itself.
 */
function buildApp() {
  const app = express();
  app.use("/api/sparks", hiddenSparkGuard);
  // Stand-in for the per-id routes index.js registers after the guard.
  app.get("/api/sparks/:id/metrics", (req, res) => {
    res.json({ id: req.params.id, online: false });
  });
  return app;
}

async function withServer(fn) {
  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const ADMIN_COOKIE = (() => {
  const m = makeAdminCookie().match(/sd_admin=([^;]+)/);
  return `sd_admin=${m[1]}`;
})();

describe("hiddenSparkGuard", () => {
  it("non-admin: 404 not_found on a hidden spark's per-id route; admin and visible sparks pass", async () => {
    await withServer(async (base) => {
      // Non-admin, hidden spark -> 404 as if the id didn't exist.
      const anon = await fetch(`${base}/api/sparks/spark-e/metrics`);
      assert.equal(anon.status, 404);
      assert.deepEqual(await anon.json(), { error: "not_found" });

      // Admin, same hidden spark -> guard passes through to the route handler.
      const adminRes = await fetch(`${base}/api/sparks/spark-e/metrics`, {
        headers: { cookie: ADMIN_COOKIE },
      });
      assert.equal(adminRes.status, 200);
      assert.equal((await adminRes.json()).id, "spark-e");

      // Non-admin, visible spark -> guard passes through.
      const visible = await fetch(`${base}/api/sparks/spark-a/metrics`);
      assert.equal(visible.status, 200);
    });
  });

  it("404s every HTTP method on a hidden spark for a non-admin, not just GET", async () => {
    await withServer(async (base) => {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const r = await fetch(`${base}/api/sparks/spark-e/shutdown`, { method });
        assert.equal(r.status, 404, `${method} should 404`);
        assert.deepEqual(await r.json(), { error: "not_found" });
      }
    });
  });
});

// Batch/collection routes have no :id segment for the guard to check, so they
// filter at their own call sites with filterVisibleSparks. A non-admin must
// never be able to enumerate or act on a hidden Spark through them either.
// Hitting shutdown-all/wake-all in a test would shut down / wake real boxes,
// so this asserts the wiring at the source level instead (same pattern the
// serving-config suite uses to prove the live model switch is never called).
describe("hidden-spark wiring in server/index.js", () => {
  const source = [
    fs.readFileSync(serverIndexPath, "utf8"),
    fs.readFileSync(new URL("../fleetRoutes.js", import.meta.url), "utf8"),
  ].join("\n");

  it("mounts hiddenSparkGuard at /api/sparks before per-id routes", () => {
    assert.ok(source.includes("app.use(\"/api/sparks\", hiddenSparkGuard)"));
  });

  it("filters hidden Sparks in the bare list, both batch routes, and fleet aggregates", () => {
    const needles = [
      // Bare list API.
      "filterVisibleSparks(registry.publicSparks, isAdmin(req))",
      // shutdown-all.
      "const visible = filterVisibleSparks(registry.sparks, admin)",
      // wake-all.
      "for (const spark of filterVisibleSparks(registry.sparks, admin))",
      // fleet/coverage.
      "const sparks = filterVisibleSparks(registry.sparks, isAdmin(req))",
      // litellm snapshot lookup + WebSocket snapshot broadcast both filter
      // through the same call.
      "filterVisibleSparks(orderedSnapshots(), admin)",
    ];
    for (const needle of needles) {
      assert.ok(
        source.includes(needle),
        `missing hidden-spark filter in index.js: ${needle}`
      );
    }
  });
});

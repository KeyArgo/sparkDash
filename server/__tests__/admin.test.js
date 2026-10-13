import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdeck-admin-test-"));
const secretPath = path.join(tmpDir, "admin-secret.json");
const sessionKeyPath = path.join(tmpDir, ".session-secret");

process.env.SPARKDECK_ADMIN_SECRET = secretPath;
process.env.SPARKDECK_SESSION_KEY = sessionKeyPath;
process.env.PROTECTED_SPARKS = "spark-a,spark-b";
process.env.HIDDEN_SPARKS = "spark-e";

const admin = await import("../admin.js");

describe("admin", () => {
  describe("hashPassword / verifyPassword", () => {
    it("verifyPassword returns true for the correct password", () => {
      const hash = admin.hashPassword("hunter2");
      assert.equal(admin.verifyPassword("hunter2", hash), true);
    });

    it("verifyPassword returns false for a wrong password", () => {
      const hash = admin.hashPassword("hunter2");
      assert.equal(admin.verifyPassword("wrong", hash), false);
    });

    it("verifyPassword returns false for null / undefined stored", () => {
      assert.equal(admin.verifyPassword("x", null), false);
      assert.equal(admin.verifyPassword("x", undefined), false);
    });

    it("verifyPassword returns false for a malformed stored hash", () => {
      assert.equal(admin.verifyPassword("x", "not-a-valid-format"), false);
    });
  });

  describe("makeAdminCookie / isAdmin", () => {
    it("makeAdminCookie produces a cookie whose token makes isAdmin return true", () => {
      const cookie = admin.makeAdminCookie();
      const match = cookie.match(/sd_admin=([^;]+)/);
      assert.ok(match);
      const token = match[1];
      const req = { headers: { cookie: `sd_admin=${token}` } };
      assert.equal(admin.isAdmin(req), true);
    });

    it("a tampered token makes isAdmin return false", () => {
      const cookie = admin.makeAdminCookie();
      const match = cookie.match(/sd_admin=([^;]+)/);
      const token = match[1];
      const parts = token.split(".");
      const tampered = `${"A".repeat(parts[0].length)}.${parts[1]}`;
      const req = { headers: { cookie: `sd_admin=${tampered}` } };
      assert.equal(admin.isAdmin(req), false);
    });

    it("a request with no cookie makes isAdmin return false", () => {
      assert.equal(admin.isAdmin({ headers: {} }), false);
    });
  });

  describe("isHiddenSpark", () => {
    it("hides the default spark-e", () => {
      assert.equal(admin.isHiddenSpark("spark-e"), true);
    });

    it("does not hide ordinary sparks", () => {
      assert.equal(admin.isHiddenSpark("spark-a"), false);
      assert.equal(admin.isHiddenSpark("spark-f"), false);
    });
  });

  describe("filterVisibleSparks", () => {
    const list = [{ id: "spark-a" }, { id: "spark-e" }, { id: "spark-f" }];

    it("strips hidden Sparks for a non-admin", () => {
      assert.deepEqual(
        admin.filterVisibleSparks(list, false).map((s) => s.id),
        ["spark-a", "spark-f"]
      );
    });

    it("keeps hidden Sparks for an admin", () => {
      assert.deepEqual(
        admin.filterVisibleSparks(list, true).map((s) => s.id),
        ["spark-a", "spark-e", "spark-f"]
      );
    });

    it("does not mutate the input array", () => {
      const input = [...list];
      admin.filterVisibleSparks(input, false);
      assert.equal(input.length, 3);
    });
  });

  describe("HIDDEN_SPARKS env override", () => {
    it("a custom HIDDEN_SPARKS is respected on a fresh module import", async () => {
      const prev = process.env.HIDDEN_SPARKS;
      process.env.HIDDEN_SPARKS = "spark-x, spark-y";
      try {
        // Query-string import: ESM treats it as a distinct module URL, so the
        // env change is picked up by the module-level HIDDEN_SPARKS init.
        const overridden = await import("../admin.js?hidden=override");
        assert.equal(overridden.isHiddenSpark("spark-x"), true);
        assert.equal(overridden.isHiddenSpark("spark-y"), true);
        assert.equal(overridden.isHiddenSpark("spark-e"), false);
        assert.deepEqual(
          overridden
            .filterVisibleSparks(
              [{ id: "spark-a" }, { id: "spark-x" }, { id: "spark-y" }, { id: "spark-e" }],
              false
            )
            .map((s) => s.id),
          // spark-x/spark-y are hidden under the override; spark-e is visible.
          ["spark-a", "spark-e"]
        );
      } finally {
        process.env.HIDDEN_SPARKS = prev;
      }
    });
  });

  describe("guardSpark", () => {
    before(() => {
      try {
        fs.unlinkSync(secretPath);
      } catch {}
    });

    it("returns null when no password hash is configured (open gate)", () => {
      const result = admin.guardSpark("spark-a", { headers: {} });
      assert.equal(result, null);
    });

    it("returns 403 for a protected spark when the request is not admin", () => {
      admin.saveAdminPassword("test-password");
      const result = admin.guardSpark("spark-a", { headers: {} });
      assert.deepEqual(result, {
        status: 403,
        body: {
          error: "admin_required",
          message:
            "spark-a is admin-protected \u2014 enter the admin password to make changes here.",
        },
      });
    });

    it("returns null when the spark is NOT in PROTECTED_SPARKS", () => {
      const result = admin.guardSpark("spark-c", { headers: {} });
      assert.equal(result, null);
    });

    it("returns null for a protected spark when an admin cookie is present", () => {
      const cookie = admin.makeAdminCookie();
      const match = cookie.match(/sd_admin=([^;]+)/);
      const req = { headers: { cookie: `sd_admin=${match[1]}` } };
      const result = admin.guardSpark("spark-a", req);
      assert.equal(result, null);
    });
  });
});

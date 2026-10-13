/**
 * Admin gate for sparkdeck.
 *
 * Ported from spark-control's Flask gate: protected Sparks require an admin
 * password before ANY mutating action (control, shutdown, wake). Non-admins can
 * still fully manage the open Sparks. Enforced server-side — the UI lock is only
 * cosmetic.
 *
 * Design notes (kept deliberately dependency-free):
 *   - Session is a signed cookie (HMAC-SHA256), not a server store. Mirrors the
 *     itsdangerous/Flask-session approach we used before. Survives restarts
 *     because the signing key is persisted to config/.session-secret.
 *   - Password is stored ONLY as a salted scrypt hash in config/admin-secret.json
 *     (gitignored). Plaintext is never written.
 *   - Fail-open-until-configured: with no admin-secret.json, protected Sparks are
 *     NOT locked and the UI shows a loud warning — so the owner can't lock
 *     themselves out during setup. Identical to the Flask behaviour.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SECRET_PATH =
  process.env.SPARKDECK_ADMIN_SECRET || path.join(ROOT, "config", "admin-secret.json");
const SESSION_KEY_PATH =
  process.env.SPARKDECK_SESSION_KEY || path.join(ROOT, "config", ".session-secret");

const COOKIE_NAME = "sd_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h, matches Flask lifetime

/**
 * Sparks that require the admin password before any change. Overridable via
 * PROTECTED_SPARKS env (comma-separated spark ids). Defaults to spark-a/spark-b.
 */
export const PROTECTED_SPARKS = new Set(
  (process.env.PROTECTED_SPARKS || "spark-a,spark-b")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

/**
 * Sparks invisible to non-admins: absent from the list API, the WS snapshot
 * stream, fleet-wide aggregate routes (coverage/litellm), and bulk actions
 * (shutdown-all/wake-all) — not merely hidden in the UI. Direct per-id routes
 * (/api/sparks/<id>/...) 404 for a hidden id when not admin, same as if it
 * didn't exist. Overridable via HIDDEN_SPARKS env (comma-separated spark
 * ids). Defaults to spark-e.
 */
export const HIDDEN_SPARKS = new Set(
  (process.env.HIDDEN_SPARKS || "spark-e")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

export function isHiddenSpark(sparkId) {
  return HIDDEN_SPARKS.has(sparkId);
}

/** Strip hidden Sparks from any list of spark-like objects ({id, ...}) for a
 * non-admin viewer. Admins see everything unfiltered. */
export function filterVisibleSparks(sparks, admin) {
  if (admin) return sparks;
  return sparks.filter((s) => !HIDDEN_SPARKS.has(s.id));
}

/**
 * Express middleware to mount at "/api/sparks". A non-admin gets a 404 for
 * ANY request naming a hidden Spark directly (GET included) — as if the id
 * doesn't exist, not merely a permission error. Admins pass through. Runs
 * before the mutation guard and before every per-id route handler, so no
 * future route can accidentally leak a hidden Spark's data. Batch/collection
 * routes (shutdown-all, wake-all, the bare list) are filtered separately at
 * their own call sites via filterVisibleSparks since they have no :id segment.
 * Pure middleware — no express import, keeps admin.js dependency-free.
 */
export function hiddenSparkGuard(req, res, next) {
  // req.path is relative to the mount point ("/api/sparks"), e.g. "/spark-e/…".
  const segs = req.path.split("/").filter(Boolean);
  const id = segs[0];
  if (id && isHiddenSpark(id) && !isAdmin(req)) {
    return res.status(404).json({ error: "not_found" });
  }
  next();
}

// ─── Signing key (persisted so sessions survive restarts) ───────────────────
function loadSessionKey() {
  try {
    const buf = fs.readFileSync(SESSION_KEY_PATH);
    if (buf && buf.length >= 32) return buf;
  } catch {
    /* generate below */
  }
  const key = crypto.randomBytes(48);
  try {
    fs.mkdirSync(path.dirname(SESSION_KEY_PATH), { recursive: true });
    fs.writeFileSync(SESSION_KEY_PATH, key, { mode: 0o600 });
    fs.chmodSync(SESSION_KEY_PATH, 0o600);
  } catch (err) {
    console.error("[admin] could not persist session key:", err.message);
  }
  return key;
}
const SESSION_KEY = loadSessionKey();

// ─── Password hash storage (scrypt) ─────────────────────────────────────────
/** Returns the stored hash string, or null if no password is configured. */
export function loadAdminHash() {
  try {
    const raw = JSON.parse(fs.readFileSync(SECRET_PATH, "utf8"));
    return typeof raw?.hash === "string" && raw.hash ? raw.hash : null;
  } catch {
    return null;
  }
}

/** Hash a password with scrypt → "scrypt$<saltHex>$<hashHex>". */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** Persist an admin password (hash only) to config/admin-secret.json (0600). */
export function saveAdminPassword(password) {
  const hash = hashPassword(password);
  fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
  fs.writeFileSync(SECRET_PATH, JSON.stringify({ hash }, null, 2), { mode: 0o600 });
  fs.chmodSync(SECRET_PATH, 0o600);
  return hash;
}

/** Constant-time verify a password against the stored scrypt hash. */
export function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    const derived = crypto.scryptSync(String(password), salt, expected.length);
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ─── Signed-cookie session ──────────────────────────────────────────────────
function sign(payloadB64) {
  return crypto.createHmac("sha256", SESSION_KEY).update(payloadB64).digest("base64url");
}

/** Build a Set-Cookie value granting admin for SESSION_TTL_MS. */
export function makeAdminCookie() {
  const payload = { v: 1, admin: true, exp: Date.now() + SESSION_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const token = `${payloadB64}.${sign(payloadB64)}`;
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  // No Secure flag: served over http on LAN/Tailscale (same as the Flask gate).
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Set-Cookie value that clears the session. */
export function clearAdminCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function parseCookies(req) {
  const header = req.headers?.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** True if the request carries a valid, unexpired admin session cookie. */
export function isAdmin(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payloadB64 = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payloadB64);
  // constant-time compare of equal-length base64url strings
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    return payload?.admin === true && typeof payload.exp === "number" && payload.exp > Date.now();
  } catch {
    return false;
  }
}

/**
 * Gate check for a mutating action on a Spark. Returns null if allowed, or a
 * {status, body} to send if blocked. Fail-open until a password is configured.
 */
export function guardSpark(sparkId, req) {
  const hash = loadAdminHash();
  if (!hash) return null; // not configured → open (with UI warning)
  if (!PROTECTED_SPARKS.has(sparkId)) return null; // open box (e.g. C/D)
  if (isAdmin(req)) return null;
  return {
    status: 403,
    body: {
      error: "admin_required",
      message: `${sparkId} is admin-protected — enter the admin password to make changes here.`,
    },
  };
}

/** Public status for the UI. */
export function adminStatus(req) {
  return {
    admin: isAdmin(req),
    configured: Boolean(loadAdminHash()),
    protected: [...PROTECTED_SPARKS],
  };
}

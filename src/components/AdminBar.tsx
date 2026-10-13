import { useState } from "react";
import type { UseAdmin } from "../hooks/useAdmin";

function LockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function UnlockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
  );
}

/**
 * Header admin control. The server enforces the gate; this only reflects it.
 * Hidden until an admin password is configured.
 */
export function AdminBar({ admin }: { admin: UseAdmin }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!admin.configured) return null;

  if (admin.isAdmin) {
    return (
      <button
        type="button"
        onClick={() => void admin.logout()}
        className="flex items-center gap-1.5 rounded-full border border-border bg-surface-elevated px-2.5 py-1 text-xs text-text"
        title="Admin unlocked — click to lock protected Sparks again"
      >
        <UnlockIcon className="h-3.5 w-3.5" />
        <span>Admin</span>
      </button>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await admin.login(password);
      setPassword("");
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted hover:text-text"
        title="Protected Sparks are locked — click to enter the admin password"
      >
        <LockIcon className="h-3.5 w-3.5" />
        <span>Locked</span>
      </button>
    );
  }

  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        type="password"
        autoFocus
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            setPassword("");
            setError(null);
          }
        }}
        placeholder="Admin password"
        aria-label="Admin password"
        className="w-36 rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs text-text outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={busy || !password}
        className="rounded bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
      >
        {busy ? "…" : "Unlock"}
      </button>
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </form>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchAdminStatus,
  adminLogin as apiLogin,
  adminLogout as apiLogout,
  type AdminStatus,
} from "../api/client";

const POLL_MS = 60_000;

export interface UseAdmin {
  /** Whether the current session is authenticated as admin. */
  isAdmin: boolean;
  /** False until the first status response arrives. */
  loaded: boolean;
  /** Whether an admin password has been set on the server. */
  configured: boolean;
  /** Spark ids that require admin to mutate. */
  protectedIds: string[];
  /** True if a spark is locked for this session (protected + configured + not admin). */
  isLocked: (id: string) => boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => void;
}

/**
 * Tracks the admin session. The server is the source of truth (it enforces the
 * gate); this only drives the UI lock state. Polls periodically so a session
 * that expires server-side eventually re-locks the UI.
 */
export function useAdmin(): UseAdmin {
  const [status, setStatus] = useState<AdminStatus>({
    admin: false,
    configured: false,
    protected: [],
  });
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    fetchAdminStatus()
      .then(setStatus)
      .catch(() => {
        /* leave last-known state; server enforces regardless */
      })
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const login = useCallback(
    async (password: string) => {
      await apiLogin(password);
      refresh();
    },
    [refresh]
  );

  const logout = useCallback(async () => {
    await apiLogout();
    refresh();
  }, [refresh]);

  const protectedSet = useMemo(() => new Set(status.protected), [status.protected]);
  const isLocked = useCallback(
    (id: string) => status.configured && !status.admin && protectedSet.has(id),
    [status.configured, status.admin, protectedSet]
  );

  return {
    isAdmin: status.admin,
    loaded,
    configured: status.configured,
    protectedIds: status.protected,
    isLocked,
    login,
    logout,
    refresh,
  };
}

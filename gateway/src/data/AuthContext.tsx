import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  type Session,
  type SessionUser,
  fetchSession,
  login as apiLogin,
  logout as apiLogout,
  switchTenant,
} from "./api";
import { canAdminTenant as sessionCanAdminTenant } from "./sessionState";

interface AuthState {
  session: Session | null;
  user: SessionUser | null;
  loading: boolean;
  // Set when the session could not be read for a reason other than being
  // signed out, so the app can say so instead of showing the login page.
  loadError: string | null;
  isOperator: boolean;
  canAdminTenant: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  switchTo: (tenantId: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSession(await fetchSession());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load your session");
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      await apiLogin(email, password);
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await apiLogout();
    setSession(null);
  }, []);

  // A full reload rather than a state update: every page holds data fetched
  // for the workspace it was opened in, and none of it is valid in the next.
  const switchTo = useCallback(async (tenantId: string) => {
    await switchTenant(tenantId);
    window.location.assign("/");
  }, []);

  const value: AuthState = {
    session,
    user: session?.user ?? null,
    loading,
    loadError,
    isOperator: session?.user.is_operator ?? false,
    canAdminTenant: sessionCanAdminTenant(session),
    refresh,
    login,
    logout,
    switchTo,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  type CurrentTenant,
  type Session,
  type SessionUser,
  fetchFeatureFlags,
  fetchSession,
  loadCurrentTenant,
  login as apiLogin,
  logout as apiLogout,
  signOutEverywhere,
  switchTenant,
} from "./api";
import { type Capabilities, capabilitiesOf } from "./capabilities";
import { ALL_OFF, type FeatureFlags, GATEWAY_V2 } from "./featureFlags";
import { landingAfterSwitch } from "./settingsLanding";
import { clearPendingInvite } from "./sessionState";

interface AuthState {
  session: Session | null;
  user: SessionUser | null;
  loading: boolean;
  // Set when the session could not be read for a reason other than being
  // signed out, so the app can say so instead of showing the login page.
  loadError: string | null;
  isOperator: boolean;
  canAdminTenant: boolean;
  capabilities: Capabilities;
  // Set when the session could not be read again on coming back to the tab:
  // what the page shows may be out of date, and it says so.
  staleError: string | null;
  // Reads the session again, after any read already under way, which may
  // have started before what the caller just changed. Never rejects: a read
  // that fails sets `staleError`.
  recheck: () => Promise<void>;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  logoutEverywhere: () => Promise<void>;
  switchTo: (tenantId: string) => Promise<void>;
}

interface Loaded {
  session: Session | null;
  tenant: CurrentTenant | null;
  flags: FeatureFlags;
}

/** The session, and with it what the dashboard needs before it can decide
 * what anyone may open: the deployment's flags, and the current workspace as
 * the server sees the caller in it. All three or an error, never a partial
 * answer that would hide pages for the wrong reason. */
async function loadAll(): Promise<Loaded> {
  const session = await fetchSession();
  if (session === null) return { session: null, tenant: null, flags: ALL_OFF };
  const [flags, tenant] = await Promise.all([
    fetchFeatureFlags(),
    session.state === "ready" ? loadCurrentTenant() : Promise.resolve(null),
  ]);
  return { session, tenant, flags };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load your session";
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState<Loaded>({ session: null, tenant: null, flags: ALL_OFF });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [staleError, setStaleError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoaded(await loadAll());
      setLoadError(null);
      setStaleError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  // What this page holds can fall behind the server. Back or forward can
  // restore it from the browser's cache as it was left, and switching
  // workspace leaves it by a full load (see `switchTo`), so a restored page
  // may hold another workspace's session and data, and every request it
  // makes would name that workspace: reload it. A role can change while the
  // page sits in a background tab, so it is read again whenever the tab comes
  // back, and the route guards and rail follow what the server now says.
  //
  // One read at a time: a restore fires both events at once. Not being able
  // to read it is loud for a restored page, which may belong to another
  // workspace, and a warning for a tab coming back, which holds this one's.
  const held = useRef<Session | null>(null);
  useEffect(() => {
    held.current = loaded.session;
  }, [loaded.session]);
  const reading = useRef<Promise<void> | null>(null);
  const restoredWhileReading = useRef(false);
  const revalidate = useCallback((restored: boolean): Promise<void> => {
    restoredWhileReading.current ||= restored;
    if (reading.current !== null) return reading.current;
    reading.current = (async () => {
      let current: Loaded;
      try {
        current = await loadAll();
      } catch (err) {
        if (restoredWhileReading.current) setLoadError(errorMessage(err));
        else setStaleError(errorMessage(err));
        return;
      }
      const before = held.current;
      if (
        current.session?.user.id !== before?.user.id ||
        current.session?.tenant?.id !== before?.tenant?.id
      ) {
        window.location.reload();
        return;
      }
      setStaleError(null);
      setLoaded(current);
    })().finally(() => {
      reading.current = null;
      restoredWhileReading.current = false;
    });
    return reading.current;
  }, []);
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void revalidate(true);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void revalidate(false);
    };
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [revalidate]);
  const recheck = useCallback(async () => {
    while (reading.current !== null) await reading.current;
    await revalidate(false);
  }, [revalidate]);

  const login = useCallback(
    async (email: string, password: string) => {
      await apiLogin(email, password);
      await refresh();
    },
    [refresh],
  );

  // The next person to sign in on this tab must not inherit an invitation
  // they never followed. Dropped only once signed out: a sign-out that fails
  // leaves the person here, invitation and all.
  const logout = useCallback(async () => {
    await apiLogout();
    clearPendingInvite();
    setLoaded({ session: null, tenant: null, flags: ALL_OFF });
  }, []);

  const logoutEverywhere = useCallback(async () => {
    await signOutEverywhere();
    clearPendingInvite();
    setLoaded({ session: null, tenant: null, flags: ALL_OFF });
  }, []);

  // A full reload rather than a state update: every page holds data fetched
  // for the workspace it was opened in, and none of it is valid in the next.
  const newLayout = loaded.flags[GATEWAY_V2];
  const switchTo = useCallback(
    async (tenantId: string) => {
      await switchTenant(tenantId);
      window.location.assign(landingAfterSwitch(window.location.pathname, newLayout));
    },
    [newLayout],
  );

  const capabilities = capabilitiesOf(loaded.session, loaded.tenant, loaded.flags);
  const value: AuthState = {
    session: loaded.session,
    user: loaded.session?.user ?? null,
    loading,
    loadError,
    isOperator: capabilities.isOperator,
    canAdminTenant: capabilities.administersWorkspace,
    capabilities,
    staleError,
    recheck,
    refresh,
    login,
    logout,
    logoutEverywhere,
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

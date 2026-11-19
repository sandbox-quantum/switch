import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
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
import { ALL_OFF, type FeatureFlags } from "./featureFlags";
import { onSessionSignal, setShownWorkspace } from "./gatewayFetch";
import { landingAfterSwitch } from "./settingsLanding";
import { clearPendingInvite } from "./sessionState";
import {
  followWorkspaceLink,
  forgetLinkForSignIn,
  keepLinkForSignIn,
  linkAddress,
  linkedWorkspace,
  onThisDashboard,
  takeLinkAfterSignIn,
  withoutLinkedWorkspace,
} from "./workspaceLink";

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
  // Set when the page was opened from a link naming a workspace it could not
  // switch to, so it says which workspace it shows instead.
  linkNotice: string | null;
  // Set when the server refused a write because the session has since moved
  // to another workspace, in another tab: what the server said, until the
  // page is reloaded.
  workspaceMismatch: string | null;
  dismissLinkNotice: () => void;
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
  return loadFor(await fetchSession());
}

/** `loadAll` for a session already read. */
async function loadFor(session: Session | null): Promise<Loaded> {
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

/** The least time between two reads of the session prompted by the server
 * refusing something, so a page that keeps asking for what it may not have
 * does not keep reading it. */
const REFUSAL_REREAD_MS = 5000;

function sameLoad(a: Loaded, b: Loaded): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState<Loaded>({ session: null, tenant: null, flags: ALL_OFF });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [staleError, setStaleError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [workspaceMismatch, setWorkspaceMismatch] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  // Read on arrival only: the address drops it straight away.
  const [linked] = useState(() => linkedWorkspace(location.search));
  const arrived = useRef(location);
  const here = useRef(location);
  useEffect(() => {
    here.current = location;
  }, [location]);

  const refresh = useCallback(async () => {
    try {
      setLoaded(await loadAll());
      setLoadError(null);
      setStaleError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  // What a link naming a workspace asks of this load, given the session:
  // true when the page is leaving for another address, so nothing more is
  // read here. A link followed while signed out is kept, and followed on the
  // first load signed in.
  const followLink = useCallback(
    async (session: Session | null): Promise<boolean> => {
      if (linked === null) {
        const kept = session === null ? null : takeLinkAfterSignIn();
        if (kept === null) return false;
        window.location.replace(linkAddress(kept));
        return true;
      }
      const here = withoutLinkedWorkspace(arrived.current);
      navigate(here, { replace: true });
      if (session === null) {
        keepLinkForSignIn({ path: here, workspace: linked });
        return false;
      }
      try {
        const outcome = await followWorkspaceLink(linked, session);
        if (outcome.switched) {
          window.location.replace(onThisDashboard(here));
          return true;
        }
        setLinkNotice(outcome.notice);
      } catch (err) {
        setLinkNotice(
          `Couldn't switch to the workspace the link you followed is for: ${errorMessage(err)}`,
        );
      }
      return false;
    },
    [linked, navigate],
  );

  // Once per page load, a development build's second run included, so a
  // link switches workspace at most once. A switch reloads the page in the
  // new workspace before anything is read for the old one. The session is
  // read once, for the link and the load both.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const session = await fetchSession();
        if (await followLink(session)) return;
        setLoaded(await loadFor(session));
        setLoadError(null);
        setStaleError(null);
      } catch (err) {
        setLoadError(errorMessage(err));
      }
      setLoading(false);
    })();
  }, [followLink]);
  const dismissLinkNotice = useCallback(() => setLinkNotice(null), []);

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
    setShownWorkspace(loaded.session?.tenant?.id ?? null);
  }, [loaded.session]);
  // Set while signing out on purpose, so the session ending is not taken for
  // one that ended under the page.
  const signingOut = useRef(false);
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
      if (signingOut.current) return;
      if (
        current.session?.user.id !== before?.user.id ||
        current.session?.tenant?.id !== before?.tenant?.id
      ) {
        // A session that ended under the page comes back here once signed
        // in again, as a link naming the workspace it showed.
        if (current.session === null && before?.tenant) {
          const { pathname, search, hash } = here.current;
          keepLinkForSignIn({ path: `${pathname}${search}${hash}`, workspace: before.tenant.id });
        }
        window.location.reload();
        return;
      }
      setStaleError(null);
      setLoaded((shown) => (sameLoad(shown, current) ? shown : current));
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

  // What the server's answers say about the session, heard from every
  // request the page sends (`gatewayFetch`). A 401 means it has ended, so
  // reading it again finds it gone and the page goes to sign-in. A 403 may
  // mean the person's role changed, so it is read again and the route guards
  // and rail follow. A write refused because another tab moved the session to
  // another workspace is said until the page is reloaded.
  const lastRefusalRead = useRef(0);
  useEffect(
    () =>
      onSessionSignal((signal) => {
        if (held.current === null || signingOut.current) return;
        if (signal.kind === "workspace_mismatch") {
          setWorkspaceMismatch(signal.message);
          return;
        }
        if (signal.kind === "refused") {
          if (Date.now() - lastRefusalRead.current < REFUSAL_REREAD_MS) return;
          lastRefusalRead.current = Date.now();
        }
        void revalidate(false);
      }),
    [revalidate],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      await apiLogin(email, password);
      const kept = takeLinkAfterSignIn();
      if (kept !== null) {
        window.location.replace(linkAddress(kept));
        return;
      }
      await refresh();
    },
    [refresh],
  );

  // The next person to sign in on this tab must not inherit an invitation,
  // or a link, they never followed. Both are dropped only once signed out: a
  // sign-out that fails leaves the person here, with what they had.
  const signOutWith = useCallback(async (signOut: () => Promise<void>) => {
    signingOut.current = true;
    try {
      await signOut();
    } catch (err) {
      signingOut.current = false;
      throw err;
    }
    clearPendingInvite();
    forgetLinkForSignIn();
    held.current = null;
    setLoaded({ session: null, tenant: null, flags: ALL_OFF });
    signingOut.current = false;
  }, []);
  const logout = useCallback(() => signOutWith(apiLogout), [signOutWith]);
  const logoutEverywhere = useCallback(() => signOutWith(signOutEverywhere), [signOutWith]);

  // A full reload rather than a state update: every page holds data fetched
  // for the workspace it was opened in, and none of it is valid in the next.
  const switchTo = useCallback(async (tenantId: string) => {
    await switchTenant(tenantId);
    window.location.assign(landingAfterSwitch(window.location.pathname));
  }, []);

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
    linkNotice,
    dismissLinkNotice,
    workspaceMismatch,
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

import { Box, CircularProgress, Stack, Tab, Tabs, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router";
import { useAuth } from "../../data/AuthContext";
import { HostedContext, type HostedState } from "./HostedContext";
import HostedRefusal from "./HostedRefusal";
import { type HostedAccess, checkHostedAccess } from "./hostedAccess";
import { HOSTED_TABS, type HostedTab, orderedTabs } from "./hostedTabs";

// Copy doc f3ebd339, "Switch web → Hosted: the shell".
export const HEADING = "Hosted agents · Operators";
export const LINE =
  "The shared cloud on this server. Ids only: nobody here sees prompts, replies, files or secrets.";
export const LOAD_ERROR = "Couldn't load hosted agents. Reload the page to try again.";

/** Switch web's Hosted page (`/hosted/*`, one route, so landing on `/hosted`
 *  checks access once; Core serves every path under it as this page): p10's
 *  heading and line, the tab bar, and the access check. The first segment
 *  after `/hosted/` is the tab; anything beyond it is the tab's own. Each tab
 *  is one entry in `hostedTabs.ts` and lives in its own folder, so this file
 *  changes only for the shell. */
export default function HostedPage({
  tabs = HOSTED_TABS,
}: {
  tabs?: readonly HostedTab[];
}) {
  const { user, refresh: refreshSession } = useAuth();
  const tabKey = (useParams()["*"] ?? "").split("/")[0];
  const navigate = useNavigate();
  const shown = useMemo(() => orderedTabs(tabs), [tabs]);
  const [access, setAccess] = useState<HostedAccess | null>(null);
  const [overviewStale, setOverviewStale] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const mounted = useRef(true);

  // A 401 is a session that ran out: re-read the session, and the app sends
  // the person to sign in as it does on every other page. No line of our own.
  const apply = useCallback(
    (next: HostedAccess, keepOverview: boolean) => {
      if (!mounted.current) return;
      if (next.kind === "signed-out") {
        void refreshSession();
      }
      if (next.kind === "error" && keepOverview) {
        setOverviewStale(true);
        return;
      }
      setOverviewStale(false);
      setAccess(next);
    },
    [refreshSession],
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    checkHostedAccess(controller.signal)
      .then((next) => apply(next, false))
      .catch(() => undefined);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [apply]);

  const refresh = useCallback(async () => {
    setRefreshKey((k) => k + 1);
    const next = await checkHostedAccess();
    apply(next, true);
  }, [apply]);

  const operator = useMemo(
    () => ({ id: user?.id ?? "", name: user?.name ?? "" }),
    [user?.id, user?.name],
  );
  const overview = access?.kind === "operator" ? access.overview : null;
  const context: HostedState = useMemo(
    () => ({ operator, overview, overviewStale, refreshKey, refresh }),
    [operator, overview, overviewStale, refreshKey, refresh],
  );

  const active = shown.find((t) => t.key === tabKey);

  // An unknown or missing tab goes to the first one, in the same mounted
  // page, so `/hosted` and an old link both land somewhere real.
  if (access?.kind === "operator" && !active && shown.length > 0) {
    return <Navigate to={`/hosted/${shown[0].key}`} replace />;
  }

  let body;
  if (access === null || access.kind === "signed-out") {
    body = (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <CircularProgress size={28} aria-label="Loading" />
      </Box>
    );
  } else if (access.kind === "refused") {
    body = <HostedRefusal />;
  } else if (access.kind === "error") {
    body = (
      <Typography role="alert" color="error" sx={{ py: 2 }}>
        {LOAD_ERROR}
      </Typography>
    );
  } else if (active) {
    const Body = active.component;
    body = (
      <>
        <Tabs
          value={active.key}
          onChange={(_e, key: string) => navigate(`/hosted/${key}`)}
          aria-label="Hosted"
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          sx={{ mb: 2 }}
        >
          {shown.map((t) => (
            <Tab key={t.key} value={t.key} label={t.label} />
          ))}
        </Tabs>
        <HostedContext.Provider value={context}>
          {/* Under `/hosted/<tab>/*`, so a tab's own <Routes> are relative to
              its URL, as they would be on a route of its own. */}
          <Routes>
            <Route path={`${active.key}/*`} element={<Body />} />
          </Routes>
        </HostedContext.Provider>
      </>
    );
  } else {
    body = null;
  }

  return (
    <Stack sx={{ flexGrow: 1, minHeight: 0 }}>
      <Typography variant="h5" component="h1">
        {HEADING}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        {LINE}
      </Typography>
      {body}
    </Stack>
  );
}

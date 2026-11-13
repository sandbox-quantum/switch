import { Alert, Box, CircularProgress, Snackbar, Tab, Tabs, Typography } from "@mui/material";
import { useCallback, useState } from "react";
import { useSearchParams } from "react-router";
import { fetchCurrentOrganization, fetchOrganizationServices } from "../../../data/api";
import { useConnectorApps } from "../../../data/hooks";
import { useLoad } from "../../workspace/useLoad";
import AppsTab from "./AppsTab";
import ConnectorsTab from "./ConnectorsTab";

const TABS = [
  { value: "connectors", label: "Connectors" },
  { value: "apps", label: "Apps & accounts" },
] as const;

type OrgConnectorsTab = (typeof TABS)[number]["value"];

/**
 * Organization settings › Connectors and apps: which connectors the
 * organization's workspaces may use, and the vendor apps they sign in
 * through. One page with two tabs, because the second is often why the
 * first doesn't work: a connector whose app isn't set up offers the setup
 * in place of its switch, and takes the admin to it here.
 *
 * The tab and the open app are in the address, so a reload or a shared link
 * lands where it was. Both tabs read the same two lists, and a change on
 * either reads both again.
 */
export default function OrganizationConnectorsSettings() {
  const [params, setParams] = useSearchParams();
  const tab: OrgConnectorsTab = params.get("tab") === "apps" ? "apps" : "connectors";
  const openApp = params.get("app");
  const setupFor = params.get("setup");

  const loadServices = useCallback(() => fetchOrganizationServices(), []);
  const services = useLoad(loadServices);
  const loadOrganization = useCallback(() => fetchCurrentOrganization(), []);
  const organization = useLoad(loadOrganization);
  const apps = useConnectorApps("organization");
  const [toast, setToast] = useState<string | null>(null);

  const refetchServices = services.refetch;
  const refetchApps = apps.refetch;
  const changed = useCallback(
    (message: string | null) => {
      if (message !== null) setToast(message);
      void refetchServices();
      refetchApps();
    },
    [refetchServices, refetchApps],
  );

  const setupOpened = useCallback(
    () =>
      setParams(
        (current) => {
          const sp = new URLSearchParams(current);
          sp.delete("setup");
          return sp;
        },
        { replace: true },
      ),
    [setParams],
  );

  const show = (next: { tab: OrgConnectorsTab; app?: string | null; setup?: string | null }) => {
    const sp = new URLSearchParams(params);
    sp.set("tab", next.tab);
    for (const key of ["app", "setup"] as const) {
      const value = next[key];
      if (value) sp.set(key, value);
      else sp.delete(key);
    }
    setParams(sp, { replace: true });
  };

  const error = services.error ?? apps.error ?? organization.error;
  const loading = services.data === null || apps.data === null || organization.data === null;

  return (
    <Box>
      <Typography variant="h5">Connectors and apps</Typography>
      <Tabs
        value={tab}
        onChange={(_, value: OrgConnectorsTab) => show({ tab: value })}
        sx={{ mt: 1.5, mb: 3, borderBottom: "1px solid var(--sw-border)" }}
      >
        {TABS.map((t) => (
          <Tab key={t.value} value={t.value} label={t.label} />
        ))}
      </Tabs>
      {error !== null ? (
        <Alert severity="error">{error}</Alert>
      ) : loading ? (
        <CircularProgress />
      ) : tab === "connectors" ? (
        <ConnectorsTab
          organizationName={organization.data!.name}
          services={services.data!}
          apps={apps.data!.apps}
          onSetUp={(slug) => show({ tab: "apps", app: slug, setup: slug })}
          onChanged={changed}
        />
      ) : (
        <AppsTab
          apps={apps.data!}
          openApp={openApp}
          setupFor={setupFor}
          onOpenApp={(slug) => show({ tab: "apps", app: slug })}
          onSetupDone={setupOpened}
          onChanged={changed}
        />
      )}
      <Snackbar
        open={toast !== null}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        message={toast}
      />
    </Box>
  );
}

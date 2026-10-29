import { Alert, Box, CircularProgress, Snackbar, Stack, Typography } from "@mui/material";
import { type ReactNode, useState } from "react";
import { CONNECTORS_NOT_ENABLED, type ConnectorAppScope } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { useConnectorApps } from "../../data/hooks";
import ConnectorAppCard from "./ConnectorAppCard";
import {
  cardOrder,
  missingPublicUrl,
  PUBLIC_URL_BANNER,
  sentBackTo,
} from "./connectorApps";
import { ConnectorAppScopeContext } from "./scope";

function Heading({ publicUrl }: { publicUrl: string | null }) {
  return (
    <Box mb={2}>
      <Typography variant="h5">Connectors</Typography>
      <Typography variant="body2" color="text.secondary">
        Some connectors sign in through an app you register at the vendor. Set each up once,
        for all of Switch, before anyone can connect it.
        {publicUrl !== null && ` ${sentBackTo(publicUrl)}`}
      </Typography>
    </Box>
  );
}

/** Every app of `scope`, a card each, under `heading`. Render it only where
 * the server mounts the routes it reads: `service_connections`, and for an
 * organization's apps `organization_connector_apps` too. */
export function ConnectorAppsList({
  scope,
  heading: headingOf,
}: {
  scope: ConnectorAppScope;
  heading: (publicUrl: string | null) => ReactNode;
}) {
  const { data, loading, error, refetch } = useConnectorApps(scope);
  const [checkFailures, setCheckFailures] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);

  const heading = headingOf(data?.public_url ?? null);
  if (loading && data === null)
    return (
      <>
        {heading}
        <CircularProgress />
      </>
    );
  if (error !== null)
    return (
      <>
        {heading}
        <Alert severity="error">{error}</Alert>
      </>
    );
  if (data === null) return heading;

  const missingUrl = missingPublicUrl(data.apps, data.public_url);
  return (
    <ConnectorAppScopeContext.Provider value={scope}>
      {heading}
      <Stack spacing={2}>
        {missingUrl && <Alert severity="warning">{PUBLIC_URL_BANNER}</Alert>}
        {cardOrder(data.apps, checkFailures).map((app) => (
          <ConnectorAppCard
            key={app.slug}
            app={app}
            publicUrl={data.public_url}
            checkFailure={checkFailures[app.slug] ?? null}
            onCheckFailure={(message) =>
              setCheckFailures((current) => {
                const next = { ...current };
                if (message === null) delete next[app.slug];
                else next[app.slug] = message;
                return next;
              })
            }
            onChecked={refetch}
            onChanged={(message) => {
              setToast(message);
              refetch();
            }}
          />
        ))}
        <Snackbar
          open={toast !== null}
          autoHideDuration={4000}
          onClose={() => setToast(null)}
          message={toast}
        />
      </Stack>
    </ConnectorAppScopeContext.Provider>
  );
}

/** The server operator's page: the route table lets no one else in. */
export default function ConnectorAppsPage() {
  const { capabilities } = useAuth();
  return (
    <Box>
      {capabilities.features.service_connections ? (
        <ConnectorAppsList
          scope="server"
          heading={(publicUrl) => <Heading publicUrl={publicUrl} />}
        />
      ) : (
        <>
          <Heading publicUrl={null} />
          <Alert severity="info">{CONNECTORS_NOT_ENABLED}</Alert>
        </>
      )}
    </Box>
  );
}

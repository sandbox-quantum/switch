import { Alert, Box, CircularProgress, Snackbar, Stack, Typography } from "@mui/material";
import { type ReactNode, useState } from "react";
import { CONNECTORS_NOT_ENABLED, type ConnectorAppScope } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { useConnectorApps } from "../../data/hooks";
import ConnectorAppCard from "./ConnectorAppCard";
import {
  cardOrder,
  missingPublicUrl,
  ONLY_THE_OPERATOR,
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
        for the whole server, before anyone can connect it.
        {publicUrl !== null && ` ${sentBackTo(publicUrl)}`}
      </Typography>
    </Box>
  );
}

const NOT_MOUNTED = "not mounted";

/** Every app of `scope`, a card each, under `heading`. A 404 means the
 * routes are not mounted, and shows `notEnabled`, or nothing when it is null. */
export function ConnectorAppsList({
  scope,
  notEnabled,
  heading: headingOf,
}: {
  scope: ConnectorAppScope;
  notEnabled: string | null;
  heading: (publicUrl: string | null) => ReactNode;
}) {
  const { data, loading, error, refetch } = useConnectorApps(
    scope,
    notEnabled ?? NOT_MOUNTED,
  );
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
  if (error === NOT_MOUNTED) return null;
  if (error !== null)
    return (
      <>
        {heading}
        <Alert severity={error === notEnabled ? "info" : "error"}>{error}</Alert>
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

/** The server operator's page; anyone else is told whose it is, and nothing is asked of the server. */
export default function ConnectorAppsPage() {
  const { isOperator } = useAuth();
  return (
    <Box>
      {isOperator ? (
        <ConnectorAppsList
          scope="server"
          notEnabled={CONNECTORS_NOT_ENABLED}
          heading={(publicUrl) => <Heading publicUrl={publicUrl} />}
        />
      ) : (
        <>
          <Heading publicUrl={null} />
          <Alert severity="info">{ONLY_THE_OPERATOR}</Alert>
        </>
      )}
    </Box>
  );
}

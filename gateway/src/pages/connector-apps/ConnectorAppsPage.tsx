import { Alert, Box, CircularProgress, Snackbar, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { CONNECTORS_NOT_ENABLED } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { useConnectorApps } from "../../data/hooks";
import ConnectorAppCard from "./ConnectorAppCard";
import {
  cardOrder,
  ONLY_THE_OPERATOR,
  PUBLIC_URL_BANNER,
  sentBackTo,
} from "./connectorApps";

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

function ConnectorAppsList() {
  const { data, loading, error, refetch } = useConnectorApps();
  const [checkFailures, setCheckFailures] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);

  const heading = <Heading publicUrl={data?.public_url ?? null} />;
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
        <Alert severity={error === CONNECTORS_NOT_ENABLED ? "info" : "error"}>{error}</Alert>
      </>
    );
  if (data === null) return heading;

  const missingUrl = data.public_url === null;
  return (
    <>
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
    </>
  );
}

/** The server operator's page; anyone else is told whose it is, and nothing is asked of the server. */
export default function ConnectorAppsPage() {
  const { isOperator } = useAuth();
  return (
    <Box>
      {isOperator ? (
        <ConnectorAppsList />
      ) : (
        <>
          <Heading publicUrl={null} />
          <Alert severity="info">{ONLY_THE_OPERATOR}</Alert>
        </>
      )}
    </Box>
  );
}

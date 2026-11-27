import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import { Alert, Box, Button, Card, CircularProgress, Stack, Typography } from "@mui/material";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link as RouterLink } from "react-router";
import PageBanner from "../../components/PageBanner";
import PageHeader from "../../components/PageHeader";
import { fetchProviders, providerLabel } from "../../data/management";
import AddMachineDialog from "../machines/AddMachineDialog";
import { fetchHostedMachines } from "../get-started/onboarding";
import { GET_STARTED } from "../get-started/paths";
import { DeviceProviders, PROVIDERS_KEY, deviceName, providersQueryClient, useOwnDevices } from "./DeviceProviders";

const STATE: Record<string, string> = {
  online: "Online",
  offline: "Offline",
  unknown: "Never connected",
};

/** The person's devices, each with its AI providers: where they connect a
 *  provider account to a device, as Switch Console does for a machine. */
export default function AIProvidersPage() {
  return (
    <QueryClientProvider client={providersQueryClient}>
      <AIProviders />
    </QueryClientProvider>
  );
}

function AIProviders() {
  const devices = useOwnDevices();
  const providers = useQuery({ queryKey: [...PROVIDERS_KEY, "list"], queryFn: fetchProviders });
  const hosted = useQuery({ queryKey: [...PROVIDERS_KEY, "hosted"], queryFn: fetchHostedMachines });
  const [addOpen, setAddOpen] = useState(false);
  const label = (provider: string) => providerLabel(providers.data ?? [], provider);
  const list = devices.data ?? [];
  const cloudToSetUp = hosted.data?.available === true && !list.some((device) => device.kind === "ec2");

  let body;
  if (devices.isPending) body = <CircularProgress aria-label="Loading your devices" />;
  else if (devices.isError && list.length === 0)
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void devices.refetch()}>
            Retry
          </Button>
        }
      >
        Couldn't load your devices: {devices.error.message}
      </Alert>
    );
  else
    body = (
      <Stack spacing={2}>
        {list.length === 0 && !cloudToSetUp && (
          <Card variant="outlined" sx={{ borderRadius: "16px", px: 3, py: 4 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              You have no devices yet
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Add a computer that runs your agents, then connect its AI providers here.
            </Typography>
          </Card>
        )}
        {list.map((device) => (
          <Card key={device.id} variant="outlined" sx={{ borderRadius: "16px", p: 2.5 }}>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: "baseline", mb: 1.5 }}>
              <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
                {deviceName(device)}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {STATE[device.state] ?? device.state}
              </Typography>
            </Stack>
            <DeviceProviders device={device} label={label} />
          </Card>
        ))}
        {cloudToSetUp && (
          <Card variant="outlined" sx={{ borderRadius: "16px", p: 2.5 }}>
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
              Switch Cloud
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Your Switch Cloud device isn't set up yet. Set it up, then connect an AI provider to it here.
            </Typography>
            <Button variant="outlined" component={RouterLink} to={GET_STARTED}>
              Set up Switch Cloud
            </Button>
          </Card>
        )}
      </Stack>
    );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <PageHeader
        sx={{ mb: 3 }}
        title={<Typography variant="h5">AI providers</Typography>}
        description={
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Connect your AI provider accounts to your devices, so the agents there can use them. A login you give is
            sealed in this browser for that one device: Switch only passes it on.
          </Typography>
        }
        actions={
          <Button variant="contained" startIcon={<AddCircleOutline />} onClick={() => setAddOpen(true)}>
            Add device
          </Button>
        }
      />
      <Stack spacing={2} sx={{ mb: 2, "&:empty": { display: "none" } }}>
        {devices.isError && list.length > 0 && (
          <PageBanner tone="warning">
            Couldn't refresh your devices: {devices.error.message}. This is the list as last loaded.
          </PageBanner>
        )}
        {providers.isError && (
          <PageBanner tone="warning">
            Couldn't load the names of the AI providers, so they show by id: {providers.error.message}
          </PageBanner>
        )}
        {hosted.isError && (
          <PageBanner tone="warning">
            Couldn't check for Switch Cloud, so it may be missing: {hosted.error.message}
          </PageBanner>
        )}
      </Stack>
      {body}
      <AddMachineDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </Box>
  );
}

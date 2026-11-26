import { Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle } from "@mui/material";
import { QueryClientProvider } from "@tanstack/react-query";
import { DeviceProviders, deviceName, providersQueryClient, useOwnDevices } from "./DeviceProviders";

/** One of the person's devices' AI providers, opened from its row in Settings › Devices. */
export default function DeviceProvidersDialog({
  deviceId,
  open,
  label,
  onClose,
}: {
  deviceId: string | null;
  open: boolean;
  label: (provider: string) => string;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <QueryClientProvider client={providersQueryClient}>
        {deviceId !== null && <Providers deviceId={deviceId} label={label} />}
      </QueryClientProvider>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function Providers({ deviceId, label }: { deviceId: string; label: (provider: string) => string }) {
  const devices = useOwnDevices();
  const device = devices.data?.find((each) => each.id === deviceId);
  return (
    <>
      <DialogTitle>{device ? `AI providers on ${deviceName(device)}` : "AI providers"}</DialogTitle>
      <DialogContent>
        {device ? (
          <DeviceProviders device={device} label={label} />
        ) : devices.isPending ? (
          <CircularProgress aria-label="Loading the device" />
        ) : (
          <Alert severity="error">
            {devices.isError
              ? `Couldn't load your devices: ${devices.error.message}`
              : "This device is no longer one of yours."}
          </Alert>
        )}
      </DialogContent>
    </>
  );
}

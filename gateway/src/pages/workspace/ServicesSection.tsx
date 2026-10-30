import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { useCallback, useState } from "react";
import { type WorkspaceService, fetchWorkspaceServices, setWorkspaceService } from "../../data/api";
import { formatDate } from "../../theme/hootFormat";
import { serviceStanding, serviceSwitchNote, switchOffConfirmation } from "./serviceCopy";
import { useLoad } from "./useLoad";

type Outcome = { warning: string | null; error: string | null };

/**
 * A workspace admin's switch for each service the server offers. Off, nobody
 * in the workspace can connect it, grant it to an agent or be issued a token
 * for it, and running sessions lose it; grants are kept.
 *
 * Switching off something anyone uses asks first, naming who. A switch shows
 * what the server says: it never flips before the server has answered, and a
 * failure leaves it as it was, with the reason under it.
 */
export default function ServicesSection() {
  const { data: services, error, loading, refetch } = useLoad(fetchWorkspaceServices);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [confirming, setConfirming] = useState<WorkspaceService | null>(null);

  const change = useCallback(
    async (service: WorkspaceService, enabled: boolean) => {
      setPending((now) => new Set(now).add(service.slug));
      setOutcomes((now) => ({ ...now, [service.slug]: { warning: null, error: null } }));
      try {
        const result = await setWorkspaceService(service.slug, enabled);
        setOutcomes((now) => ({
          ...now,
          [service.slug]: { warning: result.warning, error: null },
        }));
        await refetch();
      } catch (err) {
        const fallback = `Could not switch ${service.name} ${enabled ? "on" : "off"} for the workspace.`;
        setOutcomes((now) => ({
          ...now,
          [service.slug]: { warning: null, error: err instanceof Error ? err.message : fallback },
        }));
      } finally {
        setPending((now) => {
          const next = new Set(now);
          next.delete(service.slug);
          return next;
        });
      }
    },
    [refetch],
  );

  const flip = (service: WorkspaceService, enabled: boolean) => {
    if (!enabled && switchOffConfirmation(service)) setConfirming(service);
    else void change(service, enabled);
  };
  const asked = confirming ? switchOffConfirmation(confirming) : null;

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Services</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Which services people in this workspace can connect and give their agents.
      </Typography>
      {loading ? (
        <CircularProgress size={24} />
      ) : error ? (
        <Alert severity="error">{error}</Alert>
      ) : services && services.length === 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          This server offers no services to switch.
        </Typography>
      ) : (
        services && (
          <Paper variant="outlined">
            <List dense disablePadding>
              {services.map((service) => {
                const outcome = outcomes[service.slug];
                const busy = pending.has(service.slug);
                return (
                  <ListItem
                    key={service.slug}
                    divider
                    secondaryAction={
                      <Stack direction="row" alignItems="center" spacing={1}>
                        {busy && <CircularProgress size={16} />}
                        <Switch
                          checked={service.enabled}
                          disabled={busy}
                          onChange={(e) => flip(service, e.target.checked)}
                          slotProps={{
                            input: { "aria-label": `${service.name} for this workspace` },
                          }}
                        />
                      </Stack>
                    }
                  >
                    <ListItemText
                      primary={service.name}
                      secondary={
                        <>
                          {serviceStanding(service)}
                          <br />
                          {serviceSwitchNote(service, formatDate)}
                          {outcome?.warning && (
                            <Typography
                              component="span"
                              role="status"
                              variant="body2"
                              sx={{ display: "block", color: "warning.main" }}
                            >
                              {outcome.warning}
                            </Typography>
                          )}
                          {outcome?.error && (
                            <Typography
                              component="span"
                              role="alert"
                              variant="body2"
                              sx={{ display: "block", color: "error.main" }}
                            >
                              {outcome.error}
                            </Typography>
                          )}
                        </>
                      }
                    />
                  </ListItem>
                );
              })}
            </List>
          </Paper>
        )
      )}
      <Dialog open={asked !== null} onClose={() => setConfirming(null)}>
        <DialogTitle>{asked?.title}</DialogTitle>
        <DialogContent>
          <DialogContentText>{asked?.description}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              const service = confirming;
              setConfirming(null);
              if (service) void change(service, false);
            }}
          >
            Switch off
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

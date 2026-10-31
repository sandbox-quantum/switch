import {
  Alert,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { useCallback, useState } from "react";
import {
  type OrganizationService,
  clearOrganizationService,
  fetchOrganizationServices,
  setOrganizationService,
} from "../../data/api";
import { formatDate } from "../../theme/hootFormat";
import { useLoad } from "../workspace/useLoad";

type Choice = "none" | "on" | "off";

const CHOICE_LABELS: Record<Choice, string> = {
  none: "Each workspace decides",
  on: "On",
  off: "Off",
};

function choiceOf(service: OrganizationService): Choice {
  if (service.setting === null) return "none";
  return service.setting.enabled ? "on" : "off";
}

/** "On in 2 of 3 workspaces · 1 sets its own · 4 people connected · set by Ada, 1 Oct 2026". */
export function reachText(service: OrganizationService, workspaces: number): string {
  if (service.server_switched_off !== null) return service.server_switched_off;
  const parts = [
    `On in ${service.workspaces_on} of ${workspaces} workspace${workspaces === 1 ? "" : "s"}`,
  ];
  // An unlocked setting doesn't reach a workspace that set its own.
  if (service.workspaces_set_own > 0 && !service.setting?.locked)
    parts.push(
      `${service.workspaces_set_own} ${service.workspaces_set_own === 1 ? "sets its" : "set their"} own`,
    );
  if (service.connected_members > 0)
    parts.push(
      `${service.connected_members} ${service.connected_members === 1 ? "person" : "people"} connected`,
    );
  if (service.updated_by_name && service.updated_at)
    parts.push(`set by ${service.updated_by_name}, ${formatDate(service.updated_at)}`);
  return parts.join(" · ");
}

/** Each catalog service, on or off for every workspace in the organization,
 * and whether workspace admins may change it. Unlocked, the setting is the
 * default each workspace may override; locked, it is out of their reach.
 * Shown only where the server lets organizations have this say. */
export default function OrganizationServicesSection() {
  const load = useCallback(() => fetchOrganizationServices(), []);
  const { data, error, errorStatus, loading, refetch } = useLoad(load);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionWarning, setActionWarning] = useState<string | null>(null);

  const act = useCallback(
    async (slug: string, action: () => Promise<{ warning: string | null }>) => {
      setBusy(slug);
      setActionError(null);
      setActionWarning(null);
      try {
        const { warning } = await action();
        setActionWarning(warning);
        await refetch();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "The change failed");
      } finally {
        setBusy(null);
      }
    },
    [refetch],
  );

  // The routes are mounted only where organizations have this say.
  if (errorStatus === 404) return null;

  const choose = (service: OrganizationService, choice: Choice) =>
    act(service.slug, () =>
      choice === "none"
        ? clearOrganizationService(service.slug)
        : setOrganizationService(service.slug, {
            enabled: choice === "on",
            locked: service.setting?.locked ?? false,
          }),
    );

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Services</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Switch a service on or off for the workspaces in the organization. Unlocked, your
        setting applies only where a workspace admin hasn&apos;t set the service themselves, and
        they can still change it. Locked, it applies to every workspace and they can&apos;t.
        Switching a service off keeps agents&apos; grants, and gives them back when it is
        switched on again.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {actionError && (
        <Alert severity="error" onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      {actionWarning && (
        <Alert severity="warning" onClose={() => setActionWarning(null)}>
          {actionWarning}
        </Alert>
      )}
      {loading ? (
        <CircularProgress />
      ) : (
        data?.services.map((service) => {
          const choice = choiceOf(service);
          return (
            <Paper
              key={service.slug}
              variant="outlined"
              sx={{ p: 1.5 }}
              data-testid={`organization-service-${service.slug}`}
            >
              <Stack direction="row" alignItems="center" spacing={1.5}>
                <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                  {service.name}
                </Typography>
                <Select
                  size="small"
                  value={choice}
                  disabled={busy !== null}
                  onChange={(e) => void choose(service, e.target.value as Choice)}
                  inputProps={{ "aria-label": `${service.name} for the organization` }}
                  sx={{ fontSize: "0.875rem", minWidth: 190 }}
                >
                  {(Object.keys(CHOICE_LABELS) as Choice[]).map((value) => (
                    <MenuItem key={value} value={value}>
                      {CHOICE_LABELS[value]}
                    </MenuItem>
                  ))}
                </Select>
                <FormControlLabel
                  label="Locked"
                  control={
                    <Checkbox
                      size="small"
                      checked={service.setting?.locked ?? false}
                      disabled={busy !== null || service.setting === null}
                      onChange={(_, locked) => {
                        const setting = service.setting;
                        if (setting === null) return;
                        void act(service.slug, () =>
                          setOrganizationService(service.slug, { enabled: setting.enabled, locked }),
                        );
                      }}
                      inputProps={{ "aria-label": `Lock ${service.name}` }}
                    />
                  }
                />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {reachText(service, data.workspaces)}
              </Typography>
            </Paper>
          );
        })
      )}
    </Stack>
  );
}

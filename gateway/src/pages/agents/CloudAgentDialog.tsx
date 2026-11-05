import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { type CloudMachine, ensureCloudMachine, fetchCloudMachine } from "../../data/hostedCloud";
import {
  type Controller,
  createManagedAgent,
  fetchControllers,
  fetchProviders,
  type ManagedAgent,
  type ProviderInfo,
} from "../../data/management";
import {
  AGENT_NAME_PATTERN,
  boxPlacement,
  type BoxPlacement,
  type CloudAgentForm,
  cloudAgentFormValid,
  cloudAgentRequest,
  cloudProviders,
} from "./cloudAgent";

/** How often the box is looked at while it starts. */
export const BOX_POLL_MS = 5000;

const EMPTY: CloudAgentForm = { name: "", description: "", provider: "", model: "", instructions: "" };

/**
 * Add agent on Switch cloud (hosted agents v2, Switch web). Opening it asks
 * Switch for the person's box (ensure: it claims one, or wakes a sleeping or
 * put-away one), then watches until the box's own controller is online, and
 * puts the new agent there. Asking on opening is what Console's Add agent does
 * too: choosing Switch cloud there runs ensure at once, and the form wakes a
 * resting or put-away box when it opens (`new-agent-form.tsx`), so the box is
 * warm by the time the form is filled in. A box its owner stopped is left
 * stopped by ensure, and the dialog says to start it from Your cloud. Nothing here picks a machine from the person's
 * machines list: the box is its `controller_id`, as Core names it.
 */
export default function CloudAgentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (agent: ManagedAgent) => void;
}) {
  const [form, setForm] = useState<CloudAgentForm>(EMPTY);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [placement, setPlacement] = useState<BoxPlacement>({ kind: "starting" });
  const [ensureError, setEnsureError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    if (!open) return;
    const mine = ++generation.current;
    setForm(EMPTY);
    fetchProviders().then(
      (listed) => {
        if (mine !== generation.current) return;
        const offered = cloudProviders(listed);
        setProviders(offered);
        setForm((current) => (current.provider ? current : { ...current, provider: offered[0]?.id ?? "" }));
      },
      () => {
        if (mine === generation.current) setProviders([]);
      },
    );
    setPlacement({ kind: "starting" });
    setEnsureError(null);
    setSaveError(null);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const look = async (machine: CloudMachine | null) => {
      let controllers: Controller[] = [];
      try {
        const owned = machine ?? (await fetchCloudMachine());
        controllers = await fetchControllers();
        if (mine !== generation.current) return;
        const next = boxPlacement(owned, controllers);
        setPlacement(next);
        if (next.kind === "starting") timer = setTimeout(() => void look(null), BOX_POLL_MS);
      } catch {
        if (mine !== generation.current) return;
        timer = setTimeout(() => void look(null), BOX_POLL_MS);
      }
    };
    ensureCloudMachine().then(
      (machine) => void look(machine),
      (error: unknown) => {
        if (mine !== generation.current) return;
        setEnsureError(error instanceof Error ? error.message : "Switch couldn't start your cloud.");
      },
    );
    return () => {
      generation.current += 1;
      if (timer) clearTimeout(timer);
    };
  }, [open]);

  const set = <K extends keyof CloudAgentForm>(key: K, value: CloudAgentForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const ready = placement.kind === "ready";
  const canCreate = ready && cloudAgentFormValid(form) && !saving;

  const create = async () => {
    if (placement.kind !== "ready") return;
    setSaving(true);
    setSaveError(null);
    try {
      const agent = await createManagedAgent(cloudAgentRequest(form, placement.controllerId));
      onCreated(agent);
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add agent on Switch cloud</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {ensureError ? (
            <Alert severity="error">{ensureError}</Alert>
          ) : placement.kind === "starting" ? (
            <Stack direction="row" spacing={1} alignItems="center" role="status">
              <CircularProgress size={16} />
              <Typography variant="body2">Starting your Switch cloud. This can take a minute or two.</Typography>
            </Stack>
          ) : placement.kind === "stopped" ? (
            <Alert severity="info">
              Your Switch cloud is stopped. Start it from Your cloud, then add the agent.
            </Alert>
          ) : placement.kind === "error" ? (
            <Alert severity="error">{placement.message}</Alert>
          ) : (
            <Alert severity="success">Your Switch cloud is ready.</Alert>
          )}
          {saveError && <Alert severity="error">{saveError}</Alert>}
          <TextField
            label="Name"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            error={form.name !== "" && !AGENT_NAME_PATTERN.test(form.name)}
            helperText="Lowercase letters, digits, '.', '-' and '_'. How the agent is addressed in rooms."
            required
            autoFocus
          />
          <TextField
            label="Description"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            required
          />
          <TextField
            select
            label="Provider"
            value={form.provider}
            onChange={(e) => set("provider", e.target.value)}
            helperText={providers.length === 0 ? "Loading the providers this server runs…" : undefined}
          >
            {providers.map((p) => (
              <MenuItem key={p.id} value={p.id}>
                {p.label}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Model"
            value={form.model}
            onChange={(e) => set("model", e.target.value)}
            helperText="Leave empty for the provider's default."
          />
          <TextField
            label="Instructions"
            value={form.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            multiline
            minRows={3}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={create}
          disabled={!canCreate}
          startIcon={saving ? <CircularProgress size={16} /> : undefined}
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

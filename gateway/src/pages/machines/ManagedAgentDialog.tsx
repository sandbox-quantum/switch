import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
} from "@mui/material";
import { useState } from "react";
import {
  type Controller,
  type Definition,
  type Isolation,
  type DesiredState,
  type ManagedAgent,
  type Provider,
  type ProviderInfo,
  updateManagedAgent,
} from "../../data/management";

interface Form {
  controllerId: string;
  provider: Provider;
  model: string;
  instructions: string;
  directory: string;
  autoMode: boolean;
  autoApprove: boolean;
  isolation: Isolation;
  /** Not edited here; kept as it is so saving does not clear it. */
  advancedConfig: Definition["advanced_config"];
  running: boolean;
}

function initialForm(agent: ManagedAgent): Form {
  return {
    controllerId: agent.controller_id ?? "",
    provider: agent.definition.provider,
    model: agent.definition.model ?? "",
    instructions: agent.definition.instructions,
    directory: agent.definition.directory ?? "",
    autoMode: agent.definition.auto_mode,
    autoApprove: agent.definition.auto_approve,
    isolation: agent.definition.isolation,
    advancedConfig: agent.definition.advanced_config,
    running: agent.desired_state === "running",
  };
}

function definitionFrom(form: Form): Definition {
  return {
    provider: form.provider,
    model: form.model.trim() || null,
    instructions: form.instructions,
    auto_mode: form.autoMode,
    auto_approve: form.autoApprove,
    directory: form.directory.trim() || null,
    isolation: form.isolation,
    advanced_config: form.advancedConfig,
  };
}

/**
 * Edits a managed agent: its definition, the device it runs on, and whether
 * it should be running. Refusals (an offline device, a provider that is not
 * installed or not signed in there) are shown as Switch words them.
 */
export default function ManagedAgentDialog({
  open,
  agent,
  controllers,
  providers,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The agent to edit; null while none is. */
  agent: ManagedAgent | null;
  controllers: Controller[];
  /** The providers Switch runs; empty until they have loaded. */
  providers: ProviderInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open && agent !== null} onClose={onClose} maxWidth="sm" fullWidth>
      {agent && (
        <EditManagedAgent
          key={agent.agent_id}
          agent={agent}
          controllers={controllers}
          providers={providers}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  );
}

function EditManagedAgent({
  agent,
  controllers,
  providers,
  onClose,
  onSaved,
}: {
  agent: ManagedAgent;
  controllers: Controller[];
  providers: ProviderInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // Read once per agent, not on every status refresh.
  const [form, setForm] = useState<Form>(() => initialForm(agent));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const placeable = controllers.filter((c) => c.state !== "revoked" || c.id === agent.controller_id);
  const canSave = form.provider !== "" && !saving;
  // An agent keeps its provider even if Switch no longer lists it.
  const providerChoices =
    form.provider === "" || providers.some((p) => p.id === form.provider)
      ? providers
      : [...providers, { id: form.provider, label: form.provider, advanced_fields: [] }];

  const save = async () => {
    setSaving(true);
    setError(null);
    const desired: DesiredState = form.running ? "running" : "stopped";
    try {
      await updateManagedAgent(agent.agent_id, {
        definition: definitionFrom(form),
        desired_state: desired,
        controller_id: form.controllerId || null,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogTitle>{`Edit ${agent.name}`}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            select
            label="Device"
            value={form.controllerId}
            onChange={(e) => set("controllerId", e.target.value)}
            helperText={
              placeable.length === 0
                ? "No device yet: add one first, or save the agent unplaced."
                : "Where the agent runs."
            }
          >
            <MenuItem value="">
              <em>Not placed</em>
            </MenuItem>
            {placeable.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name} ({c.state})
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Provider"
            value={form.provider}
            onChange={(e) => set("provider", e.target.value as Provider)}
            helperText={providers.length === 0 ? "Loading providers…" : undefined}
          >
            {providerChoices.map((p) => (
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
          <TextField
            label="Working directory"
            value={form.directory}
            onChange={(e) => set("directory", e.target.value)}
            helperText="An absolute path that exists on the device. Empty uses a workspace the controller creates."
          />
          <TextField
            select
            label="Isolation"
            value={form.isolation}
            onChange={(e) => set("isolation", e.target.value as Isolation)}
            helperText="Cloud devices run every agent isolated."
          >
            <MenuItem value="shared">Shared: runs inside the device's controller</MenuItem>
            <MenuItem value="isolated">Isolated: runs as a process of its own</MenuItem>
          </TextField>
          <FormControlLabel
            control={
              <Switch
                checked={form.autoMode}
                disabled={form.autoApprove}
                onChange={(e) => set("autoMode", e.target.checked)}
              />
            }
            label="Auto mode (the provider reviews each action: safe ones run, risky ones still ask)"
          />
          <FormControlLabel
            control={
              <Switch
                checked={form.autoApprove}
                onChange={(e) => set("autoApprove", e.target.checked)}
              />
            }
            label="Bypass permissions (unsafe: runs every action without asking; overrides auto mode)"
          />
          <FormControlLabel
            control={
              <Switch checked={form.running} onChange={(e) => set("running", e.target.checked)} />
            }
            label="Running"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={save}
          disabled={!canSave}
          startIcon={saving ? <CircularProgress size={16} /> : undefined}
        >
          Save
        </Button>
      </DialogActions>
    </>
  );
}

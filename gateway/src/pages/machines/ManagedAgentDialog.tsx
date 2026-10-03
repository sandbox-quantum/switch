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
import { useEffect, useState } from "react";
import {
  type Controller,
  createManagedAgent,
  type Definition,
  type DesiredState,
  type ManagedAgent,
  PROVIDERS,
  type Provider,
  updateManagedAgent,
} from "../../data/management";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

interface Form {
  name: string;
  description: string;
  controllerId: string;
  provider: Provider;
  model: string;
  instructions: string;
  directory: string;
  autoSession: boolean;
  autoApprove: boolean;
  running: boolean;
}

function initialForm(agent: ManagedAgent | null, controllers: Controller[]): Form {
  if (agent)
    return {
      name: agent.name,
      description: agent.description,
      controllerId: agent.controller_id ?? "",
      provider: agent.definition.provider,
      model: agent.definition.model ?? "",
      instructions: agent.definition.instructions,
      directory: agent.definition.directory ?? "",
      autoSession: agent.definition.auto_session,
      autoApprove: agent.definition.auto_approve,
      running: agent.desired_state === "running",
    };
  const online = controllers.find((c) => c.state === "online");
  return {
    name: "",
    description: "",
    controllerId: online?.id ?? "",
    provider: "claude",
    model: "",
    instructions: "",
    directory: "",
    autoSession: true,
    autoApprove: false,
    running: true,
  };
}

function definitionFrom(form: Form): Definition {
  return {
    provider: form.provider,
    model: form.model.trim() || null,
    instructions: form.instructions,
    auto_session: form.autoSession,
    auto_approve: form.autoApprove,
    directory: form.directory.trim() || null,
  };
}

/**
 * Creates a managed agent, or edits one: its definition, the machine it runs
 * on, and whether it should be running. Server refusals (an offline machine,
 * a provider that is not installed or not logged in there) are shown as the
 * server words them.
 */
export default function ManagedAgentDialog({
  open,
  agent,
  controllers,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The agent to edit, or null to create one. */
  agent: ManagedAgent | null;
  controllers: Controller[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Form>(() => initialForm(agent, controllers));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(initialForm(agent, controllers));
    setError(null);
    // Reset only when the dialog opens or switches agent, not on every status refresh.
  }, [open, agent?.agent_id]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const placeable = controllers.filter(
    (c) => c.state !== "revoked" || c.id === agent?.controller_id,
  );
  const nameValid = agent !== null || NAME_PATTERN.test(form.name);
  const canSave =
    nameValid && (agent !== null || form.description.trim() !== "") && !saving;

  const save = async () => {
    setSaving(true);
    setError(null);
    const desired: DesiredState = form.running ? "running" : "stopped";
    const controllerId = form.controllerId || null;
    try {
      if (agent === null)
        await createManagedAgent({
          name: form.name,
          description: form.description.trim(),
          display_name: null,
          controller_id: controllerId,
          desired_state: desired,
          definition: definitionFrom(form),
        });
      else
        await updateManagedAgent(agent.agent_id, {
          definition: definitionFrom(form),
          desired_state: desired,
          controller_id: controllerId,
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
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{agent ? `Edit ${agent.name}` : "New managed agent"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          {agent === null && (
            <>
              <TextField
                label="Name"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                error={form.name !== "" && !nameValid}
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
            </>
          )}
          <TextField
            select
            label="Machine"
            value={form.controllerId}
            onChange={(e) => set("controllerId", e.target.value)}
            helperText={
              placeable.length === 0
                ? "No machine yet: add one first, or save the agent unplaced."
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
          >
            {PROVIDERS.map((p) => (
              <MenuItem key={p.value} value={p.value}>
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
            helperText="An absolute path that exists on the machine. Empty uses a workspace the controller creates."
          />
          <FormControlLabel
            control={
              <Switch
                checked={form.autoSession}
                onChange={(e) => set("autoSession", e.target.checked)}
              />
            }
            label="Start a session when addressed"
          />
          <FormControlLabel
            control={
              <Switch
                checked={form.autoApprove}
                onChange={(e) => set("autoApprove", e.target.checked)}
              />
            }
            label="Auto-approve tool use (runs the CLI without permission prompts)"
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
          {agent ? "Save" : "Create"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

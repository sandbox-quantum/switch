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
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listCloudLogins,
  listOperations,
  type LoginStatus,
  loginStatus,
  OPERATION_POLL_MS,
} from "../../data/cloudLogins";
import { type CloudMachine, ensureCloudMachine, fetchCloudMachine } from "../../data/hostedCloud";
import {
  type Controller,
  createManagedAgent,
  fetchControllers,
  fetchProviders,
  ManagementApiError,
  type ManagedAgent,
  type ProviderInfo,
} from "../../data/management";
import CloudLoginDialog from "./cloud/CloudLoginDialog";
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

/** When the person's cloud machine isn't a v2 box: Switch web can't add an agent to it. */
export const NOT_A_BOX = "Your cloud machine can't take agents from Switch web. Use Switch Console for this machine.";

/** Fixed words for the chosen provider's login on the box: Core places an agent only where its provider is signed in. */
export const LOGIN_FIRST = {
  checking: (label: string) => `Checking your ${label} login on your cloud…`,
  none: (label: string) => `Give your ${label} login first. Your cloud needs it before it can run a ${label} agent.`,
  waiting: (label: string) => `Waiting for your cloud to sign in with your ${label} login.`,
  failed: (label: string) => `Your cloud couldn't sign in with your ${label} login. Give it again.`,
  unreadable: (label: string) => `Switch couldn't check your ${label} login on your cloud. Try again.`,
} as const;

/** Core's refusals when the provider isn't signed in on the box, in fixed words, never Core's own text. */
export const CREATE_REFUSED: Record<string, string> = {
  provider_login_missing: "Your cloud doesn't have a login for this provider yet. Give it first, then create the agent.",
  provider_login_expired: "The login for this provider on your cloud has expired. Give it again, then create the agent.",
};

type LoginCheck = LoginStatus | "checking" | "unreadable";

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
 *
 * Core places an agent only where its provider is signed in, so once the box
 * is ready the chosen provider's login is read, and Create stays off until the
 * box has confirmed it ("set"). Until then the dialog asks for it first, with
 * the same login dialog the logins panel uses.
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
  const [machine, setMachine] = useState<CloudMachine | null>(null);
  const [login, setLogin] = useState<LoginCheck>("checking");
  const [giving, setGiving] = useState(false);
  const [loginReads, setLoginReads] = useState(0);
  const generation = useRef(0);
  const loginFor = useRef("");

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
    setMachine(null);
    setGiving(false);
    loginFor.current = "";
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
        setMachine(owned);
        if (next.kind === "starting") timer = setTimeout(() => void look(null), BOX_POLL_MS);
      } catch {
        if (mine !== generation.current) return;
        timer = setTimeout(() => void look(null), BOX_POLL_MS);
      }
    };
    ensureCloudMachine().then(
      (machine) => {
        if (mine !== generation.current) return;
        // Not a v2 box (a v1 cloud machine): nothing here can use it, so say
        // where to go and stop, rather than waiting for a box that won't come.
        if (machine === null) setPlacement({ kind: "error", message: NOT_A_BOX });
        else void look(machine);
      },
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
  const controllerId = placement.kind === "ready" ? placement.controllerId : null;
  const provider = form.provider;
  const providerLabel = providers.find((p) => p.id === provider)?.label ?? provider;
  const readLogin = useCallback(() => setLoginReads((n) => n + 1), []);

  // The chosen provider's login on the box, read once it's ready, again when
  // the provider changes or a login is given, and every few seconds while the
  // box is still signing in with it.
  useEffect(() => {
    if (!open || controllerId === null || !provider) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A new box or provider starts from "checking"; a re-read keeps what's shown.
    const key = `${controllerId}/${provider}`;
    if (loginFor.current !== key) {
      loginFor.current = key;
      setLogin("checking");
    }
    Promise.all([listCloudLogins(controllerId), listOperations(controllerId)]).then(
      ([logins, operations]) => {
        if (!live) return;
        const status = loginStatus(provider, logins, operations);
        setLogin(status);
        if (status === "waiting") timer = setTimeout(readLogin, OPERATION_POLL_MS);
      },
      () => live && setLogin("unreadable"),
    );
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [open, controllerId, provider, loginReads, readLogin]);

  const canCreate = ready && login === "set" && cloudAgentFormValid(form) && !saving;

  const create = async () => {
    if (placement.kind !== "ready") return;
    setSaving(true);
    setSaveError(null);
    try {
      const agent = await createManagedAgent(cloudAgentRequest(form, placement.controllerId));
      onCreated(agent);
      onClose();
    } catch (error) {
      const refused = error instanceof ManagementApiError ? CREATE_REFUSED[error.code] : undefined;
      if (refused) {
        setSaveError(refused);
        // The box's login has gone or lapsed since it was read: read it again.
        readLogin();
      } else setSaveError(error instanceof Error ? error.message : String(error));
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
          {ready && provider && login !== "set" && (
            <Alert
              severity={login === "failed" || login === "missed" || login === "unreadable" ? "warning" : "info"}
              data-testid="login-first"
              action={
                login === "checking" || login === "waiting" ? undefined : login === "unreadable" ? (
                  <Button color="inherit" size="small" onClick={readLogin}>
                    Try again
                  </Button>
                ) : (
                  <Button color="inherit" size="small" onClick={() => setGiving(true)}>
                    Give {providerLabel} login
                  </Button>
                )
              }
            >
              {login === "checking"
                ? LOGIN_FIRST.checking(providerLabel)
                : login === "waiting"
                  ? LOGIN_FIRST.waiting(providerLabel)
                  : login === "failed" || login === "missed"
                    ? LOGIN_FIRST.failed(providerLabel)
                    : login === "unreadable"
                      ? LOGIN_FIRST.unreadable(providerLabel)
                      : LOGIN_FIRST.none(providerLabel)}
            </Alert>
          )}
          {saveError && <Alert severity="error">{saveError}</Alert>}
          <TextField
            label="Name"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            error={form.name !== "" && !AGENT_NAME_PATTERN.test(form.name)}
            helperText="Lowercase letters, digits, '.', '-' and '_'. How the agent is addressed in rooms. This can't be changed later."
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
      {machine && (
        <CloudLoginDialog
          open={giving}
          provider={provider}
          providerLabel={providerLabel}
          machine={machine}
          onCloudChanged={readLogin}
          onClose={() => {
            setGiving(false);
            readLogin();
          }}
          onDone={readLogin}
        />
      )}
    </Dialog>
  );
}

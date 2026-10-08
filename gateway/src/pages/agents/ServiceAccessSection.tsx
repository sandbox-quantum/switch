import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import {
  type AgentDetail,
  ApiError,
  fetchGitHubConnection,
  fetchServiceConnections,
  fetchServiceGrants,
  type GitHubConnection,
  type GitHubInstallation,
  OWNER_ONLY_POLICY,
  removeServiceGrant,
  type ServiceConnection,
  type ServiceGrant,
  type ServiceGrants,
  setServiceGrant,
  updateAgentAddressingPolicy,
} from "../../data/api";

type Access = "read" | "write";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function repositoryIds(resources: Record<string, unknown>): number[] {
  const ids = resources.repository_ids;
  return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === "number") : [];
}

function installationOf(
  github: GitHubConnection | null,
  resources: Record<string, unknown>,
): GitHubInstallation | null {
  if (github?.status !== "connected") return null;
  return github.installations.find((i) => i.id === resources.installation_id) ?? null;
}

/** The repositories a GitHub grant names, by name where the person can still see them. */
function repositoryNames(github: GitHubConnection | null, grant: ServiceGrant): string[] {
  const installation = installationOf(github, grant.resources);
  return repositoryIds(grant.resources).map((id) => {
    const repository = installation?.repositories.find((r) => r.id === id);
    return repository ? `${installation!.account}/${repository.name}` : `repository ${id}`;
  });
}

/**
 * What an agent may use of its owner's service connections, shown to the
 * owner alone, who is the only one who can see or change it. GitHub's grant
 * names repositories, from its picker; a service whose agents use the owner's
 * own token is on or off, and says why when it cannot be turned on. Says
 * plainly who else can reach the agent, and so its grants, and what a GitHub
 * grant does and does not change on the machine it runs on.
 */
export default function ServiceAccessSection({
  agent,
  onAgentUpdated,
}: {
  agent: AgentDetail;
  onAgentUpdated: () => void;
}) {
  const [grants, setGrants] = useState<ServiceGrants | null>(null);
  const [hidden, setHidden] = useState(false);
  const [github, setGitHub] = useState<GitHubConnection | null>(null);
  const [githubError, setGitHubError] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceConnection[]>([]);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setGrants(await fetchServiceGrants(agent.id));
    } catch (err) {
      // Someone else's agent: its grants are its owner's business.
      if (err instanceof ApiError && err.status === 404) setHidden(true);
      else setError(errorText(err));
    }
  }, [agent.id]);

  const loadServices = useCallback(async () => {
    try {
      setServices(await fetchServiceConnections());
    } catch (err) {
      setServicesError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadServices();
    fetchGitHubConnection().then(setGitHub, (err: unknown) => setGitHubError(errorText(err)));
  }, [load, loadServices]);

  if (hidden) return null;

  const act = async (run: () => Promise<{ warning?: string | null } | void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await run();
      if (result && result.warning) setNotice(result.warning);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const githubGrant = grants?.grants.find((g) => g.service === "github") ?? null;
  // Services whose agents use the owner's own token: on or off, nothing to choose.
  const onOff = services.filter((service) => service.enabled && service.pass_through);
  const onOffSlugs = new Set(onOff.map((service) => service.slug));

  return (
    <>
      <Divider />
      <Stack spacing={1.5}>
        <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
          Service access
        </Typography>
        <Typography variant="body2" color="text.secondary">
          What this agent may use of your own connections. Its sessions are given
          short-lived access for what you grant, and nothing else.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {notice && <Alert severity="info">{notice}</Alert>}
        {grants === null && !error && <CircularProgress size={20} />}

        {grants?.addressing_open && grants.grants.length > 0 && (
          <Alert
            severity="warning"
            action={
              <Button
                color="inherit"
                size="small"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await updateAgentAddressingPolicy(agent.id, OWNER_ONLY_POLICY);
                    onAgentUpdated();
                  })
                }
              >
                Make owner-only
              </Button>
            }
          >
            Anyone who can address {agent.name} can have it use these grants. Owner-only
            stops that, but it still reads what others write in shared rooms, can be
            reached through your other agents that are open, and posts results to
            shared rooms.
          </Alert>
        )}

        {grants?.missing.map((missing) => (
          <Alert
            key={missing.service}
            severity="warning"
            action={
              <Button
                color="inherit"
                size="small"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    setServiceGrant(agent.id, missing.service, {
                      access: missing.access,
                      resources: missing.resources,
                    }),
                  )
                }
              >
                Grant it
              </Button>
            }
          >
            {missing.reason}
          </Alert>
        ))}

        {grants?.grants.filter((grant) => !onOffSlugs.has(grant.service)).map((grant) => (
          <Paper key={grant.service} variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                {grant.name}
              </Typography>
              <Chip
                size="small"
                variant="outlined"
                label={grant.access === "write" ? "Read and write" : "Read"}
              />
              {grant.service === "github" && (
                <Button size="small" disabled={busy} onClick={() => setEditing(true)}>
                  Change
                </Button>
              )}
              <Button
                size="small"
                color="error"
                disabled={busy}
                title={REMOVED_NOTE}
                onClick={() =>
                  void act(async () => {
                    const { warning } = await removeServiceGrant(agent.id, grant.service);
                    return { warning: [warning, REMOVED_NOTE].filter(Boolean).join(" ") };
                  })
                }
              >
                Remove
              </Button>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {grant.summary}
            </Typography>
            {grant.service === "github" && (
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                {repositoryNames(github, grant).join(", ")}
              </Typography>
            )}
          </Paper>
        ))}

        {servicesError && <Alert severity="error">{servicesError}</Alert>}
        {grants &&
          onOff.map((service) => (
            <OnOffGrant
              key={service.slug}
              service={service}
              grant={grants.grants.find((grant) => grant.service === service.slug) ?? null}
              agentName={agent.name}
              busy={busy}
              onTurnOn={() =>
                void act(() => setServiceGrant(agent.id, service.slug, { access: null, resources: {} }))
              }
              onTurnOff={() => void act(() => removeServiceGrant(agent.id, service.slug))}
            />
          ))}

        {grants && (editing || !githubGrant) && (
          <GitHubGrantForm
            github={github}
            githubError={githubError}
            current={githubGrant}
            busy={busy}
            onCancel={githubGrant ? () => setEditing(false) : null}
            onSave={(access, resources) =>
              void act(async () => {
                const result = await setServiceGrant(agent.id, "github", { access, resources });
                setEditing(false);
                return result;
              })
            }
          />
        )}

        <GitHubNotes />
      </Stack>
    </>
  );
}

/**
 * What turning on a service whose agents use the owner's own token means, and
 * how long turning it off takes: Switch stops handing it out within an hour,
 * and a token that lives longer stays valid at the vendor until it expires.
 */
export function onOffGrantNote(
  agentName: string,
  serviceName: string,
  tokenLifetime: number | null,
): string {
  const note = `On, ${agentName} acts as you at ${serviceName}, with everything your ${serviceName} connection allows. Turning it off stops its sessions using ${serviceName} within an hour.`;
  return tokenLifetime !== null && tokenLifetime > 3600
    ? `${note} A token already handed out stays valid at ${serviceName} until it expires or you disconnect.`
    : note;
}

/** A service whose agents use the owner's own token: on or off, at the connection's level. */
function OnOffGrant({
  service,
  grant,
  agentName,
  busy,
  onTurnOn,
  onTurnOff,
}: {
  service: ServiceConnection;
  grant: ServiceGrant | null;
  agentName: string;
  busy: boolean;
  onTurnOn: () => void;
  onTurnOff: () => void;
}) {
  const connected = service.status === "active";
  // A grant can be turned off whatever the server's state; on needs a usable connection.
  const blocked = grant === null && (!connected || service.unavailable_reason !== null);
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          {service.name}
        </Typography>
        <Chip size="small" variant="outlined" label={grant ? "On" : "Off"} />
        <Switch
          checked={grant !== null}
          disabled={busy || blocked}
          onChange={(_, on) => (on ? onTurnOn() : onTurnOff())}
          slotProps={{ input: { "aria-label": `${service.name} for ${agentName}` } }}
        />
      </Stack>
      {grant && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {grant.summary}
        </Typography>
      )}
      {service.unavailable_reason && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {service.unavailable_reason}
        </Typography>
      )}
      {!grant && !connected && !service.unavailable_reason && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          To turn {service.name} on, first connect it from Switch Console&apos;s connections.
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
        {onOffGrantNote(agentName, service.name, service.token_lifetime)}
      </Typography>
    </Paper>
  );
}

function GitHubGrantForm({
  github,
  githubError,
  current,
  busy,
  onCancel,
  onSave,
}: {
  github: GitHubConnection | null;
  githubError: string | null;
  current: ServiceGrant | null;
  busy: boolean;
  onCancel: (() => void) | null;
  onSave: (access: Access, resources: Record<string, unknown>) => void;
}) {
  const [access, setAccess] = useState<Access>(current?.access ?? "read");
  const [installationId, setInstallationId] = useState<number | null>(
    typeof current?.resources.installation_id === "number"
      ? current.resources.installation_id
      : null,
  );
  const [selected, setSelected] = useState<number[]>(
    current ? repositoryIds(current.resources) : [],
  );

  if (githubError) return <Alert severity="error">{githubError}</Alert>;
  if (github === null) return <CircularProgress size={20} />;
  if (github.status === "not_connected")
    return (
      <Typography variant="body2" color="text.secondary">
        To grant GitHub, first connect your GitHub account from Switch Console&apos;s
        connections.
      </Typography>
    );

  const installation = github.installations.find((i) => i.id === installationId) ?? null;
  const options = installation?.repositories ?? [];

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle2">
          {current ? "Change the GitHub grant" : "Grant GitHub"}
        </Typography>
        <Autocomplete
          size="small"
          options={github.installations}
          getOptionLabel={(option) => option.account}
          value={installation}
          onChange={(_, value) => {
            setInstallationId(value?.id ?? null);
            setSelected([]);
          }}
          renderInput={(params) => <TextField {...params} label="GitHub account" />}
        />
        <Autocomplete
          multiple
          size="small"
          disabled={!installation}
          options={options}
          getOptionLabel={(option) => option.name}
          value={options.filter((r) => selected.includes(r.id))}
          onChange={(_, value) => setSelected(value.map((r) => r.id))}
          renderInput={(params) => <TextField {...params} label="Repositories" />}
        />
        <RadioGroup
          row
          value={access}
          onChange={(e) => setAccess(e.target.value as Access)}
        >
          <FormControlLabel value="read" control={<Radio size="small" />} label="Read" />
          <FormControlLabel
            value="write"
            control={<Radio size="small" />}
            label="Read and push"
          />
        </RadioGroup>
        <Box sx={{ display: "flex", gap: 1 }}>
          <Button
            variant="contained"
            size="small"
            disabled={busy || !installation || selected.length === 0}
            onClick={() =>
              onSave(access, { installation_id: installation!.id, repository_ids: selected })
            }
          >
            {current ? "Save" : "Grant"}
          </Button>
          {onCancel && (
            <Button size="small" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </Box>
      </Stack>
    </Paper>
  );
}

/** What removing a grant does, and what it does not. */
export const REMOVED_NOTE =
  "Removing a grant stops Switch giving this access. On a laptop or server, the agent may still use the machine's own sign-in, and the session says so when it does.";

/** What a GitHub grant changes on the machine the agent runs on, and what it does not. */
export function GitHubNotes() {
  return (
    <Box component="ul" sx={{ m: 0, pl: 2.5, color: "text.secondary", typography: "body2" }}>
      <li>Pushes, pull requests and comments show as the Switch GitHub App, not you.</li>
      <li>
        Used first for this agent over HTTPS. For repositories outside the grant, or if Switch
        can&apos;t provide it, your own GitHub login is used and the session says so. SSH still uses
        your keys.
      </li>
      <li>On your computer, the agent can still use anything you&apos;re signed in to.</li>
      <li>Not available on Windows yet.</li>
    </Box>
  );
}

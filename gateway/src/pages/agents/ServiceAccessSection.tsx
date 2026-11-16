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
import { Link as RouterLink } from "react-router";
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
  githubThroughApp,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";

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

/** The repositories a GitHub grant names, by full name where the person can still see them. */
export function repositoryNames(github: GitHubConnection | null, grant: ServiceGrant): string[] {
  const installation = installationOf(github, grant.resources);
  return repositoryIds(grant.resources).map((id) => {
    const repository = installation?.repositories.find((r) => r.id === id);
    return repository ? repository.name : `repository ${id}`;
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
  canGrant,
  onAgentUpdated,
}: {
  agent: AgentDetail;
  // Granting it more: refused for an agent not run from a known agent type.
  // The grants it has can be seen and removed regardless.
  canGrant: boolean;
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
  const { isOperator } = useAuth();

  // Whether the grants could be read: they cannot for someone else's agent,
  // whose grants are its owner's business, and the section then hides.
  const load = useCallback(async (): Promise<boolean> => {
    try {
      setGrants(await fetchServiceGrants(agent.id));
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setHidden(true);
      else setError(errorText(err));
      return false;
    }
  }, [agent.id]);

  const loadServices = useCallback(async (): Promise<ServiceConnection[] | null> => {
    try {
      const list = await fetchServiceConnections();
      setServices(list);
      return list;
    } catch (err) {
      setServicesError(errorText(err));
      return null;
    }
  }, []);

  // The viewer's own connections are read only once the grants show this is
  // their agent. GitHub's only while it is set up here: until then the server
  // has no connection to answer with, and the form says it is not set up.
  useEffect(() => {
    void load().then(async (own) => {
      if (!own) return;
      const list = await loadServices();
      if (list?.find((service) => service.slug === "github")?.server_setup_needed) return;
      fetchGitHubConnection().then(setGitHub, (err: unknown) => setGitHubError(errorText(err)));
    });
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
  const githubService = services.find((service) => service.slug === "github") ?? null;
  // GitHub connected with a pasted token is on or off, among the others.
  const githubApp = githubService === null || githubThroughApp(githubService);
  // Why GitHub can't be granted here at all, said where its form would be.
  const githubBlocked = githubService === null ? null : serviceBlockedReason(githubService);

  return (
    <>
      <Divider />
      <Stack spacing={1.5}>
        <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
          Service access
        </Typography>
        <Typography variant="body2" color="text.secondary">
          What this agent may use of your own connectors. Its sessions are given
          short-lived access for what you grant, and nothing else.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {notice && <Alert severity="info">{notice}</Alert>}
        {grants === null && !error && <CircularProgress size={20} />}
        {grants !== null && !canGrant && (
          <Alert severity="info">
            New grants are only for an agent Switch Console runs from a known agent type. What it
            has been granted can still be removed.
          </Alert>
        )}

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
            stops that: only you can address it. It still reads what others write in
            shared rooms and posts results there.
          </Alert>
        )}

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
              {canGrant && grant.service === "github" && githubBlocked === null && (
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
            {grant.access === "write" && readOnlyReasonFor(services, grant.service) && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                {readOnlyReasonFor(services, grant.service)}
              </Alert>
            )}
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
              canTurnOn={canGrant}
              canSetUp={isOperator}
              onTurnOn={() =>
                void act(() => setServiceGrant(agent.id, service.slug, { access: null, resources: {} }))
              }
              onTurnOff={() => void act(() => removeServiceGrant(agent.id, service.slug))}
            />
          ))}

        {grants && canGrant && githubApp && githubBlocked !== null && (
          <Typography variant="body2" color="text.secondary">
            {githubBlocked}
            {isOperator && githubService?.server_setup_needed && <SetUpLink />}
          </Typography>
        )}
        {grants && canGrant && githubApp && githubBlocked === null && (editing || !githubGrant) && (
          <GitHubGrantForm
            github={github}
            githubError={githubError}
            current={githubGrant}
            readOnlyReason={githubService?.read_only_reason ?? null}
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

        {githubApp && <GitHubNotes />}
      </Stack>
    </>
  );
}

/**
 * What turning on a service whose agents use the owner's own token means, and
 * how long turning it off takes: Switch stops handing it out within a minute,
 * and a token that lives longer may keep working at the vendor until it
 * expires. Whether disconnecting ends it sooner is the vendor's to say, so the
 * note does not promise it; the disconnect's own warning says what it could
 * not take back. A service connected with a key hands out the key itself,
 * which does not expire, so its note says only how far the key reaches.
 */
export function onOffGrantNote(
  agentName: string,
  service: Pick<ServiceConnection, "name" | "token_lifetime" | "key">,
): string {
  const { name } = service;
  const off = `Turning it off stops its sessions using ${name} within a minute.`;
  if (service.key)
    return `On, ${agentName} uses ${name} with your key, as far as the key allows. ${off}`;
  const note = `On, ${agentName} acts as you at ${name}, with everything your ${name} connector allows. ${off}`;
  if (service.token_lifetime === null || service.token_lifetime <= 3600) return note;
  const hours = Math.ceil(service.token_lifetime / 3600);
  return `${note} A token already handed out may keep working at ${name} until it expires, up to ${hours} hours after it was handed out.`;
}

/**
 * Why the service can't be used by agents here at all, whoever is connected:
 * the server's own reason first, then the workspace's switch, worded as the
 * server's refusal is. Null when neither stops it.
 */
export function serviceBlockedReason(
  service: Pick<ServiceConnection, "name" | "unavailable_reason" | "workspace_enabled">,
): string | null {
  if (service.unavailable_reason !== null) return service.unavailable_reason;
  if (!service.workspace_enabled)
    return `${service.name} is not enabled in this workspace. Ask a workspace admin; they switch it on under Connectors in Switch Console.`;
  return null;
}

/**
 * Why a service can be granted for reading only on this server, which a
 * write grant on it made before gets no token for; null where writing can
 * be granted too.
 */
export function readOnlyReasonFor(
  services: Pick<ServiceConnection, "slug" | "read_only_reason">[],
  slug: string,
): string | null {
  return services.find((service) => service.slug === slug)?.read_only_reason ?? null;
}

/** The operator's way from a service that is not set up to where it is set
 * up: their server-wide connector apps, under Platform in the new layout. */
function SetUpLink() {
  const { capabilities } = useAuth();
  return (
    <Button
      component={RouterLink}
      to={capabilities.features.gateway_v2 ? "/platform/connectors" : "/connectors"}
      size="small"
      sx={{ ml: 1 }}
    >
      Set up
    </Button>
  );
}

/** Where to connect a service before granting it: in the new layout its own
 * page, which connects it or says how; otherwise Switch Console. */
function ConnectFirst({ slug, what }: { slug: string; what: string }) {
  const { capabilities } = useAuth();
  if (!capabilities.features.gateway_v2)
    return (
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {what} in Switch Console, under Connectors.
      </Typography>
    );
  return (
    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
      {what}.
      <Button component={RouterLink} to={`/connectors/${slug}`} size="small" sx={{ ml: 1 }}>
        Connect
      </Button>
    </Typography>
  );
}

/** A service whose agents use the owner's own token: on or off, at the connection's level. */
function OnOffGrant({
  service,
  grant,
  agentName,
  busy,
  canTurnOn,
  canSetUp,
  onTurnOn,
  onTurnOff,
}: {
  service: ServiceConnection;
  grant: ServiceGrant | null;
  agentName: string;
  busy: boolean;
  canTurnOn: boolean;
  canSetUp: boolean;
  onTurnOn: () => void;
  onTurnOff: () => void;
}) {
  const connected = service.status === "active";
  // Said whether or not it is on: on, the grant does nothing until it changes.
  const blocked = serviceBlockedReason(service);
  // A grant can be turned off whatever the server's state; on needs a usable connection.
  const blocksOn = grant === null && (!canTurnOn || !connected || blocked !== null);
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          {service.name}
        </Typography>
        <Chip size="small" variant="outlined" label={grant ? "On" : "Off"} />
        <Switch
          checked={grant !== null}
          disabled={busy || blocksOn}
          onChange={(_, on) => (on ? onTurnOn() : onTurnOff())}
          slotProps={{ input: { "aria-label": `${service.name} for ${agentName}` } }}
        />
      </Stack>
      {grant && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {grant.summary}
        </Typography>
      )}
      {/* Only while it works: a broken organization app says why below. */}
      {service.app_source === "organization" && service.unavailable_reason === null && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          Signs in through your organization&apos;s {service.name} app.
        </Typography>
      )}
      {blocked && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {blocked}
          {canSetUp && service.server_setup_needed && <SetUpLink />}
        </Typography>
      )}
      {!grant && !connected && !blocked && (
        <ConnectFirst slug={service.slug} what={`To turn ${service.name} on, first connect it`} />
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
        {onOffGrantNote(agentName, service)}
      </Typography>
    </Paper>
  );
}

export function GitHubGrantForm({
  github,
  githubError,
  current,
  readOnlyReason,
  busy,
  onCancel,
  onSave,
}: {
  github: GitHubConnection | null;
  githubError: string | null;
  current: ServiceGrant | null;
  /** Why the server's App lets agents read only; null where pushing can be granted. */
  readOnlyReason: string | null;
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
    return <ConnectFirst slug="github" what="To grant GitHub, first connect your GitHub account" />;

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
            disabled={readOnlyReason !== null}
          />
        </RadioGroup>
        {readOnlyReason && (
          <Typography variant="body2" color="text.secondary">
            {readOnlyReason}
          </Typography>
        )}
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
  "Removing a grant stops Switch giving this access. On a device, the agent may still use the device's own sign-in, and the session says so when it does.";

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

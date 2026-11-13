import ArrowBack from "@mui/icons-material/ArrowBack";
import OpenInNewOutlined from "@mui/icons-material/OpenInNewOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Link,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Link as RouterLink, useLocation, useNavigate, useParams } from "react-router";
import BrandTile from "../../components/connectors/BrandTile";
import ConfirmDialog from "../../components/ConfirmDialog";
import InfoTip from "../../components/InfoTip";
import PageBanner from "../../components/PageBanner";
import {
  type ConnectedPerson,
  type GitHubConnection,
  type ServiceAgent,
  type ServiceConnection,
  type ServiceInWorkspace,
  disconnectService,
  fetchGitHubConnection,
  fetchServiceAgents,
  fetchServiceConnections,
  fetchServiceInWorkspace,
  revokeServiceConnection,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { formatDate } from "../../theme/format";
import ConnectorAgents from "./ConnectorAgents";
import {
  CONSOLE_CONNECT_NOTE,
  accessLastsLabel,
  connectWay,
  connectedAsLine,
  isConnected,
  offNotice,
  personLine,
  revokeConfirmation,
  signInLabel,
} from "./connectorProfile";
import KeyDialog from "./KeyDialog";

/** Where the back button goes: the page that opened this one, when it said,
 * else the connector catalogue. */
interface Back {
  label: string;
  to: string;
}

function backOf(state: unknown): Back {
  const back = (state as { back?: Back } | null)?.back;
  return back && typeof back.to === "string" ? back : { label: "Connectors", to: "/connectors" };
}

function Fact({ label, quiet, children }: { label: string; quiet?: boolean; children: ReactNode }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="overline" color="text.secondary" component="h3">
        {label}
      </Typography>
      <Box sx={{ typography: "body2", color: quiet ? "text.secondary" : "text.primary", mt: 0.25 }}>
        {children}
      </Box>
    </Box>
  );
}

function General({ connection }: { connection: ServiceConnection }) {
  return (
    <Stack spacing={2} component="section" aria-label="General">
      <Typography variant="h6">General</Typography>
      <Box sx={{ display: "grid", gap: 3, gridTemplateColumns: { xs: "1fr", sm: "repeat(3, 1fr)" } }}>
        <Fact label="Category">
          <Chip size="small" variant="outlined" label={connection.category} />
        </Fact>
        <Fact label="Sign-in">{signInLabel(connection)}</Fact>
        <Fact label="Agent access lasts">{accessLastsLabel(connection)}</Fact>
      </Box>
      {(connection.publisher || connection.links || connection.mcp_urls.length > 0) && (
        <Box
          sx={{
            display: "grid",
            gap: 3,
            gridTemplateColumns: { xs: "1fr", sm: "repeat(3, 1fr)" },
            borderTop: "1px solid var(--sw-border)",
            pt: 2,
          }}
        >
          {connection.publisher && (
            <Fact label="Made by" quiet>
              {connection.publisher}
            </Fact>
          )}
          {connection.links && (
            <Box sx={{ gridColumn: { sm: "span 2" } }}>
              <Fact label="More info" quiet>
                <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap" }}>
                  {(
                    [
                      ["Documentation", connection.links.documentation],
                      ["Support", connection.links.support],
                      ["Privacy policy", connection.links.privacy],
                    ] as const
                  ).map(([label, href]) => (
                    <Link key={label} href={href} target="_blank" rel="noreferrer" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
                      {label}
                      <OpenInNewOutlined sx={{ fontSize: 14 }} />
                    </Link>
                  ))}
                </Stack>
              </Fact>
            </Box>
          )}
          {connection.mcp_urls.length > 0 && (
            <Box sx={{ gridColumn: { sm: "1 / -1" } }}>
              <Fact label={connection.mcp_urls.length === 1 ? "Connector URL" : "Connector URLs"} quiet>
                {connection.mcp_urls.map((url) => (
                  <Typography key={url} variant="caption" component="p" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                    {url}
                  </Typography>
                ))}
              </Fact>
            </Box>
          )}
        </Box>
      )}
    </Stack>
  );
}

/** A key-based connector's keys: never shown back, so a fixed mask, the
 * account the key belongs to, and the way to replace it. */
function Keys({ connection, onReplace }: { connection: ServiceConnection; onReplace: () => void }) {
  const secrets = connection.key?.fields.filter((field) => field.secret) ?? [];
  return (
    <Stack spacing={1.5} component="section" aria-label="Keys">
      <Typography variant="h6">Keys</Typography>
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        {secrets.map((field) => (
          <TextField
            key={field.name}
            label={field.label}
            value="••••••••••••••••"
            size="small"
            slotProps={{ htmlInput: { readOnly: true, "aria-readonly": true } }}
            sx={{ width: 220 }}
          />
        ))}
        <Button variant="outlined" onClick={onReplace}>
          Replace keys
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        Stored once, never shown again.
      </Typography>
    </Stack>
  );
}

function ConnectedPeople({
  connection,
  people,
  workspaceName,
  onRevoke,
}: {
  connection: ServiceConnection;
  people: ConnectedPerson[];
  workspaceName: string;
  onRevoke: (person: ConnectedPerson) => void;
}) {
  const others = people.filter((person) => person.can_revoke);
  return (
    <Stack spacing={1} component="section" aria-label={`Connected in ${workspaceName}`}>
      <Typography variant="h6">Connected in {workspaceName}</Typography>
      {others.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Nobody else in {workspaceName} has connected {connection.name}.
        </Typography>
      ) : (
        <Stack divider={<Divider flexItem />}>
          {others.map((person) => (
            <Stack
              key={person.user_id}
              direction="row"
              spacing={1.5}
              sx={{ alignItems: "center", py: 1.25 }}
              data-testid={`connected-${person.user_id}`}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {person.name}
                  </Typography>
                  {person.status !== "active" && (
                    <Chip size="small" color="warning" variant="outlined" label="Needs reconnecting" />
                  )}
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {personLine(person, formatDate)}
                </Typography>
              </Box>
              <Button size="small" color="error" onClick={() => onRevoke(person)}>
                Revoke
              </Button>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * One connector, in full: who you are connected as and the one way to
 * connect or disconnect, why it is off here if it is, the facts about it,
 * the agents using it, and for a workspace admin everyone else connected,
 * with Revoke. Opened from the catalogue and from Settings; Back returns to
 * whichever opened it.
 *
 * A key is pasted here. A sign-in at the vendor finishes in Switch Console,
 * which holds the listener the vendor sends people back to; the page says so
 * rather than offering a button that can't finish.
 */
export default function ConnectorPage() {
  const { connectorId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const back = backOf(location.state);
  const { session, capabilities } = useAuth();
  const meId = session?.user.id ?? "";
  const workspaceName = session?.tenant?.name ?? "this workspace";
  const admin = capabilities.administersWorkspace;

  const [connection, setConnection] = useState<ServiceConnection | null>(null);
  const [own, setOwn] = useState<ServiceAgent[]>([]);
  const [inWorkspace, setInWorkspace] = useState<ServiceInWorkspace | null>(null);
  // Whether the agents and the people connected were read: until they are,
  // or when reading them failed, neither list is drawn, so a failure never
  // reads as "nobody uses it".
  const [listsLoaded, setListsLoaded] = useState(false);
  const [github, setGitHub] = useState<GitHubConnection | null>(null);
  const [githubError, setGitHubError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [keyDialog, setKeyDialog] = useState<"add" | "replace" | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [revoking, setRevoking] = useState<ConnectedPerson | null>(null);

  const load = useCallback(async () => {
    try {
      const found = (await fetchServiceConnections()).find((entry) => entry.slug === connectorId);
      if (!found) {
        setMissing(true);
        return;
      }
      setConnection(found);
      if (!found.enabled) return;
      const [agents, workspace] = await Promise.all([
        fetchServiceAgents(connectorId),
        admin ? fetchServiceInWorkspace(connectorId) : Promise.resolve(null),
      ]);
      setOwn(agents);
      setInWorkspace(workspace);
      setListsLoaded(true);
      if (connectorId === "github" && found.status === "active")
        fetchGitHubConnection().then(setGitHub, (err: unknown) =>
          setGitHubError(err instanceof Error ? err.message : String(err)),
        );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setListsLoaded(false);
    }
  }, [connectorId, admin]);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = (message: string | null, warning: string | null) => {
    if (message) setToast(message);
    setNotice(warning);
    void load();
  };

  const backButton = (
    <Button
      startIcon={<ArrowBack />}
      size="small"
      onClick={() => navigate(back.to)}
      sx={{ alignSelf: "flex-start", ml: -1 }}
    >
      {back.label}
    </Button>
  );

  if (missing)
    return (
      <Stack spacing={2}>
        {backButton}
        <Alert severity="info">There is no connector named {connectorId}.</Alert>
      </Stack>
    );
  if (error && connection === null)
    return (
      <Stack spacing={2}>
        {backButton}
        <Alert severity="error">{error}</Alert>
      </Stack>
    );
  if (connection === null) return <CircularProgress />;

  const connectedAs = connectedAsLine(connection);
  const way = connectWay(connection);
  const off = offNotice(connection, workspaceName);
  const connected = isConnected(connection);

  return (
    <Stack spacing={4}>
      <Stack spacing={2}>
        {backButton}
        <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start", flexWrap: "wrap" }} useFlexGap>
          <BrandTile slug={connection.slug} name={connection.name} size={64} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }} useFlexGap>
              <Typography variant="h5" component="h1">
                {connection.name}
              </Typography>
              {!connection.enabled && <Chip size="small" label="Coming soon" />}
              {connection.enabled && !connection.workspace_enabled && (
                <Chip size="small" label={`Off in ${workspaceName}`} />
              )}
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {connection.description}
            </Typography>
            {connectedAs && (
              <Typography variant="body2" sx={{ mt: 1 }}>
                {connectedAs}
              </Typography>
            )}
            {connected && connection.status !== "active" && (
              <Typography variant="body2" color="warning.main" sx={{ mt: 0.5 }}>
                {connection.auth_type === "api_key"
                  ? "Its key needs replacing before agents can use it again."
                  : "It needs a fresh sign-in, from Switch Console, before agents can use it again."}
              </Typography>
            )}
          </Box>
          <Stack direction="row" spacing={1} sx={{ flexShrink: 0, alignItems: "center" }}>
            {!connected && way === "key" && (
              <Button variant="contained" onClick={() => setKeyDialog("add")}>
                Add keys
              </Button>
            )}
            {!connected && way === "console" && (
              <Typography variant="body2" color="text.secondary" component="div">
                Connect from Switch Console <InfoTip>{CONSOLE_CONNECT_NOTE}</InfoTip>
              </Typography>
            )}
            {connection.can_revoke && (
              <Button variant="outlined" color="error" onClick={() => setDisconnecting(true)}>
                Disconnect
              </Button>
            )}
          </Stack>
        </Stack>
      </Stack>

      {off && (
        <PageBanner
          tone="neutral"
          action={
            off.fixedIn === "organization" && capabilities.administersOrganization ? (
              <Button component={RouterLink} to="/settings/org/connectors" size="small">
                Organization settings
              </Button>
            ) : off.fixedIn === "workspace" && admin ? (
              <Button component={RouterLink} to="/settings/connectors" size="small">
                Workspace settings
              </Button>
            ) : undefined
          }
        >
          {off.text}
        </PageBanner>
      )}
      {connection.enabled && connection.workspace_enabled && connection.unavailable_reason && (
        <PageBanner tone="warning">{connection.unavailable_reason}</PageBanner>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {notice && (
        <Alert severity="info" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      <General connection={connection} />

      {connected && connection.auth_type === "api_key" && connection.key && (
        <Keys connection={connection} onReplace={() => setKeyDialog("replace")} />
      )}

      {connection.enabled && listsLoaded && (
        <ConnectorAgents
          connection={connection}
          own={own}
          workspace={inWorkspace?.agents ?? null}
          meId={meId}
          workspaceName={workspaceName}
          github={github}
          githubError={githubError}
          onChanged={(warning) => changed(null, warning)}
        />
      )}

      {listsLoaded && inWorkspace && (
        <ConnectedPeople
          connection={connection}
          people={inWorkspace.people}
          workspaceName={workspaceName}
          onRevoke={setRevoking}
        />
      )}

      {keyDialog && (
        <KeyDialog
          connection={connection}
          replacing={keyDialog === "replace"}
          onClose={() => setKeyDialog(null)}
          onSaved={(warning) => {
            setKeyDialog(null);
            changed(keyDialog === "replace" ? "Keys replaced." : `${connection.name} is connected.`, warning);
          }}
        />
      )}
      <ConfirmDialog
        open={disconnecting}
        title={`Disconnect ${connection.name}?`}
        description={`Your agents lose ${connection.name}: their grants on it are removed, and what was handed out to them is revoked.`}
        confirmLabel="Disconnect"
        tone="destructive"
        onConfirm={async () => {
          const { warning } = await disconnectService(connection.slug);
          changed(`${connection.name} is disconnected.`, warning);
        }}
        onClose={() => setDisconnecting(false)}
      />
      {revoking && (
        <ConfirmDialog
          open
          {...revokeConfirmation(revoking, connection.name)}
          confirmLabel="Revoke"
          tone="destructive"
          onConfirm={async () => {
            const { warning } = await revokeServiceConnection(connection.slug, revoking.user_id);
            changed(`${revoking.name} is disconnected from ${connection.name}.`, warning);
          }}
          onClose={() => setRevoking(null)}
        />
      )}
      <Snackbar open={toast !== null} autoHideDuration={5000} onClose={() => setToast(null)} message={toast} />
    </Stack>
  );
}

import Add from "@mui/icons-material/Add";
import BlockOutlined from "@mui/icons-material/BlockOutlined";
import Check from "@mui/icons-material/Check";
import PriorityHigh from "@mui/icons-material/PriorityHigh";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  IconButton,
  Snackbar,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import CatalogueGrid from "../../components/connectors/CatalogueGrid";
import ConnectorCard from "../../components/connectors/ConnectorCard";
import InfoTip from "../../components/InfoTip";
import { type ServiceConnection, fetchServiceConnections, fetchWorkspaceServices } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { brokenLine, catalogueMeta, connectWay, isConnected, offNotice } from "./connectorProfile";
import KeyDialog from "./KeyDialog";
import { leaveToSignIn } from "./signIn";

type Tab = "yours" | "all";

/** The usable connectors first, then the ones not built yet; each group in
 * the catalog's own order. */
function ordered(connections: ServiceConnection[]): ServiceConnection[] {
  return [...connections.filter((c) => c.enabled), ...connections.filter((c) => !c.enabled)];
}

/** The card's one control, top right. Not connected: a button that starts
 * connecting, where it can start from here. Connected: a status mark, not a
 * control, so pressing it opens the profile like the rest of the card,
 * where disconnecting sits beside what it costs. */
function CardState({
  connection,
  leaving,
  onConnect,
}: {
  connection: ServiceConnection;
  leaving: boolean;
  onConnect: () => void;
}) {
  const mark = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: "8px", border: "1px solid" };
  if (isConnected(connection))
    return brokenLine(connection) ? (
      <Box
        role="img"
        aria-label={`${connection.name} needs reconnecting`}
        sx={{ ...mark, borderColor: "var(--sw-warning-border)", backgroundColor: "var(--sw-warning-muted)", color: "var(--sw-warning)" }}
      >
        <PriorityHigh fontSize="small" />
      </Box>
    ) : (
      <Box
        role="img"
        aria-label={`Connected to ${connection.name}`}
        sx={{ ...mark, borderColor: "var(--sw-success-border)", backgroundColor: "var(--sw-success-muted)", color: "var(--sw-success-text)" }}
      >
        <Check fontSize="small" />
      </Box>
    );
  const way = connectWay(connection);
  if (way !== "web" && way !== "key") return null;
  return (
    <IconButton
      aria-label={`Connect ${connection.name}`}
      onClick={onConnect}
      disabled={leaving}
      sx={{ ...mark, borderColor: "var(--sw-border)" }}
    >
      {leaving ? <CircularProgress size={16} /> : <Add fontSize="small" />}
    </IconButton>
  );
}

/**
 * Connectors: the services your agents can reach in this workspace, and
 * where you connect your own account to each. Yours and All, and a search.
 * A connector the workspace has off still shows, saying so, since hiding it
 * would make a decision look like a missing row; whether it is on is
 * Settings › Connectors' to change, never this page's. A workspace admin also
 * sees how many people here have connected each one.
 *
 * A card's plus connects where that can start here: a sign-in that returns
 * to this browser, or a key. Everything else, and every connected card, opens
 * the connector's page, which explains. One nobody can connect here (its app
 * isn't set up, say) says so on its card, as one the workspace has off does.
 */
export default function ConnectorsPage() {
  const { session, capabilities } = useAuth();
  const navigate = useNavigate();
  const workspaceName = session?.tenant?.name ?? "this workspace";
  const admin = capabilities.administersWorkspace;

  const [connections, setConnections] = useState<ServiceConnection[] | null>(null);
  const [people, setPeople] = useState<Map<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [query, setQuery] = useState("");
  const [keyFor, setKeyFor] = useState<ServiceConnection | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setConnections(ordered(await fetchServiceConnections()));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The counts are an admin's extra, read apart from the catalogue: if they
  // can't be read, the catalogue still shows, and says the counts are missing.
  useEffect(() => {
    if (!admin) return;
    fetchWorkspaceServices().then(
      (data) => setPeople(new Map(data.services.map((s) => [s.slug, s.connected_members ?? 0]))),
      (err: unknown) => setPeopleError(err instanceof Error ? err.message : String(err)),
    );
  }, [admin]);

  const connected = useMemo(() => (connections ?? []).filter(isConnected), [connections]);
  // Yours, unless there is nothing of yours yet to show.
  const shown: Tab = tab ?? (connected.length > 0 ? "yours" : "all");

  const connect = async (connection: ServiceConnection) => {
    setConnectError(null);
    if (connectWay(connection) === "key") {
      setKeyFor(connection);
      return;
    }
    setLeaving(connection.slug);
    try {
      await leaveToSignIn(connection.slug);
    } catch (err) {
      setLeaving(null);
      setConnectError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Box>
      <Typography variant="h5">Connectors</Typography>
      <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, mb: 3, alignItems: "center" }}>
        <Typography variant="body2" color="text.secondary">
          The services your agents can reach in {workspaceName}.
        </Typography>
        <InfoTip>
          Connect your own account, then choose which of your agents may use it. Which connectors this workspace
          allows is set in Settings › Connectors.
        </InfoTip>
      </Stack>
      <Stack spacing={2}>
        {error && <Alert severity="error">{error}</Alert>}
        {peopleError && (
          <Alert severity="warning">How many people have connected each one couldn&apos;t be read: {peopleError}</Alert>
        )}
        {connectError && (
          <Alert severity="error" onClose={() => setConnectError(null)}>
            {connectError}
          </Alert>
        )}
        {notice && (
          <Alert severity="info" onClose={() => setNotice(null)}>
            {notice}
          </Alert>
        )}
        {connections === null ? (
          !error && <CircularProgress aria-label="Loading connectors" />
        ) : (
          <Box>
            <CatalogueGrid
              connectors={shown === "yours" ? connected : connections}
              query={query}
              onQueryChange={setQuery}
              controls={
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={shown}
                  onChange={(_event, next: Tab | null) => {
                    if (next) setTab(next);
                  }}
                  aria-label="Which connectors to show"
                >
                  <ToggleButton value="yours">Yours</ToggleButton>
                  <ToggleButton value="all">All</ToggleButton>
                </ToggleButtonGroup>
              }
              emptyMessage={
                shown === "yours"
                  ? query.trim()
                    ? "You haven't connected anything that matches. The All tab lists every connector."
                    : "You haven't connected anything yet. The All tab lists every connector."
                  : `No connectors match "${query.trim()}".`
              }
              renderCard={(connection) => {
                const off = connection.enabled ? offNotice(connection, workspaceName) : null;
                return (
                  <ConnectorCard
                    connector={connection}
                    onOpen={() => navigate(`/connectors/${connection.slug}`)}
                    badges={
                      !connection.enabled ? (
                        <Chip size="small" label="Coming soon" />
                      ) : off ? (
                        <Tooltip title={off.text}>
                          <Chip size="small" variant="outlined" icon={<BlockOutlined />} label="Off here" />
                        </Tooltip>
                      ) : (
                        !connection.connectable && (
                          <Tooltip title={connection.unavailable_reason ?? "It can't be connected here."}>
                            <Chip size="small" variant="outlined" label="Unavailable" />
                          </Tooltip>
                        )
                      )
                    }
                    meta={catalogueMeta(
                      connection,
                      admin && connection.enabled && people ? (people.get(connection.slug) ?? 0) : null,
                    )}
                    trailing={
                      <CardState
                        connection={connection}
                        leaving={leaving === connection.slug}
                        onConnect={() => void connect(connection)}
                      />
                    }
                  />
                );
              }}
            />
          </Box>
        )}
      </Stack>
      {keyFor && (
        <KeyDialog
          connection={keyFor}
          replacing={false}
          onClose={() => setKeyFor(null)}
          onSaved={(warning) => {
            setToast(`${keyFor.name} is connected.`);
            setNotice(warning);
            setKeyFor(null);
            void load();
          }}
        />
      )}
      <Snackbar open={toast !== null} autoHideDuration={5000} onClose={() => setToast(null)} message={toast} />
    </Box>
  );
}

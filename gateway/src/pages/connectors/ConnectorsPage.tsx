import Add from "@mui/icons-material/Add";
import BlockOutlined from "@mui/icons-material/BlockOutlined";
import Check from "@mui/icons-material/Check";
import ExploreOutlined from "@mui/icons-material/ExploreOutlined";
import PriorityHigh from "@mui/icons-material/PriorityHigh";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
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
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import CatalogueGrid, { matchesQuery } from "../../components/connectors/CatalogueGrid";
import ConnectorCard from "../../components/connectors/ConnectorCard";
import InfoTip from "../../components/InfoTip";
import { SCREEN_READER_ONLY } from "../../components/screenReaderOnly";
import { type ServiceConnection, fetchServiceConnections, fetchWorkspaceServices } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { brokenLine, catalogueMeta, connectWay, isConnected, offNotice } from "./connectorProfile";
import KeyDialog from "./KeyDialog";
import PasteDialog from "./PasteDialog";
import { useLeaveToSignIn } from "./signIn";

type Tab = "yours" | "discover";

/** The trailing card on Yours, which opens Discover. */
function browseMoreText(count: number, query: string): string {
  const noun = count === 1 ? "connector" : "connectors";
  const needle = query.trim();
  return needle
    ? `${count} more ${noun} ${count === 1 ? "matches" : "match"} “${needle}” on Discover`
    : `Browse ${count} more ${noun}`;
}

/** What Yours says when nothing of the person's matches a search but Discover has some that do. */
function yoursSearchEmptyText(query: string, count: number, soon: number): string {
  const lead = `None of your connectors match “${query.trim()}”.`;
  return count > 0
    ? `${lead} ${count} on Discover ${count === 1 ? "does" : "do"}.`
    : `${lead} ${soon} coming soon on Discover.`;
}

/** A badge whose reason shows on hover, and is read out with the card by a
 * screen reader. It sits inside the card's button, so it can't take focus
 * itself; the connector's page says the same in full. */
function Reason({ label, why, icon }: { label: string; why: string; icon?: ReactElement }) {
  return (
    <>
      <Tooltip title={why}>
        <Chip size="small" variant="outlined" icon={icon} label={label} />
      </Tooltip>
      <Box component="span" sx={SCREEN_READER_ONLY}>
        {why}
      </Box>
    </>
  );
}

/** The card's one control, top right. Not connected: a button that starts
 * connecting, where it can start from here. Connected: a status mark, not a
 * control, so pressing it opens the profile like the rest of the card,
 * where disconnecting sits beside what it costs. */
function CardState({
  connection,
  onYours,
  leaving,
  onConnect,
}: {
  connection: ServiceConnection;
  /** On Yours every card is connected, so a tick there says nothing and makes a lone card read as the whole set. */
  onYours: boolean;
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
    ) : onYours ? null : (
      <Box
        role="img"
        aria-label={`Connected to ${connection.name}`}
        sx={{ ...mark, borderColor: "var(--sw-success-border)", backgroundColor: "var(--sw-success-muted)", color: "var(--sw-success-text)" }}
      >
        <Check fontSize="small" />
      </Box>
    );
  const way = connectWay(connection);
  if (way !== "web" && way !== "key" && way !== "paste") return null;
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
 * where you connect your own account to each. It opens on Discover, the
 * whole catalogue; Yours has what you connected. A search covers both.
 * A connector the workspace has off still shows, saying so, since hiding it
 * would make a decision look like a missing row; whether it is on is
 * Settings › Connectors' to change, never this page's. A workspace admin also
 * sees how many people here have connected each one.
 *
 * A card's plus connects where that can start here: a sign-in that returns
 * to this browser, a key, or a token pasted in place of a sign-in that only
 * Switch Console can finish. Everything else, and every connected card, opens
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
  const [tab, setTab] = useState<Tab>("discover");
  const [query, setQuery] = useState("");
  const [keyFor, setKeyFor] = useState<ServiceConnection | null>(null);
  const [pasteFor, setPasteFor] = useState<ServiceConnection | null>(null);
  const { leaving, leave } = useLeaveToSignIn();
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const listed = await fetchServiceConnections();
      setConnections(listed);
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
  const shown = tab;
  // From Yours, what Discover has for the search that could be connected, and
  // the coming soon services it finds, counted apart as Discover counts them.
  const [beyond, soon] = useMemo(() => {
    if (shown !== "yours") return [0, 0];
    const found = (connections ?? []).filter((c) => !isConnected(c) && matchesQuery(c, query));
    return [found.filter((c) => c.enabled).length, query.trim() ? found.filter((c) => !c.enabled).length : 0];
  }, [connections, shown, query]);

  const connect = (connection: ServiceConnection) => {
    setConnectError(null);
    const way = connectWay(connection);
    if (way === "key") {
      setKeyFor(connection);
      return;
    }
    if (way === "paste") {
      setPasteFor(connection);
      return;
    }
    leave(connection.slug).catch((err: unknown) =>
      setConnectError(err instanceof Error ? err.message : String(err)),
    );
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
              connectors={shown === "yours" ? connected : connections.filter((c) => c.enabled)}
              comingSoon={shown === "yours" ? [] : connections.filter((c) => !c.enabled)}
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
                  <ToggleButton value="discover">Discover</ToggleButton>
                </ToggleButtonGroup>
              }
              emptyMessage={
                shown !== "yours" ? (
                  `No connector matches “${query.trim()}”.`
                ) : beyond > 0 || soon > 0 ? (
                  <>
                    {query.trim() ? yoursSearchEmptyText(query, beyond, soon) : "You haven't connected anything yet."}{" "}
                    <Button size="small" variant="outlined" onClick={() => setTab("discover")} sx={{ ml: 1 }}>
                      {query.trim() ? "Show" : `Browse ${beyond} ${beyond === 1 ? "connector" : "connectors"}`}
                    </Button>
                  </>
                ) : query.trim() ? (
                  `No connector matches “${query.trim()}”.`
                ) : (
                  "You haven't connected anything yet."
                )
              }
              trailing={
                shown === "yours" &&
                beyond > 0 && (
                  <ButtonBase
                    onClick={() => setTab("discover")}
                    sx={{
                      justifyContent: "flex-start",
                      gap: 1.5,
                      p: 2,
                      border: "1px dashed var(--sw-border)",
                      borderRadius: "10px",
                      textAlign: "left",
                      fontSize: 14,
                      fontWeight: 500,
                      "&:hover": { backgroundColor: "var(--sw-muted)" },
                      "&.Mui-focusVisible": { outline: "2px solid var(--sw-ring)", outlineOffset: "2px" },
                    }}
                  >
                    <ExploreOutlined fontSize="small" sx={{ color: "text.secondary" }} />
                    {browseMoreText(beyond, query)}
                  </ButtonBase>
                )
              }
              renderCard={(connection) => {
                const off = connection.enabled ? offNotice(connection, workspaceName) : null;
                return (
                  <ConnectorCard
                    connector={connection}
                    faded={!connection.enabled}
                    onOpen={() => navigate(`/connectors/${connection.slug}`)}
                    badges={
                      !connection.enabled ? (
                        <Chip size="small" label="Coming soon" />
                      ) : off ? (
                        <Reason label="Off here" why={off.text} icon={<BlockOutlined />} />
                      ) : (
                        !connection.connectable && (
                          <Reason label="Unavailable" why={connection.unavailable_reason ?? "It can't be connected here."} />
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
                        onYours={shown === "yours"}
                        leaving={leaving === connection.slug}
                        onConnect={() => connect(connection)}
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
      {pasteFor && (
        <PasteDialog
          connection={pasteFor}
          replacing={false}
          onClose={() => setPasteFor(null)}
          onSaved={(warning) => {
            setToast(`${pasteFor.name} is connected.`);
            setNotice(warning);
            setPasteFor(null);
            void load();
          }}
        />
      )}
      <Snackbar open={toast !== null} autoHideDuration={5000} onClose={() => setToast(null)} message={toast} />
    </Box>
  );
}

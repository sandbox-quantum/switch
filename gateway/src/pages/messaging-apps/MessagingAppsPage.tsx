import AddLinkOutlined from "@mui/icons-material/AddLinkOutlined";
import AddOutlined from "@mui/icons-material/AddOutlined";
import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import GroupsOutlined from "@mui/icons-material/GroupsOutlined";
import OpenInNewOutlined from "@mui/icons-material/OpenInNewOutlined";
import VerifiedUserOutlined from "@mui/icons-material/VerifiedUserOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Snackbar,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import InfoTip from "../../components/InfoTip";
import DataTable, { type TableColumn, TableEmptyState } from "../../components/DataTable";
import RowActionsMenu, { type RowAction } from "../../components/RowActionsMenu";
import {
  type BridgeDetail,
  type BridgeUpdateInput,
  beginAppInstall,
  fetchUnconfirmedLinks,
  requireLinkConfirmation,
  type UnconfirmedLink,
  updateBridge,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { useBridges, useInstallablePlatforms } from "../../data/hooks";
import { formatDate, platformLabel, pluralize, sentenceCase, TABULAR_SX } from "../../theme/format";
import AddToChatDialog from "../collaborations/AddToChatDialog";
import AttentionBanner from "../collaborations/AttentionBanner";
import DeleteConnectionText from "../collaborations/DeleteConnectionText";
import { deleteConnection, mayHoldChats } from "../collaborations/deleteConnection";
import InstalledAppsSection from "../collaborations/InstalledAppsSection";
import RegisterMessagingAppDialog from "../collaborations/RegisterMessagingAppDialog";
import TeamsPlacementDialog from "../collaborations/TeamsPlacementDialog";
import { useAppLogos } from "./appLogos";
import { accountHandle, statusColor } from "./chatAccounts";
import { useMyAccounts } from "./useMyAccounts";
import YourAccountsSection from "./YourAccountsSection";

type AppRow = BridgeDetail & { id: string };

/** Older links per app: how many, or why they could not be counted. */
type OlderLinks = Record<string, { links: UnconfirmedLink[] } | { error: string }>;

type Notice = { severity: "success" | "error"; text: string };

/** How often the page re-reads your accounts while one waits to be confirmed
 * from the account, slower than the dialog's own watch. */
const WAITING_POLL_MS = 10_000;

const PINNED = ["actions"];

const SEARCH = {
  label: "Search apps",
  text: (row: AppRow) => `${row.display_name} ${platformLabel(row.bridge_type)}`,
};

/** What a row's controls need that changes as the admin works: which app is
 * saving, how to save, what its menu offers. Read from context by the cells,
 * so the table's columns never depend on it: a new column model drops any
 * width the admin dragged. */
interface RowControls {
  savingId: string | null;
  save: (app: BridgeDetail, update: BridgeUpdateInput) => Promise<void>;
  actionsOf: (row: AppRow) => RowAction[];
}

const RowControlsContext = createContext<RowControls | null>(null);

function useRowControls(): RowControls {
  const controls = useContext(RowControlsContext);
  if (controls === null) throw new Error("a messaging app row rendered outside its table");
  return controls;
}

/**
 * Workspace settings › Messaging apps, in the new layout.
 *
 * Two sections with two owners. The table is the workspace's messaging apps
 * and their settings, so it is for whoever administers the workspace; a
 * member sees no read-only copy of it. "Your accounts" is each person's own
 * side of those apps, and everyone has it. A member also keeps the chats of a
 * platform that joins Switch one chat at a time (Telegram), since Switch lets
 * them add and disconnect those.
 */
export default function MessagingAppsPage() {
  const { capabilities, session, user } = useAuth();
  const isAdmin = capabilities.administersWorkspace;
  const workspaceName = session?.tenant?.name ?? "this workspace";
  // Whether this workspace is one of the viewer's own: the platform operator
  // may be in one they entered without belonging to it.
  const standsHere = session?.tenants.some((t) => t.id === session.tenant?.id) ?? false;
  const { data: bridges, loading, error: loadError, refetch } = useBridges();
  // Read again now and then while a link waits to be confirmed: the number
  // is often tapped on a phone after the dialog is closed, and the row should
  // not go on saying it waits.
  const [awaiting, setAwaiting] = useState(false);
  const accounts = useMyAccounts(awaiting ? WAITING_POLL_MS : null);
  useEffect(() => {
    setAwaiting(
      (accounts.pending ?? []).length > 0 || (accounts.linked ?? []).some((i) => i.awaiting_confirmation),
    );
  }, [accounts.pending, accounts.linked]);
  const logos = useAppLogos();
  const [registerOpen, setRegisterOpen] = useState(false);
  // Bumped to reload the chats and installs below after something that
  // changes them: deleting an app disconnects its chats.
  const [installsVersion, setInstallsVersion] = useState(0);

  const appsFailed = loadError !== null && bridges === null;
  // Both stable, so the table's columns, which depend on this, are not
  // rebuilt on every render (a rebuilt column model drops a dragged width).
  const refreshAccounts = accounts.refresh;
  const refreshAll = useCallback(() => {
    refetch();
    refreshAccounts();
  }, [refetch, refreshAccounts]);

  return (
    <Box>
      <Stack direction="row" alignItems="flex-start" spacing={2} mb={3}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h5">Messaging apps</Typography>
          <Typography variant="body2" color="text.secondary" mt={0.5}>
            {isAdmin
              ? `The messaging apps connected to ${workspaceName}, and who you are inside them.`
              : `Who you are in the messaging apps connected to ${workspaceName}.`}
          </Typography>
        </Box>
        {isAdmin && (
          <Button variant="contained" startIcon={<AddOutlined />} onClick={() => setRegisterOpen(true)}>
            Add messaging app
          </Button>
        )}
      </Stack>

      {isAdmin && (
        <ConnectedApps
          workspaceName={workspaceName}
          bridges={bridges}
          loading={loading && bridges === null}
          failed={appsFailed}
          staleError={bridges !== null ? loadError : null}
          logos={logos}
          onChanged={refreshAll}
          onChatsChanged={() => setInstallsVersion((v) => v + 1)}
        />
      )}

      <Box mt={isAdmin ? 5 : 0}>
        <YourAccountsSection
          apps={bridges}
          appsFailed={appsFailed}
          accounts={accounts}
          logos={logos}
          currentUserId={user?.id ?? null}
          standsHere={standsHere}
          showHeading={isAdmin}
        />
      </Box>

      <InstalledAppsSection key={installsVersion} onConnectionsChanged={refreshAll} memberView={!isAdmin} />

      <RegisterMessagingAppDialog
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onSuccess={refreshAll}
      />
    </Box>
  );
}

/** The admin's table of the workspace's messaging apps, with everything that
 * changes one. */
function ConnectedApps({
  workspaceName,
  bridges,
  loading,
  failed,
  staleError,
  logos,
  onChanged,
  onChatsChanged,
}: {
  workspaceName: string;
  bridges: BridgeDetail[] | null;
  loading: boolean;
  failed: boolean;
  /** A re-read that failed after the list loaded, which still shows. */
  staleError: string | null;
  logos: ReadonlyMap<string, string>;
  onChanged: () => void;
  onChatsChanged: () => void;
}) {
  const { data: installablePlatforms } = useInstallablePlatforms();
  const [savingId, setSavingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [installTarget, setInstallTarget] = useState<BridgeDetail | null>(null);
  const [teamsTarget, setTeamsTarget] = useState<BridgeDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BridgeDetail | null>(null);
  const [olderTarget, setOlderTarget] = useState<{ app: BridgeDetail; links: UnconfirmedLink[] } | null>(null);
  const [olderLinks, setOlderLinks] = useState<OlderLinks>({});

  // Sorted busiest first, as the design has it; a header click re-sorts.
  const rows = useMemo<AppRow[]>(
    () =>
      [...(bridges ?? [])]
        .sort((a, b) => b.room_count - a.room_count || a.display_name.localeCompare(b.display_name))
        .map((b) => ({ ...b, id: b.bridge_id })),
    [bridges],
  );

  // The links each app still trusts from before links had to be confirmed,
  // for the menu item that stops trusting them. Keyed on the ids, so a
  // re-read of the same apps does not ask again.
  const managedKey = rows
    .filter((row) => row.can_manage)
    .map((row) => row.bridge_id)
    .join(",");
  useEffect(() => {
    if (managedKey === "") return;
    let current = true;
    void Promise.all(
      managedKey.split(",").map(async (id) => {
        try {
          return [id, { links: await fetchUnconfirmedLinks(id) }] as const;
        } catch (e) {
          return [id, { error: e instanceof Error ? e.message : String(e) }] as const;
        }
      }),
    ).then((found) => {
      if (current) setOlderLinks(Object.fromEntries(found));
    });
    return () => {
      current = false;
    };
  }, [managedKey]);

  const save = useCallback(
    async (app: BridgeDetail, update: BridgeUpdateInput) => {
      setSavingId(app.bridge_id);
      try {
        await updateBridge(app.bridge_id, update);
      } catch (e) {
        setNotice({ severity: "error", text: e instanceof Error ? e.message : "Failed to save the change" });
      } finally {
        setSavingId(null);
        onChanged();
      }
    },
    [onChanged],
  );

  // Re-approval is the same install flow "Add to…" starts: the same
  // workspace approving again refreshes the existing install.
  const approveAgain = async (app: BridgeDetail) => {
    setApprovingId(app.bridge_id);
    try {
      window.location.href = await beginAppInstall(app.bridge_type);
    } catch (e) {
      setNotice({ severity: "error", text: e instanceof Error ? e.message : "Failed to start the install" });
      setApprovingId(null);
    }
  };

  // Read again on opening, as the admin is about to agree to exactly the
  // list shown: links confirmed since the page loaded drop out of it.
  const reviewOlderLinks = async (app: BridgeDetail) => {
    try {
      const links = await fetchUnconfirmedLinks(app.bridge_id);
      setOlderLinks((current) => ({ ...current, [app.bridge_id]: { links } }));
      if (links.length > 0) setOlderTarget({ app, links });
      else setNotice({ severity: "success", text: `No older links are left in ${app.display_name}.` });
    } catch (e) {
      setNotice({
        severity: "error",
        text: `Could not read the older links in ${app.display_name}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const copyWebhook = async (app: BridgeDetail, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setNotice({ severity: "success", text: `Copied the webhook address for ${app.display_name}.` });
    } catch {
      setNotice({ severity: "error", text: `Could not copy. The address is ${url}` });
    }
  };

  const actionsOf = useCallback(
    (row: AppRow): RowAction[] => {
      const platform = platformLabel(row.bridge_type);
      const actions: RowAction[] = [];
      if (row.can_manage && row.team_placement_supported) {
        actions.push({
          label: "Manage Microsoft Teams…",
          icon: <GroupsOutlined fontSize="small" />,
          onClick: () => setTeamsTarget(row),
        });
      }
      if (row.can_manage && (row.install_links ?? []).length > 0) {
        actions.push({
          label: "Add to a chat…",
          icon: <AddLinkOutlined fontSize="small" />,
          onClick: () => setInstallTarget(row),
        });
      }
      if (row.home_url) {
        const url = row.home_url;
        actions.push({
          label: `Open in ${platform}`,
          icon: <OpenInNewOutlined fontSize="small" />,
          onClick: () => window.open(url, "_blank", "noopener,noreferrer"),
        });
      }
      if (row.can_manage && row.receives_webhooks) {
        const url = row.webhook_url;
        actions.push({
          label: "Copy webhook address",
          icon: <ContentCopyOutlined fontSize="small" />,
          onClick: () => url && void copyWebhook(row, url),
          disabledReason:
            url === null
              ? `${platform} sends events to a public address, and Switch's configuration has none. Set MESSAGING_PUBLIC_URL.`
              : null,
        });
      }
      const older = olderLinks[row.bridge_id];
      if (row.can_manage && older !== undefined) {
        if ("error" in older) {
          actions.push({
            label: "Require confirmation for older links…",
            icon: <VerifiedUserOutlined fontSize="small" />,
            onClick: () => {},
            disabledReason: `Could not check for older links: ${older.error}`,
          });
        } else if (older.links.length > 0) {
          actions.push({
            label: `Require confirmation for older links (${older.links.length})…`,
            icon: <VerifiedUserOutlined fontSize="small" />,
            onClick: () => void reviewOlderLinks(row),
          });
        }
      }
      if (row.can_delete) {
        actions.push({
          label: "Delete…",
          icon: <DeleteOutline fontSize="small" />,
          destructive: true,
          onClick: () => setDeleteTarget(row),
        });
      }
      return actions;
    },
    [olderLinks],
  );

  const columns = useMemo<TableColumn<AppRow>[]>(
    () => [
      {
        field: "display_name",
        headerName: "Name",
        flex: 1,
        minWidth: 180,
        renderCell: ({ row }) => (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ height: "100%", minWidth: 0 }}>
            <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
              {row.display_name}
            </Typography>
            {row.is_default && (
              <Tooltip title="New rooms use this app when none is chosen.">
                <Chip size="small" label="Default" />
              </Tooltip>
            )}
          </Stack>
        ),
      },
      {
        field: "bridge_type",
        headerName: "Type",
        width: 170,
        valueGetter: (value) => platformLabel(String(value)),
        filter: { value: (row) => platformLabel(row.bridge_type) },
        renderCell: ({ row }) => {
          const logo = logos.get(row.bridge_type);
          return (
            <Chip
              size="small"
              variant="outlined"
              label={platformLabel(row.bridge_type)}
              icon={
                logo ? <Box component="img" src={logo} alt="" sx={{ width: 14, height: 14 }} /> : undefined
              }
            />
          );
        },
      },
      {
        field: "status",
        headerName: "Status",
        width: 120,
        filter: { value: (row) => sentenceCase(row.status) },
        renderCell: ({ row }) => (
          <Chip size="small" label={sentenceCase(row.status)} color={statusColor(row.status)} />
        ),
      },
      {
        field: "room_count",
        headerName: "Rooms",
        width: 90,
        type: "number",
        renderCell: ({ value }) => <Box sx={TABULAR_SX}>{String(value)}</Box>,
      },
      {
        field: "agent_greetings_enabled",
        headerName: "Agent greetings",
        width: 150,
        sortable: false,
        renderCell: ({ row, tabIndex }) => <GreetingsSwitch row={row} tabIndex={tabIndex} />,
      },
      {
        field: "channel_creation_enabled",
        headerName: "Channel creation",
        width: 160,
        sortable: false,
        renderCell: ({ row, tabIndex }) => <ChannelCreationSwitch row={row} tabIndex={tabIndex} />,
      },
      {
        field: "created_at",
        headerName: "Created",
        width: 130,
        valueFormatter: (value) => formatDate(value as string),
      },
      {
        field: "actions",
        headerName: "",
        width: 56,
        sortable: false,
        renderCell: ({ row, tabIndex }) => <RowMenu row={row} tabIndex={tabIndex} />,
      },
    ],
    [logos],
  );
  const controls = useMemo<RowControls>(() => ({ savingId, save, actionsOf }), [savingId, save, actionsOf]);

  const needsAttention = rows.filter((row) => row.attention);

  return (
    <Box component="section" aria-label={`Connected to ${workspaceName}`}>
      <Typography variant="h6" component="h2" mb={2}>
        Connected to {workspaceName}
      </Typography>

      {needsAttention.map((row) => (
        <AttentionBanner
          key={row.bridge_id}
          displayName={row.display_name}
          message={row.attention ?? ""}
          canApproveAgain={
            row.can_manage &&
            row.team_placement_supported &&
            (installablePlatforms ?? []).includes(row.bridge_type)
          }
          approving={approvingId === row.bridge_id}
          onApproveAgain={() => void approveAgain(row)}
        />
      ))}

      {staleError !== null && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Couldn&apos;t refresh the messaging apps, so this may be out of date. Reload the page to try again.
        </Alert>
      )}

      {loading ? (
        <CircularProgress aria-label="Loading the messaging apps" />
      ) : failed ? (
        <Alert severity="error">Could not load the messaging apps. Reload the page to try again.</Alert>
      ) : (
        <RowControlsContext.Provider value={controls}>
          <DataTable
            rows={rows}
            columns={columns}
            height={480}
            search={SEARCH}
            pinnedRight={PINNED}
            emptyState={
              <TableEmptyState title="No messaging apps yet">
                Add one to bring a Slack, Mattermost, Discord, Teams or Telegram workspace into rooms.
              </TableEmptyState>
            }
          />
        </RowControlsContext.Provider>
      )}

      <AddToChatDialog bridge={installTarget} onClose={() => setInstallTarget(null)} />
      <TeamsPlacementDialog bridge={teamsTarget} onClose={() => setTeamsTarget(null)} onChanged={onChanged} />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete messaging app"
        description={deleteTarget && <DeleteConnectionText bridge={deleteTarget} />}
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={async () => {
          if (deleteTarget === null) return;
          try {
            // A connection an install created is refused here, and the
            // refusal says to disconnect the app instead.
            await deleteConnection(deleteTarget);
          } finally {
            onChanged();
            // Its chats were disconnected on the way, however far it got.
            if (mayHoldChats(deleteTarget)) onChatsChanged();
          }
        }}
        onClose={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={olderTarget !== null}
        title="Require confirmation for older links?"
        description={olderTarget && <OlderLinksText app={olderTarget.app} links={olderTarget.links} />}
        confirmLabel="Require confirmation"
        tone="plain"
        onConfirm={async () => {
          if (olderTarget === null) return;
          // Exactly the links listed here, not whichever are unconfirmed by now.
          const moved = await requireLinkConfirmation(olderTarget.app.bridge_id, olderTarget.links);
          setNotice({
            severity: "success",
            text:
              moved === 0
                ? "No links needed confirming."
                : `${pluralize(moved, "link")} now ${moved === 1 ? "needs" : "need"} confirming.`,
          });
          setOlderLinks((current) => ({ ...current, [olderTarget.app.bridge_id]: { links: [] } }));
          onChanged();
        }}
        onClose={() => setOlderTarget(null)}
      />

      <Snackbar
        open={notice !== null}
        autoHideDuration={notice?.severity === "error" ? null : 4000}
        onClose={() => setNotice(null)}
      >
        {notice ? (
          <Alert severity={notice.severity} onClose={() => setNotice(null)} sx={{ overflowWrap: "anywhere" }}>
            {notice.text}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}

function GreetingsSwitch({ row, tabIndex }: { row: AppRow; tabIndex: number }) {
  const { savingId, save } = useRowControls();
  return (
    <Switch
      size="small"
      checked={row.agent_greetings_enabled}
      disabled={!row.can_manage || savingId === row.bridge_id}
      slotProps={{ input: { "aria-label": `Agent greetings for ${row.display_name}`, tabIndex } }}
      onChange={(e) => void save(row, { agent_greetings_enabled: e.target.checked })}
    />
  );
}

function ChannelCreationSwitch({ row, tabIndex }: { row: AppRow; tabIndex: number }) {
  const { savingId, save } = useRowControls();
  return (
    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ height: "100%" }}>
      <Switch
        size="small"
        checked={row.channel_creation_supported && row.channel_creation_enabled}
        disabled={!row.can_manage || savingId === row.bridge_id || !row.channel_creation_supported}
        slotProps={{ input: { "aria-label": `Channel creation for ${row.display_name}`, tabIndex } }}
        onChange={(e) => void save(row, { channel_creation_enabled: e.target.checked })}
      />
      {/* "Off" and "this platform has no such thing" look alike as a greyed
          switch, so the second says so, where a keyboard can reach it. */}
      {!row.channel_creation_supported && (
        <InfoTip label={`Why channel creation is off for ${row.display_name}`}>
          {platformLabel(row.bridge_type)} can&apos;t create channels from Switch. Make the chat in the app and add
          the bot to it.
        </InfoTip>
      )}
    </Stack>
  );
}

function RowMenu({ row, tabIndex }: { row: AppRow; tabIndex: number }) {
  const { actionsOf } = useRowControls();
  return <RowActionsMenu label={`Actions for ${row.display_name}`} actions={actionsOf(row)} tabIndex={tabIndex} />;
}

/** Who stops being recognised, and until when, before an admin agrees to it. */
function OlderLinksText({ app, links }: { app: BridgeDetail; links: UnconfirmedLink[] }) {
  return (
    <>
      These links in {app.display_name} were made before links had to be confirmed, so nobody proved they own the
      account:
      <Box component="ul" sx={{ pl: 2.5, my: 1 }}>
        {links.map((link) => (
          <li key={`${link.id}:${link.user_id}`}>
            {link.user_name} as {accountHandle(link.external_username)}
          </li>
        ))}
      </Box>
      Each link stops counting now. Until its owner posts a code from that account, which they get under Your
      accounts on this page or in Switch Console, agents that answer only their owner won&apos;t recognise them in{" "}
      {app.display_name}.
    </>
  );
}

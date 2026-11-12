import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import ContentCopy from "@mui/icons-material/ContentCopy";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import DataTable, {
  type FilterOption,
  type SelectFilter,
  type TableColumn,
  TableEmptyState,
} from "../../components/DataTable";
import InfoTip from "../../components/InfoTip";
import PageBanner from "../../components/PageBanner";
import RowActionsMenu, { type RowAction } from "../../components/RowActionsMenu";
import { useAuth } from "../../data/AuthContext";
import {
  type ApiKeyDetail,
  deleteApiKey,
  loadApiKeys,
  loadWorkspaceApiKeys,
  revealApiKey,
} from "../../data/api";
import { type ListScope, listScopeOf } from "../../data/listScope";
import { MONO_SX, formatDate } from "../../theme/format";
import CreateKeyDialog from "../registration-keys/CreateKeyDialog";
import { formatKeyExpiry } from "../registration-keys/keyExpiry";
import { useLoad } from "../workspace/useLoad";

/** Kept stable: a fresh array each render would rebuild the grid's columns. */
const PINNED = ["actions"];

/** The table's header and footer, and a row, in pixels; a page of rows. */
const TABLE_CHROME = 108;
const ROW = 52;
const PAGE_SIZE = 10;

const byLabel = (a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label);

/** What an agent key is called: its agent's name now, or, its agent gone,
 *  the name it was made for. */
export function agentKeyName(key: ApiKeyDetail): string {
  return key.agent_name ?? `${key.label} (agent deleted)`;
}

interface Notice {
  severity: "success" | "error";
  text: string;
}

/** The workspace's API keys, or a member's own: the keys that add agents to
 *  it, and the key each agent signs in with. Only a key's owner can copy it;
 *  an admin sees everyone's by fingerprint, and deletes anyone's key that
 *  adds agents. */
export default function ApiKeysPage() {
  const { session, capabilities } = useAuth();
  const tenant = session?.tenant;
  if (!session || !tenant) return <CircularProgress />;

  const scope = listScopeOf(capabilities);
  // A change of role changes what the lists hold; start them again.
  return <ApiKeys key={scope} scope={scope} userId={session.user.id} workspace={tenant.name} />;
}

function ApiKeys({ scope, userId, workspace }: { scope: ListScope; userId: string; workspace: string }) {
  const yours = scope === "yours";
  const { data, error, loading, refetch } = useLoad(yours ? loadApiKeys : loadWorkspaceApiKeys);
  const [createOpen, setCreateOpen] = useState(false);
  // What the delete dialog shows, taken when it opens and kept after it
  // closes, so it fades out with the words it had.
  const [deleting, setDeleting] = useState<ApiKeyDetail | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const keys = useMemo(() => data ?? [], [data]);
  const addingKeys = useMemo(() => keys.filter((key) => key.type !== "agent"), [keys]);
  const agentKeys = useMemo(() => keys.filter((key) => key.type === "agent"), [keys]);

  const copy = useCallback(async (key: ApiKeyDetail, name: string) => {
    let plaintext: string;
    try {
      plaintext = await revealApiKey(key.id);
    } catch (err) {
      setNotice({ severity: "error", text: `Couldn't copy ${name}: ${err instanceof Error ? err.message : err}` });
      return;
    }
    try {
      await navigator.clipboard.writeText(plaintext);
    } catch {
      setNotice({ severity: "error", text: "Your browser blocked the clipboard, so nothing was copied." });
      return;
    }
    setNotice({ severity: "success", text: `Copied ${name}.` });
  }, []);

  const actionsFor = useCallback(
    (key: ApiKeyDetail, name: string): RowAction[] => {
      const actions: RowAction[] = [];
      if (key.can_reveal) {
        actions.push({
          label: "Copy key",
          icon: <ContentCopy fontSize="small" />,
          onClick: () => void copy(key, name),
        });
      }
      if (key.can_delete) {
        actions.push({
          label: "Delete",
          icon: <DeleteOutline fontSize="small" />,
          destructive: true,
          onClick: () => {
            setDeleting(key);
            setDeleteOpen(true);
          },
        });
      }
      return actions;
    },
    [copy],
  );

  const ownerOptions = useCallback(
    (rows: ApiKeyDetail[]): FilterOption[] =>
      [...new Map(rows.map((key) => [key.owner_id, key.owner_name])).entries()]
        .map(([value, label]) => ({ value, label }))
        .sort(byLabel),
    [],
  );

  const columnsFor = useCallback(
    (rows: ApiKeyDetail[], kind: "adding" | "agent"): TableColumn<ApiKeyDetail>[] => {
      const nameOf = (key: ApiKeyDetail) => (kind === "agent" ? agentKeyName(key) : key.label);
      return [
        {
          field: "label",
          headerName: kind === "agent" ? "Agent" : "Label",
          flex: 1,
          minWidth: 200,
          valueGetter: (_value, row) => nameOf(row),
          renderCell: ({ row }) => (
            <Box component="span" sx={{ fontWeight: 500 }} title={nameOf(row)}>
              {nameOf(row)}
            </Box>
          ),
        },
        ...(yours
          ? []
          : [
              {
                field: "owner_name",
                headerName: "Owner",
                width: 160,
                filter: { value: (key: ApiKeyDetail) => key.owner_id, options: ownerOptions(rows) },
              } satisfies TableColumn<ApiKeyDetail>,
            ]),
        {
          field: "key_prefix",
          headerName: "Fingerprint",
          width: 170,
          sortable: false,
          renderCell: ({ row }) => (
            <Typography component="span" sx={MONO_SX} title="The start of the key's hash, not of the key">
              {row.key_prefix}
            </Typography>
          ),
        },
        {
          field: "created_at",
          headerName: "Created",
          width: 120,
          type: "date",
          valueGetter: (value) => new Date(value as string),
          valueFormatter: (value) => formatDate(value as Date),
        },
        ...(kind === "adding"
          ? [
              {
                field: "expires_at",
                headerName: "Expires",
                width: 140,
                valueFormatter: (value: string | null) => formatKeyExpiry(value, new Date()),
              } satisfies TableColumn<ApiKeyDetail>,
            ]
          : []),
        {
          field: "actions",
          headerName: "",
          width: 56,
          sortable: false,
          disableColumnMenu: true,
          renderCell: ({ row, tabIndex }) => (
            <RowActionsMenu
              label={`Actions for ${nameOf(row)}`}
              actions={actionsFor(row, kind === "agent" ? `the key of ${nameOf(row)}` : `"${row.label}"`)}
              tabIndex={tabIndex}
            />
          ),
        },
      ];
    },
    [yours, ownerOptions, actionsFor],
  );

  const addingColumns = useMemo(() => columnsFor(addingKeys, "adding"), [columnsFor, addingKeys]);
  const agentColumns = useMemo(() => columnsFor(agentKeys, "agent"), [columnsFor, agentKeys]);

  const selectFilters = useMemo<SelectFilter[]>(
    () => (yours ? [] : [{ field: "owner_name", label: "Owner", allLabel: "All owners" }]),
    [yours],
  );
  const addingSearch = useMemo(
    () => ({
      label: "Search keys",
      text: (key: ApiKeyDetail) => [key.label, key.key_prefix, key.owner_name].join(" "),
    }),
    [],
  );
  const agentSearch = useMemo(
    () => ({
      label: "Search agent keys",
      text: (key: ApiKeyDetail) => [agentKeyName(key), key.key_prefix, key.owner_name].join(" "),
    }),
    [],
  );

  const table = (
    rows: ApiKeyDetail[],
    columns: TableColumn<ApiKeyDetail>[],
    search: { label: string; text: (key: ApiKeyDetail) => string },
    noun: { one: string; other: string },
    empty: ReactNode,
  ) =>
    rows.length === 0 ? (
      empty
    ) : (
      <DataTable
        rows={rows}
        columns={columns}
        height={TABLE_CHROME + ROW * Math.min(rows.length, PAGE_SIZE)}
        pageSize={PAGE_SIZE}
        noun={noun}
        search={search}
        selectFilters={selectFilters}
        initialSort={{ field: "created_at", sort: "desc" }}
        pinnedRight={PINNED}
      />
    );

  let body: ReactNode;
  if (data === null && loading) {
    body = <CircularProgress aria-label="Loading API keys" />;
  } else if (data === null) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void refetch()}>
            Retry
          </Button>
        }
      >
        Couldn't load the API keys: {error}
      </Alert>
    );
  } else {
    body = (
      <Stack spacing={4}>
        <Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 2 }}>
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
              Keys for adding agents
            </Typography>
            <InfoTip>Each lets whoever holds it add agents to {workspace}.</InfoTip>
          </Stack>
          {table(
            addingKeys,
            addingColumns,
            addingSearch,
            { one: "key", other: "keys" },
            <TableEmptyState title={yours ? "You don't hold a key for adding agents here" : "No keys for adding agents yet"}>
              Create one to add an agent to {workspace}.
            </TableEmptyState>,
          )}
        </Box>
        <Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 2 }}>
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
              Agent keys
            </Typography>
            <InfoTip>
              One per agent, made when it's added. It's how the agent signs in, so only its owner can copy it, and it
              goes when the agent is deleted.
            </InfoTip>
          </Stack>
          {table(
            agentKeys,
            agentColumns,
            agentSearch,
            { one: "agent key", other: "agent keys" },
            <TableEmptyState title={yours ? "None of your agents has a key here" : "No agent keys yet"}>
              An agent gets its own key when it's added.
            </TableEmptyState>,
          )}
        </Box>
      </Stack>
    );
  }

  const deletingOthers = deleting !== null && deleting.owner_id !== userId;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start", justifyContent: "space-between", mb: 3 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5">API keys</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {yours ? `Your keys in ${workspace}.` : `The keys in ${workspace}. Only a key's owner can copy it.`}
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddCircleOutline />} onClick={() => setCreateOpen(true)}>
          Create API key
        </Button>
      </Stack>

      {data !== null && error !== null && (
        <Box sx={{ mb: 2 }}>
          <PageBanner
            tone="warning"
            action={
              <Button color="inherit" size="small" onClick={() => void refetch()}>
                Retry
              </Button>
            }
          >
            Couldn't refresh the API keys: {error}. These are the keys as last loaded.
          </PageBanner>
        </Box>
      )}

      {notice && (
        <Alert severity={notice.severity} onClose={() => setNotice(null)} sx={{ mb: 2 }}>
          {notice.text}
        </Alert>
      )}

      {body}

      <CreateKeyDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => void refetch()} />

      <ConfirmDialog
        open={deleteOpen}
        title="Delete API key"
        tone="destructive"
        confirmLabel="Delete"
        description={
          deleting &&
          (deleting.type === "agent"
            ? `Delete the key "${deleting.label}"? Its agent has been deleted, so nothing signs in with it.`
            : `Delete ${deletingOthers ? `${deleting.owner_name}'s key` : "the key"} "${deleting.label}"? It stops working at once, so nothing more can be added with it. Agents already added with it stay. This can't be undone.`)
        }
        onClose={() => setDeleteOpen(false)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await deleteApiKey(deleting.id);
          } catch (err) {
            // The refusal may be that it is already gone: the list catches up
            // while the dialog says why.
            void refetch();
            throw err;
          }
          setNotice({ severity: "success", text: `Deleted "${deleting.label}".` });
          void refetch();
        }}
      />
    </Box>
  );
}


import AddIcon from "@mui/icons-material/Add";
import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import EditOutlined from "@mui/icons-material/EditOutlined";
import PlayArrowOutlined from "@mui/icons-material/PlayArrowOutlined";
import VerifiedOutlined from "@mui/icons-material/VerifiedOutlined";
import { Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from "@mui/material";
import { type ReactNode, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import ConfirmDialog from "../../components/ConfirmDialog";
import DataTable, { TableEmptyState, type TableColumn } from "../../components/DataTable";
import RowActionsMenu, { type RowAction } from "../../components/RowActionsMenu";
import { useAuth } from "../../data/AuthContext";
import { type TemplateSummary, deleteTemplate, fetchTemplateContent } from "../../data/api";
import { useTemplates } from "../../data/hooks";
import { formatDate } from "../../theme/format";
import CreateTemplateDialog, { type TemplateDraft } from "../resources/CreateTemplateDialog";
import RunInConsoleDialog from "./RunInConsoleDialog";
import {
  type TemplateAction,
  consoleRunLink,
  copyName,
  kindLabel,
  newestFirst,
  ownerLabel,
  templateMenu,
} from "./templateRows";

const NOUN = { one: "template", other: "templates" };

const ACTION_LABELS: Record<TemplateAction, { label: string; icon: ReactNode }> = {
  run: { label: "Run template", icon: <PlayArrowOutlined fontSize="small" /> },
  edit: { label: "Edit template", icon: <EditOutlined fontSize="small" /> },
  duplicate: { label: "Duplicate as my own", icon: <ContentCopyOutlined fontSize="small" /> },
  delete: { label: "Delete template", icon: <DeleteOutline fontSize="small" /> },
};

/** The page's open dialog, one at a time. */
type Dialog =
  | { kind: "create"; draft: TemplateDraft | null }
  | { kind: "run"; template: TemplateSummary }
  | { kind: "delete"; template: TemplateSummary };

/**
 * Templates, a page of its own in the new layout: the workspace's own, which
 * have owners and so a row menu that changes from row to row, and the ones
 * that come with Switch, which nobody changes. Each row's menu follows what
 * the server says the viewer may do with that template.
 */
export default function TemplatesPage() {
  const navigate = useNavigate();
  const { user, session } = useAuth();
  const workspace = session?.tenant ?? null;
  const { data, loading, error, refetch } = useTemplates();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const templates = useMemo(() => data ?? [], [data]);
  const shared = useMemo(() => newestFirst(templates.filter((t) => !t.official)), [templates]);
  const official = useMemo(
    () => templates.filter((t) => t.official).sort((a, b) => b.run_count - a.run_count),
    [templates],
  );

  const open = (template: TemplateSummary) => navigate(`/templates/${encodeURIComponent(template.id)}`);

  const duplicate = async (template: TemplateSummary) => {
    setCopyError(null);
    try {
      const content = await fetchTemplateContent(template.id);
      const mine = new Set(templates.filter((t) => t.owner_id === user?.id).map((t) => t.name));
      setDialog({
        kind: "create",
        draft: {
          name: copyName(template.name, mine),
          description: template.description,
          kind: template.kind,
          // Private until its new owner says otherwise: an admin may be
          // copying a template only its owner and the admins could see.
          access: "private",
          content,
        },
      });
    } catch (e) {
      setCopyError(`Could not copy “${template.name}”: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const actionsFor = (template: TemplateSummary): RowAction[] =>
    templateMenu(template).map(({ action, disabledReason }) => ({
      ...ACTION_LABELS[action],
      destructive: action === "delete",
      disabledReason,
      onClick: () => {
        if (action === "run") setDialog({ kind: "run", template });
        else if (action === "edit") open(template);
        else if (action === "duplicate") void duplicate(template);
        else setDialog({ kind: "delete", template });
      },
    }));

  const nameColumn: TableColumn<TemplateSummary> = {
    field: "name",
    headerName: "Template",
    flex: 2,
    minWidth: 240,
    renderCell: ({ row }) => (
      <Stack sx={{ minWidth: 0, justifyContent: "center", height: "100%" }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
            {row.name}
          </Typography>
          {row.read_visibility === "private" && <Chip size="small" variant="outlined" label="Private" />}
        </Stack>
        <Typography variant="caption" color="text.secondary" noWrap title={row.description}>
          {row.description}
        </Typography>
      </Stack>
    ),
  };
  const typeColumn: TableColumn<TemplateSummary> = {
    field: "kind",
    headerName: "Type",
    width: 120,
    valueGetter: (_value, row) => kindLabel(row.kind),
    filter: { value: (row) => kindLabel(row.kind) },
    renderCell: ({ row }) => <Chip size="small" variant="outlined" label={kindLabel(row.kind)} />,
  };
  const runsColumn: TableColumn<TemplateSummary> = {
    field: "run_count",
    headerName: "Runs",
    type: "number",
    width: 96,
  };
  const actionsColumn: TableColumn<TemplateSummary> = {
    field: "actions",
    headerName: "",
    width: 64,
    sortable: false,
    disableColumnMenu: true,
    renderCell: ({ row, tabIndex }) => (
      <RowActionsMenu label={`Actions for ${row.name}`} actions={actionsFor(row)} tabIndex={tabIndex} />
    ),
  };

  const sharedColumns: TableColumn<TemplateSummary>[] = [
    nameColumn,
    typeColumn,
    {
      field: "owner_name",
      headerName: "Owner",
      flex: 1,
      minWidth: 180,
      valueGetter: (_value, row) => ownerLabel(row),
      filter: { value: (row) => ownerLabel(row) },
      renderCell: ({ row }) => (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0, height: "100%" }}>
          <Typography variant="body2" noWrap>
            {ownerLabel(row)}
          </Typography>
          {row.owner_id !== null && row.owner_id === user?.id && (
            <Chip size="small" label="You" />
          )}
        </Stack>
      ),
    },
    runsColumn,
    {
      field: "updated_at",
      headerName: "Updated",
      width: 120,
      valueFormatter: (value) => formatDate(value as string),
    },
    actionsColumn,
  ];
  // No Updated column: a template that comes with Switch changes only with
  // a release, so it has no date of its own.
  const officialColumns: TableColumn<TemplateSummary>[] = [nameColumn, typeColumn, runsColumn, actionsColumn];

  const workspaceName = workspace?.name ?? "this workspace";
  const newTemplate = (
    <Button variant="contained" startIcon={<AddIcon />} onClick={() => setDialog({ kind: "create", draft: null })}>
      New template
    </Button>
  );

  return (
    <Box>
      <Stack direction="row" sx={{ alignItems: "flex-start", justifyContent: "space-between", gap: 2, mb: 3 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5">Templates</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Starting points for a new agent, room or group in {workspaceName}.
          </Typography>
        </Box>
        {newTemplate}
      </Stack>

      {copyError && (
        <Alert severity="error" onClose={() => setCopyError(null)} sx={{ mb: 2 }}>
          {copyError}
        </Alert>
      )}

      {error && data !== null && (
        // A refresh that failed after an action: what is on screen stays,
        // since it was right a moment ago, with why it could not be updated.
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not refresh templates: {error}
        </Alert>
      )}
      {error && data === null ? (
        // Shown in place of the tables: an empty table would read as a
        // workspace with no templates.
        <Alert severity="error">Could not load templates: {error}</Alert>
      ) : loading && data === null ? (
        <CircularProgress />
      ) : (
        <Stack spacing={5}>
          <Box component="section" aria-labelledby="shared-templates">
            <Typography id="shared-templates" variant="h6" sx={{ mb: 2 }}>
              Shared templates
            </Typography>
            <DataTable
              rows={shared}
              columns={sharedColumns}
              noun={NOUN}
              search={{
                label: "Search shared templates",
                text: (row) => [row.name, row.description, ownerLabel(row), kindLabel(row.kind)].join(" "),
              }}
              pinnedRight={["actions"]}
              onRowClick={(params) => open(params.row)}
              emptyState={
                <TableEmptyState title={`No shared templates in ${workspaceName} yet`}>
                  Create one to give the workspace a starting point.
                </TableEmptyState>
              }
              sx={{ "& .MuiDataGrid-row": { cursor: "pointer" } }}
            />
          </Box>

          <Box component="section" aria-labelledby="official-templates">
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 2 }}>
              <Typography id="official-templates" variant="h6">
                Official templates
              </Typography>
              <Chip size="small" icon={<VerifiedOutlined />} label="Maintained by Switch" />
            </Stack>
            <DataTable
              rows={official}
              columns={officialColumns}
              pinnedRight={["actions"]}
              onRowClick={(params) => open(params.row)}
              emptyState={<TableEmptyState title="No official templates in this workspace" />}
              sx={{ "& .MuiDataGrid-row": { cursor: "pointer" } }}
            />
          </Box>
        </Stack>
      )}

      {dialog?.kind === "create" && (
        <CreateTemplateDialog
          open
          title={dialog.draft ? "Duplicate template" : "New template"}
          submitLabel={dialog.draft ? "Save copy" : "Create"}
          initial={dialog.draft}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setDialog(null);
            refetch();
            navigate(`/templates/${encodeURIComponent(id)}`);
          }}
        />
      )}
      {dialog?.kind === "run" && workspace && (
        <RunInConsoleDialog
          templateName={dialog.template.name}
          link={consoleRunLink(dialog.template.id, workspace.id, window.location.origin)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          open
          title="Delete template"
          description={`Delete “${dialog.template.name}”? Agents and rooms already made from it keep working. This can’t be undone.`}
          confirmLabel="Delete"
          tone="destructive"
          onConfirm={async () => {
            await deleteTemplate(dialog.template.id);
            refetch();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </Box>
  );
}

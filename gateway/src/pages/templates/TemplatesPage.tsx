import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import EditOutlined from "@mui/icons-material/EditOutlined";
import PersonOutline from "@mui/icons-material/PersonOutline";
import SearchOutlined from "@mui/icons-material/SearchOutlined";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  InputAdornment,
  Link,
  Stack,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import ConfirmDialog from "../../components/ConfirmDialog";
import type { RowAction } from "../../components/RowActionsMenu";
import { SCREEN_READER_ONLY } from "../../components/screenReaderOnly";
import { useAuth } from "../../data/AuthContext";
import { type TemplateSummary, deleteTemplate } from "../../data/api";
import { AGENT_MANAGEMENT, SWITCH_BUDDY } from "../../data/featureFlags";
import { useTemplates } from "../../data/hooks";
import CreateTemplateDialog, { type TemplateDraft } from "../resources/CreateTemplateDialog";
import CreateTemplateMenu, { type CreateWay } from "./CreateTemplateMenu";
import { duplicateDraft } from "./duplicate";
import OpenInConsoleDialog, { UseInConsoleDialog } from "./OpenInConsoleDialog";
import TemplateCard from "./TemplateCard";
import {
  NO_FILTER,
  TEMPLATE_SCOPES,
  TYPE_FILTERS,
  type TemplateFilter,
  type TemplateScope,
  type TypeFilter,
  librarySections,
  narrowed,
  scopeCounts,
  typeCounts,
} from "./templateFilters";
import {
  type TemplateAction,
  consoleBuddyLink,
  consoleRunLink,
  consoleTemplatesLink,
  templateMenu,
} from "./templateRows";

const ACTION_LABELS: Record<TemplateAction, { label: string; icon: ReactNode }> = {
  edit: { label: "Edit template", icon: <EditOutlined fontSize="small" /> },
  duplicate: { label: "Duplicate as my own", icon: <ContentCopyOutlined fontSize="small" /> },
  delete: { label: "Delete template", icon: <DeleteOutline fontSize="small" /> },
};

/** What the two hand-offs to Switch Console say before they open it. */
const CONSOLE_WAYS: Record<"agent" | "console", { title: string; description: string }> = {
  agent: {
    title: "Create with your personal agent",
    description:
      "Your personal agent, switch-buddy, is in Switch Console. Tell it what the template should create, and it writes the template and saves it to this workspace.",
  },
  console: {
    title: "Create in Console",
    description:
      "On Switch Console’s Templates page, choose Create template to import a file, paste or write the YAML, or make a template from a room you already have.",
  },
};

/** The page's open dialog, one at a time. */
type Dialog =
  | { kind: "create"; draft: TemplateDraft | null }
  | { kind: "console"; way: "agent" | "console" }
  | { kind: "use"; template: TemplateSummary }
  | { kind: "delete"; template: TemplateSummary };

/** A label with its count beside it, muted, as the tabs and chips show it. */
function Counted({ label, count }: { label: string; count: number }) {
  return (
    <span>
      {label}{" "}
      <Box component="span" sx={{ ml: 0.25, color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
        {count}
      </Box>
    </span>
  );
}

/**
 * Templates: a library of cards, the workspace's own first and then the
 * ones that come with Switch, most used first. Tabs pick whose, chips the
 * kind, and a search and Only mine narrow both; every count says what you
 * would get by picking it. A card opens its template; Use hands it to Switch
 * Console, and the "…" follows what the server says the viewer may do.
 */
export default function TemplatesPage() {
  const navigate = useNavigate();
  const { user, session, capabilities } = useAuth();
  const workspace = session?.tenant ?? null;
  const { data, loading, error, refetch } = useTemplates();
  const [scope, setScope] = useState<TemplateScope>(NO_FILTER.scope);
  const [type, setType] = useState<TypeFilter>(NO_FILTER.type);
  const [query, setQuery] = useState(NO_FILTER.query);
  const [onlyMine, setOnlyMine] = useState(NO_FILTER.onlyMine);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const templates = data ?? [];
  const filter: TemplateFilter = { scope, type, query, onlyMine, viewerId: user?.id ?? null };
  const scopes = scopeCounts(templates, filter);
  const types = typeCounts(templates, filter);
  const sections = librarySections(templates, filter);
  const shown = sections.reduce((n, s) => n + s.items.length, 0);

  // switch-buddy is served only with both flags on; without it there is no
  // personal agent to ask.
  const ways: CreateWay[] = [
    ...(capabilities.features[AGENT_MANAGEMENT] && capabilities.features[SWITCH_BUDDY] ? ["agent" as const] : []),
    "console",
    "yaml",
  ];

  const clearFilters = () => {
    setScope(NO_FILTER.scope);
    setType(NO_FILTER.type);
    setQuery(NO_FILTER.query);
    setOnlyMine(NO_FILTER.onlyMine);
  };

  const open = (template: TemplateSummary) => navigate(`/templates/${encodeURIComponent(template.id)}`);

  const duplicate = async (template: TemplateSummary) => {
    setCopyError(null);
    try {
      if (user === null) throw new Error("you are not signed in");
      setDialog({ kind: "create", draft: await duplicateDraft(template, user.id) });
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
        if (action === "edit") open(template);
        else if (action === "duplicate") void duplicate(template);
        else setDialog({ kind: "delete", template });
      },
    }));

  const clearable = templates.length > 0 && narrowed(filter);
  const emptyLine =
    templates.length === 0
      ? `There are no templates on ${workspace?.name ?? "this workspace"} yet.`
      : clearable
        ? "No templates match these filters."
        : scope === "workspace"
          ? "No workspace templates yet. Create one, or duplicate an official one to make it your own."
          : "No templates here yet.";

  return (
    <Box>
      <Stack direction="row" sx={{ alignItems: "flex-start", justifyContent: "space-between", gap: 2, mb: 2 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5">Templates</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 680 }}>
            Templates create agents and rooms on this workspace. Pick one, fill in what it asks, and everything it
            describes is created in one go, or nothing is.
          </Typography>
        </Box>
        <CreateTemplateMenu
          ways={ways}
          onChoose={(way) =>
            setDialog(way === "yaml" ? { kind: "create", draft: null } : { kind: "console", way })
          }
        />
      </Stack>

      <Tabs
        value={scope}
        onChange={(_event, next: TemplateScope) => setScope(next)}
        aria-label="Official or workspace templates"
        sx={{ mb: 2.5, borderBottom: 1, borderColor: "divider" }}
      >
        {TEMPLATE_SCOPES.map((s) => (
          <Tab key={s.value} value={s.value} label={<Counted label={s.label} count={scopes[s.value]} />} />
        ))}
      </Tabs>

      <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", mb: 3 }}>
        <TextField
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search templates"
          fullWidth={false}
          sx={{ width: { xs: "100%", sm: 320 } }}
          slotProps={{
            htmlInput: { "aria-label": "Search templates" },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchOutlined fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
        <ToggleButtonGroup
          size="small"
          exclusive
          value={type}
          onChange={(_event, next: TypeFilter | null) => {
            if (next) setType(next);
          }}
          aria-label="Filter by template type"
        >
          {TYPE_FILTERS.map((t) => (
            <ToggleButton key={t.value} value={t.value} sx={{ px: 1.5 }}>
              <Counted label={t.label} count={types[t.value]} />
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {/* Templates you made yourself; the official ones have no owner, so
            they drop out while it is on. */}
        <ToggleButton
          size="small"
          value="mine"
          selected={onlyMine}
          onChange={() => setOnlyMine((on) => !on)}
          sx={{ ml: { sm: "auto" }, px: 1.5, gap: 0.75 }}
        >
          <PersonOutline fontSize="small" />
          Only mine
        </ToggleButton>
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
        // In place of the library: an empty one would read as a workspace
        // with no templates.
        <Alert severity="error">Could not load templates: {error}</Alert>
      ) : loading && data === null ? (
        <CircularProgress />
      ) : (
        <>
          {/* Announced as the filters change the list, since the change
              happens away from the control being used. */}
          <Box role="status" aria-live="polite" sx={SCREEN_READER_ONLY}>
            {`${shown} ${shown === 1 ? "template" : "templates"} shown`}
          </Box>
          {sections.length === 0 ? (
            <Stack spacing={1.5} sx={{ alignItems: "flex-start", py: 5 }}>
              <Typography variant="body2" color="text.secondary">
                {emptyLine}
              </Typography>
              {clearable && (
                <Button variant="outlined" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </Stack>
          ) : (
            <Stack spacing={4}>
              {sections.map((section) => (
                <Box component="section" key={section.id} aria-labelledby={`templates-${section.id}`}>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", mb: 1.5 }}>
                    <Typography
                      id={`templates-${section.id}`}
                      variant="overline"
                      component="h2"
                      sx={{ color: "text.secondary", lineHeight: 1.5 }}
                    >
                      {section.label}
                    </Typography>
                    <Box
                      component="span"
                      sx={{
                        px: 0.75,
                        borderRadius: "6px",
                        backgroundColor: "var(--sw-muted)",
                        color: "text.secondary",
                        fontSize: "0.75rem",
                        fontWeight: 500,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {section.total}
                    </Box>
                    {section.preview && (
                      <Link
                        component="button"
                        variant="body2"
                        onClick={() => setScope("official")}
                        sx={{ ml: "auto" }}
                      >
                        See all {section.total}
                      </Link>
                    )}
                  </Stack>
                  <Box
                    sx={{
                      display: "grid",
                      gap: 2,
                      gridTemplateColumns: {
                        xs: "minmax(0, 1fr)",
                        md: "repeat(2, minmax(0, 1fr))",
                        lg: "repeat(3, minmax(0, 1fr))",
                      },
                    }}
                  >
                    {section.items.map((template) => (
                      <TemplateCard
                        key={template.id}
                        template={template}
                        actions={actionsFor(template)}
                        onOpen={() => open(template)}
                        onUse={() => setDialog({ kind: "use", template })}
                      />
                    ))}
                  </Box>
                </Box>
              ))}
            </Stack>
          )}
        </>
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
      {dialog?.kind === "console" && workspace && (
        <OpenInConsoleDialog
          title={CONSOLE_WAYS[dialog.way].title}
          description={CONSOLE_WAYS[dialog.way].description}
          link={
            dialog.way === "agent"
              ? consoleBuddyLink(workspace.id, window.location.origin)
              : consoleTemplatesLink(workspace.id, window.location.origin)
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "use" && workspace && (
        <UseInConsoleDialog
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

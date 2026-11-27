import "@switch-console/chat-ui/theme.css";
import { ServerPage } from "@switch-console/chat-ui/components/server-page";
import { SHARED_UI_CLASS } from "@switch-console/chat-ui/model/scope";
import { TemplateCard } from "@switch-console/chat-ui/components/template-card";
import {
  CreateTemplateMenu,
  TemplateFilters,
  TemplateResults,
  TemplateScopeTabs,
} from "@switch-console/chat-ui/components/template-catalogue";
import {
  type TemplateKind,
  type TemplateScope,
  matchesFilter,
  scopeCounts,
  toggleKind,
} from "@switch-console/chat-ui/model/template-filters";
import { Alert, AlertAction, AlertDescription } from "@switch-console/chat-ui/primitives/alert";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@switch-console/chat-ui/primitives/dropdown-menu";
import { SearchInput } from "@switch-console/chat-ui/primitives/search-input";
import { Code, Copy, Pencil, Play, SlidersHorizontal, Sparkles, Trash2, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import ConfirmDialog from "../../components/ConfirmDialog";
import { useAuth } from "../../data/AuthContext";
import { type TemplateSummary, deleteTemplate } from "../../data/api";
import { AGENT_MANAGEMENT, SWITCH_BUDDY } from "../../data/featureFlags";
import { useTemplates } from "../../data/hooks";
import CreateTemplateDialog, { type TemplateDraft } from "../resources/CreateTemplateDialog";
import { duplicateDraft } from "./duplicate";
import OpenInConsoleDialog from "./OpenInConsoleDialog";
import TemplateRunDialog from "./TemplateRunDialog";
import {
  type TemplateAction,
  consoleBuddyLink,
  consoleTemplatesLink,
  ownerLabel,
  templateMenu,
} from "./templateRows";

type CreateWay = "agent" | "console" | "yaml";

/** The ways to create a template: the first two hand over to Switch Console;
 * writing the YAML here is for someone on the web without it. */
const WAYS: Record<CreateWay, { label: string; detail: string; icon: ReactNode }> = {
  agent: {
    label: "Create with your personal agent",
    detail: "Opens a chat with your agent",
    icon: <Sparkles className="size-4" />,
  },
  console: { label: "Create in Console", detail: "Fill in the template form", icon: <SlidersHorizontal className="size-4" /> },
  yaml: { label: "Write the YAML here", detail: "Paste it in or load a file", icon: <Code className="size-4" /> },
};

const ACTION_LABELS: Record<TemplateAction, { label: string; icon: ReactNode }> = {
  edit: { label: "Edit template", icon: <Pencil className="size-4" /> },
  duplicate: { label: "Duplicate as my own", icon: <Copy className="size-4" /> },
  delete: { label: "Delete template…", icon: <Trash2 className="size-4" /> },
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

/** A template as the shared catalogue reads it. */
function catalogued(template: TemplateSummary) {
  return {
    name: template.name,
    kind: template.kind,
    official: template.official,
    ownerId: template.owner_id,
    creator: ownerLabel(template),
    description: template.description,
  };
}

/** A menu item, greyed with why when `disabledReason` says so. */
function MenuAction({
  icon,
  label,
  disabledReason,
  destructive,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  disabledReason: string | null;
  destructive: boolean;
  onClick: () => void;
}) {
  return (
    <DropdownMenuItem
      variant={destructive ? "destructive" : "default"}
      disabled={disabledReason !== null}
      onClick={onClick}
    >
      {icon}
      <span className="flex flex-col">
        {label}
        {disabledReason && <span className="text-xs text-foreground-muted">{disabledReason}</span>}
      </span>
    </DropdownMenuItem>
  );
}

/**
 * Templates, as Switch Console shows them: tabs pick whose, a search and the
 * kind chips narrow the cards, and every tab says how many it holds. A card
 * opens its template; its menu uses, edits, duplicates or deletes it, as the
 * server says the viewer may.
 */
export default function TemplatesPage() {
  const navigate = useNavigate();
  const { user, session, capabilities } = useAuth();
  const workspace = session?.tenant ?? null;
  const { data, loading, error, refetch } = useTemplates();
  const [scope, setScope] = useState<TemplateScope>("all");
  const [kinds, setKinds] = useState<readonly TemplateKind[]>([]);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const meId = user?.id ?? null;
  const templates = data ?? [];
  const counts = scopeCounts(templates.map(catalogued), meId);
  const shown = templates.filter((t) => matchesFilter(catalogued(t), { scope, kinds, query, meId }));
  const filtering = query.trim().length > 0 || kinds.length > 0;

  // switch-buddy is served only with both flags on; without it there is no
  // personal agent to ask.
  const ways: CreateWay[] = [
    ...(capabilities.features[AGENT_MANAGEMENT] && capabilities.features[SWITCH_BUDDY] ? ["agent" as const] : []),
    "console",
    "yaml",
  ];

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

  const actionsFor = (template: TemplateSummary) => (
    <>
      <MenuAction
        icon={<Play className="size-4" />}
        label="Use template"
        disabledReason={template.run_blocked_reason}
        destructive={false}
        onClick={() => setDialog({ kind: "use", template })}
      />
      <DropdownMenuSeparator />
      {templateMenu(template).map(({ action, disabledReason }) => (
        <MenuAction
          key={action}
          {...ACTION_LABELS[action]}
          disabledReason={disabledReason}
          destructive={action === "delete"}
          onClick={() => {
            if (action === "edit") open(template);
            else if (action === "duplicate") void duplicate(template);
            else setDialog({ kind: "delete", template });
          }}
        />
      ))}
    </>
  );

  return (
    <div className={`${SHARED_UI_CLASS} flex min-h-0 flex-1 flex-col`}>
    <ServerPage
      width={1000}
      title="Templates"
      term="template"
      description="Templates create agents and rooms on this workspace. Pick one, fill in what it asks, and everything it describes is created in one go, or nothing is."
      action={
        <CreateTemplateMenu>
          {ways.map((way) => (
            <DropdownMenuItem
              key={way}
              onClick={() => setDialog(way === "yaml" ? { kind: "create", draft: null } : { kind: "console", way })}
            >
              {WAYS[way].icon}
              <span className="flex flex-col">
                {WAYS[way].label}
                <span className="text-xs text-foreground-muted">{WAYS[way].detail}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </CreateTemplateMenu>
      }
    >
      <div className="space-y-6">
        {copyError && (
          <Alert variant="destructive">
            <AlertDescription>{copyError}</AlertDescription>
            <AlertAction>
              <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setCopyError(null)}>
                <X className="size-3.5" />
              </Button>
            </AlertAction>
          </Alert>
        )}
        {error && data !== null && (
          // A refresh that failed after an action: what is on screen stays,
          // since it was right a moment ago, with why it could not be updated.
          <Alert variant="destructive">
            <AlertDescription>Could not refresh templates: {error}</AlertDescription>
          </Alert>
        )}

        <TemplateScopeTabs value={scope} onChange={setScope} counts={counts} showYours={meId !== null} />

        <TemplateFilters
          search={
            <SearchInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates"
              aria-label="Search templates by name, description and author"
              containerClassName="w-full"
              className="h-9"
            />
          }
          kinds={kinds}
          onToggleKind={(kind) => setKinds((current) => toggleKind(current, kind))}
        />

        {/* Announced as the filters change the list, since the change
            happens away from the control being used. */}
        <div role="status" aria-live="polite" className="sr-only">
          {data !== null && `${shown.length} ${shown.length === 1 ? "template" : "templates"} shown`}
        </div>

        <TemplateResults
          loading={loading && data === null}
          // In place of the library: an empty one would read as a workspace
          // with no templates.
          error={error && data === null ? `Could not load templates: ${error}` : null}
          onRetry={() => void refetch()}
          recent={[]}
          shown={shown}
          filtering={filtering}
          scope={scope}
          card={(template) => (
            <TemplateCard
              key={template.id}
              template={catalogued(template)}
              onOpen={() => open(template)}
              actions={actionsFor(template)}
            />
          )}
        />
      </div>

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
      {dialog?.kind === "use" && (
        <TemplateRunDialog
          templateId={dialog.template.id}
          templateName={dialog.template.name}
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
    </ServerPage>
    </div>
  );
}

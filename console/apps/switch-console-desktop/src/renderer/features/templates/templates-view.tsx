import {
  ChevronDown,
  CircleAlert,
  ClipboardPaste,
  DoorClosed,
  FileText,
  FileUp,
  Loader2,
  Plus,
  Upload,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StoredTemplateSummary } from '@main/core/switch-servers/gateway-client';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { LIST_PAGE_WIDTH } from '@renderer/lib/components/list-toolbar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useAgentTypeAvailability } from '@renderer/lib/stores/use-agent-type-availability';
import { Alert, AlertAction, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { cn } from '@renderer/utils/utils';
import { useRecentTemplateIds } from './recent-templates';
import { KIND_ICON, TemplateCard } from './template-card';
import {
  matchesFilter,
  scopeCounts,
  TEMPLATE_SCOPES,
  type TemplateKind,
  type TemplateScope,
  toggleKind,
} from './template-filters';

function useServerId(): string {
  return useParams('templates').params.serverId;
}

const TemplatesTitlebar = observer(function TemplatesTitlebar() {
  return <ServerSectionTitlebar serverId={useServerId()} icon={FileText} label="Templates" />;
});

const KIND_CHIPS: readonly { value: TemplateKind; label: string }[] = [
  { value: 'agent', label: 'Agents' },
  { value: 'room', label: 'Rooms' },
  { value: 'group', label: 'Groups' },
];

const RECENT_SHOWN = 3;

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsText(file);
  });
}

function hasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

function ScopeTabs({
  value,
  onChange,
  counts,
  showYours,
}: {
  value: TemplateScope;
  onChange: (scope: TemplateScope) => void;
  counts: Record<TemplateScope, number>;
  /** Only someone signed in has templates to call theirs. */
  showYours: boolean;
}) {
  const scopes = TEMPLATE_SCOPES.filter((s) => showYours || s.value !== 'yours');
  return (
    <div role="tablist" aria-label="Whose templates" className="flex gap-6 border-b border-border">
      {scopes.map((scope) => {
        const active = scope.value === value;
        return (
          <button
            key={scope.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(scope.value)}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-1 pb-2.5 text-sm font-medium transition-colors',
              active
                ? 'border-foreground text-foreground'
                : 'border-transparent text-foreground/70 hover:text-foreground'
            )}
          >
            {scope.label}
            <span className="rounded-md bg-background-2 px-1.5 text-[11px] leading-4 text-foreground">
              {counts[scope.value]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FilterChip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'flex h-9 items-center gap-[7px] rounded-lg border px-3 text-sm font-medium transition-colors',
        pressed
          ? 'border-foreground/40 bg-background-2 text-foreground'
          : 'border-border bg-background text-foreground/70 hover:bg-background-1 hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

function CreateTemplateMenu({
  onImportFile,
  onPaste,
  onFromRoom,
}: {
  onImportFile: () => void;
  onPaste: () => void;
  /** Null when there is no workspace to read rooms from. */
  onFromRoom: (() => void) | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button>
            <Plus className="size-4" />
            Create template
            <ChevronDown className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onImportFile}>
          <FileUp className="size-4" />
          Import a file…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onPaste}>
          <ClipboardPaste className="size-4" />
          Paste or write YAML
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onFromRoom ?? undefined} disabled={onFromRoom === null}>
          <DoorClosed className="size-4" />
          From a room…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-6">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}

const TemplatesPanel = observer(function TemplatesPanel() {
  const serverId = useServerId();
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const me = switchServersStore.statusFor(serverId)?.user ?? null;
  const meId = me?.id ?? null;
  const { navigate } = useNavigate();
  const pickRoom = useShowModal('pickRoomToCaptureModal');
  const confirm = useShowModal('confirmActionModal');
  const fileInput = useRef<HTMLInputElement>(null);

  const [templates, setTemplates] = useState<StoredTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [scopeChosen, setScope] = useState<TemplateScope>('all');
  // With nobody signed in there is no Yours tab to be on.
  const scope = scopeChosen === 'yours' && meId === null ? 'all' : scopeChosen;
  // A caller can open the listing with a kind preselected; the deployer can clear it.
  const initialKind = useParams('templates').params.kind;
  const [kinds, setKinds] = useState<readonly TemplateKind[]>(initialKind ? [initialKind] : []);
  // Navigating here without the param, as the sidebar does, shows every kind.
  useEffect(() => setKinds(initialKind ? [initialKind] : []), [initialKind]);
  const [dragging, setDragging] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  // The server searches name and description; its hits replace the listing
  // while there is a search.
  const [searchHits, setSearchHits] = useState<StoredTemplateSummary[] | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0 || workspaceId === null) {
      setSearchHits(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      rpc.workspaces
        .listTemplates({ workspaceId, q })
        .then((hits) => {
          if (!cancelled) setSearchHits(hits);
        })
        .catch(() => {
          // The client-side match below still applies to what is loaded.
          if (!cancelled) setSearchHits(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [workspaceId, query, reloadKey]);

  // An agent template needs a coding agent where its agents will run, and
  // this computer is the default run location. Say at the top of the listing
  // when it has none, rather than at the end of the Use page; a host gets
  // its own check there.
  const { data: availability } = useAgentTypeAvailability();
  const noProvider = availability !== undefined && !availability.some((a) => a.available);

  useEffect(() => {
    // No workspace is an answer, not a wait: leaving the spinner up would
    // claim a list is on its way.
    if (workspaceId === null) {
      setTemplates([]);
      setListError('This server has no workspace yet, so its templates cannot be read.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setListError(null);
    rpc.workspaces
      .listTemplates({ workspaceId })
      .then((result) => {
        if (!cancelled) setTemplates(result);
      })
      .catch((e: unknown) => {
        // A failed request is shown as a failure, not as an empty workspace.
        if (!cancelled) {
          setTemplates([]);
          setListError(failureText(e, 'Could not read this workspace’s templates.'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, reloadKey]);

  const counts = useMemo(() => scopeCounts(templates, meId), [templates, meId]);
  const shown = useMemo(
    () => (searchHits ?? templates).filter((t) => matchesFilter(t, { scope, kinds, query, meId })),
    [templates, searchHits, scope, kinds, query, meId]
  );
  const filtering = query.trim().length > 0 || kinds.length > 0;

  const recentIds = useRecentTemplateIds(
    workspaceId === null ? null : { workspaceId, userId: meId }
  );
  // Opened ones that are gone, or not on this tab, are left out rather than shown stale.
  const recent = useMemo(() => {
    if (filtering) return [];
    const byId = new Map(templates.map((t) => [t.id, t]));
    return recentIds
      .map((id) => byId.get(id))
      .filter((t): t is StoredTemplateSummary => t !== undefined)
      .filter((t) => matchesFilter(t, { scope, kinds: [], query: '', meId }))
      .slice(0, RECENT_SHOWN);
  }, [filtering, recentIds, templates, scope, meId]);

  // The server says who may delete (an admin may remove an official room template from the
  // workspace); an older server leaves it out, and the owner-or-admin guess stands in.
  const canDelete = (item: StoredTemplateSummary) =>
    item.canManage ??
    (!item.official && ((meId !== null && item.ownerId === meId) || me?.role === 'admin'));
  const deleteTemplate = (item: StoredTemplateSummary) =>
    confirm({
      title: `Delete ${item.name}?`,
      description: 'It is removed from this workspace for everyone. This cannot be undone.',
      confirmLabel: 'Delete',
      onSuccess: () => {
        if (workspaceId === null) return;
        rpc.workspaces
          .deleteTemplate({ workspaceId, templateId: item.id })
          .then(() => {
            toast({ title: `"${item.name}" deleted` });
            reload();
          })
          .catch((e: unknown) =>
            toast({
              title: `Could not delete "${item.name}"`,
              description: failureText(e, 'Check the server connection and try again.'),
              variant: 'destructive',
            })
          );
      },
    });

  const importFile = async (file: File) => {
    try {
      const yamlText = await readFileAsText(file);
      navigate('templateImport', { serverId, yamlText, sourceName: file.name });
    } catch (error) {
      toast({
        title: `Could not read ${file.name}`,
        description: failureText(error, ''),
        variant: 'destructive',
      });
    }
  };

  const captureFromRoom =
    workspaceId === null
      ? null
      : () =>
          pickRoom({
            workspaceId,
            onSuccess: ({ roomId }) => navigate('templateCapture', { serverId, roomId }),
          });

  const grid = 'grid grid-cols-3 gap-6';
  const card = (item: StoredTemplateSummary) => (
    <TemplateCard
      key={item.id}
      template={item}
      onOpen={() => navigate('templateDetail', { serverId, templateId: item.id })}
      onDelete={canDelete(item) ? () => deleteTemplate(item) : null}
    />
  );

  return (
    <ServerPage
      width={LIST_PAGE_WIDTH}
      title="Templates"
      description="Templates create a complete room setup - agents, roles, documents - from a single configuration."
      action={
        <CreateTemplateMenu
          onImportFile={() => fileInput.current?.click()}
          onPaste={() => navigate('templateImport', { serverId })}
          onFromRoom={captureFromRoom}
        />
      }
    >
      <input
        ref={fileInput}
        type="file"
        accept=".yaml,.yml"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importFile(file);
        }}
      />
      {/* The whole page takes a dropped file: the import view is one step
        away, and a file in hand should not have to find a target first. */}
      <div
        className="relative space-y-6"
        onDragEnter={(e) => {
          if (hasFiles(e)) setDragging((n) => n + 1);
        }}
        onDragLeave={(e) => {
          if (hasFiles(e)) setDragging((n) => Math.max(0, n - 1));
        }}
        onDragOver={(e) => {
          if (hasFiles(e)) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(0);
          const file = e.dataTransfer.files[0];
          if (file) void importFile(file);
        }}
      >
        {dragging > 0 && (
          <div className="border-primary pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed bg-[var(--sel-soft)]/90">
            <span className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Upload className="size-4" />
              Drop the template file to import it
            </span>
          </div>
        )}

        {noProvider && (
          <Alert>
            <CircleAlert />
            <AlertDescription>
              No agent provider is set up on this computer yet. A template creates an agent that
              runs here, so it needs an agent CLI such as Claude Code, Codex or OpenCode installed
              first.
            </AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                size="xs"
                onClick={() => navigate('settings', { tab: 'clis-models' })}
              >
                Set up agent providers
              </Button>
            </AlertAction>
          </Alert>
        )}

        <ScopeTabs value={scope} onChange={setScope} counts={counts} showYours={meId !== null} />

        <div className="space-y-3">
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates"
            aria-label="Search templates by name, description and author"
            containerClassName="w-full"
            className="h-9"
          />

          <div
            className="flex flex-wrap items-center gap-2"
            aria-label="Show templates of these kinds"
          >
            {KIND_CHIPS.map(({ value, label }) => {
              const Icon = KIND_ICON[value];
              return (
                <FilterChip
                  key={value}
                  pressed={kinds.includes(value)}
                  onClick={() => setKinds((current) => toggleKind(current, value))}
                >
                  <Icon className="size-4" aria-hidden />
                  {label}
                </FilterChip>
              );
            })}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-foreground-muted" />
          </div>
        ) : listError ? (
          <div className="flex flex-col items-start gap-2 rounded-2xl border border-border px-4 py-4">
            <p className="text-sm text-foreground-muted">{listError}</p>
            <Button size="sm" variant="outline" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="space-y-10 pt-2">
            {recent.length > 0 && (
              <Section title="Recent">
                <div className={grid}>{recent.map(card)}</div>
              </Section>
            )}
            {shown.length > 0 ? (
              recent.length > 0 ? (
                <Section title="All results">
                  <div className={grid}>{shown.map(card)}</div>
                </Section>
              ) : (
                <div className={grid}>{shown.map(card)}</div>
              )
            ) : filtering || scope !== 'all' ? (
              <p className="text-sm text-foreground-muted">
                {scope === 'yours' && !filtering
                  ? 'None of yours yet. Create a template and it shows up here.'
                  : 'No template matches.'}
              </p>
            ) : (
              <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border px-4 py-5">
                <p className="text-sm text-foreground-muted">
                  No template here yet. Create one, and everyone on this workspace finds it here.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </ServerPage>
  );
});

export const templatesView = {
  WrapView: ({
    children,
  }: {
    children: React.ReactNode;
    serverId: string;
    kind?: TemplateKind;
  }) => <>{children}</>,
  TitlebarSlot: TemplatesTitlebar,
  MainPanel: TemplatesPanel,
  canActivate: (params: unknown): GuardResult => {
    const serverId =
      typeof params === 'object' && params !== null
        ? (params as { serverId?: unknown }).serverId
        : undefined;
    if (typeof serverId !== 'string') return { ok: false, redirect: 'home' };
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string; kind?: TemplateKind }>;

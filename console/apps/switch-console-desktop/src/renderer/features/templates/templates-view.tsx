import {
  Bot,
  Boxes,
  CircleAlert,
  DoorOpen,
  FileText,
  Loader2,
  MoreVertical,
  Trash2,
  Upload,
  UserRound,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StoredTemplateSummary } from '@main/core/switch-servers/gateway-client';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useAgentTypeAvailability } from '@renderer/lib/stores/use-agent-type-availability';
import { Alert, AlertAction, AlertDescription } from '@renderer/lib/ui/alert';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Toggle } from '@renderer/lib/ui/toggle';

function useServerId(): string {
  return useParams('templates').params.serverId;
}

const TemplatesTitlebar = observer(function TemplatesTitlebar() {
  return <ServerSectionTitlebar serverId={useServerId()} icon={FileText} label="Templates" />;
});

type Kind = 'agent' | 'room' | 'group';
type KindFilter = 'all' | Kind;

const KIND_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'room', label: 'Rooms', icon: DoorOpen },
  { value: 'agent', label: 'Agents', icon: Bot },
  { value: 'group', label: 'Groups', icon: Boxes },
] as const satisfies readonly {
  value: KindFilter;
  label: string;
  icon?: typeof Bot;
}[];

const KIND_ICON: Record<Kind, typeof Bot> = {
  agent: Bot,
  room: DoorOpen,
  group: Boxes,
};

/** One card in the listing: a template on the workspace, official or saved by someone. */
type TemplateListEntry = {
  id: string;
  kind: Kind;
  name: string;
  description: string;
  server: StoredTemplateSummary;
};

function kindOf(kind: string): Kind {
  return kind === 'agent' || kind === 'group' ? kind : 'room';
}

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

function OwnerRow({ name, mine }: { name: string; mine: boolean }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <span className="flex items-center gap-1.5 text-xs text-foreground-muted">
      <span
        aria-hidden
        className="flex size-4.5 items-center justify-center rounded-full bg-background-2 text-[10px] font-medium text-foreground"
      >
        {initial}
      </span>
      {mine ? 'You' : name}
    </span>
  );
}

function TemplateCard({
  item,
  meId,
  busy,
  onOpen,
  onUse,
  onDelete,
}: {
  item: TemplateListEntry;
  meId: string | null;
  busy: boolean;
  onOpen: () => void;
  onUse: () => void;
  /** Null when the signed-in user may not delete it. */
  onDelete: (() => void) | null;
}) {
  const Icon = KIND_ICON[item.kind];
  const official = item.server.official;
  const mine = !official && meId !== null && item.server.ownerId === meId;
  return (
    <div className="group relative flex min-h-[168px] flex-col rounded-[11px] border border-border bg-background transition-colors hover:border-border-1">
      <button
        type="button"
        aria-label={`Open ${item.name}`}
        className="focus-visible:ring-ring absolute inset-0 cursor-pointer rounded-[11px] focus-visible:ring-2 focus-visible:outline-none"
        onClick={onOpen}
      />
      <div className="pointer-events-none flex flex-1 flex-col gap-2 p-4">
        <div className={`flex items-center gap-2${onDelete ? ' pr-7' : ''}`}>
          <Icon className="size-4.5 shrink-0 text-foreground-muted" />
          <h3 className="min-w-0 truncate font-medium text-foreground">{item.name}</h3>
          {official && (
            <Badge variant="outline" title="Comes with Switch">
              Official
            </Badge>
          )}
          {mine && <Badge variant="secondary">Yours</Badge>}
        </div>
        <p className="line-clamp-3 text-sm text-foreground-muted">
          {item.description || <span className="italic">No description.</span>}
        </p>
        <div className="mt-auto flex flex-col gap-1.5 pt-1 pr-16">
          {!official && <OwnerRow name={item.server.creator} mine={mine} />}
        </div>
      </div>
      {onDelete && (
        <div className="absolute top-2.5 right-2.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0"
                  aria-label={`${item.name} actions`}
                >
                  <MoreVertical className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="size-4" />
                Delete template…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {/* On top of the overlay: the one action that does not need the page. */}
      <div className="absolute right-3 bottom-3">
        <Button size="sm" variant="outline" onClick={onUse} disabled={busy}>
          {busy ? 'Opening…' : 'Use'}
        </Button>
      </div>
    </div>
  );
}

const TemplatesPanel = observer(function TemplatesPanel() {
  const serverId = useServerId();
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const meId = switchServersStore.statusFor(serverId)?.user?.id ?? null;
  const { navigate } = useNavigate();

  const [templates, setTemplates] = useState<StoredTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // A caller can open the listing with a kind preselected; the deployer can clear it.
  const initialKind = useParams('templates').params.kind;
  const [kind, setKind] = useState<KindFilter>(initialKind ?? 'all');
  // Navigating here without the param, as the sidebar does, shows every kind.
  useEffect(() => setKind(initialKind ?? 'all'), [initialKind]);
  const [onlyMine, setOnlyMine] = useState(false);
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

  const templatesShown = useMemo(() => {
    const onWorkspace: TemplateListEntry[] = (searchHits ?? templates).map((t) => ({
      id: t.id,
      kind: kindOf(t.kind),
      name: t.name,
      description: t.description,
      server: t,
    }));
    const needle = query.trim().toLowerCase();
    const matches = (t: TemplateListEntry) =>
      (kind === 'all' || t.kind === kind) &&
      (needle.length === 0 ||
        t.name.toLowerCase().includes(needle) ||
        t.description.toLowerCase().includes(needle) ||
        t.server.creator.toLowerCase().includes(needle));
    const mine = (t: TemplateListEntry) => meId !== null && t.server.ownerId === meId;
    // One list: the badges on each card (Official, Yours, who saved it) say
    // where it comes from.
    return onWorkspace.filter((t) => matches(t) && (!onlyMine || mine(t)));
  }, [templates, searchHits, query, kind, onlyMine, meId]);

  const confirm = useShowModal('confirmActionModal');
  const me = switchServersStore.statusFor(serverId)?.user ?? null;
  // The server says who may delete; an older server leaves it out, and the owner-or-admin guess stands in.
  const canDelete = (item: TemplateListEntry) =>
    !item.server.official &&
    (item.server.canManage ??
      ((meId !== null && item.server.ownerId === meId) || me?.role === 'admin'));
  const deleteTemplate = (item: TemplateListEntry) =>
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

  const handleUse = (item: TemplateListEntry) =>
    navigate('templateUse', { serverId, templateId: item.id });

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

  const grid = 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-[14px]';
  const filtering = query.trim().length > 0 || kind !== 'all' || onlyMine;
  const open = (item: TemplateListEntry) =>
    navigate('templateDetail', { serverId, templateId: item.id });
  const card = (item: TemplateListEntry) => (
    <TemplateCard
      key={item.id}
      item={item}
      meId={meId}
      busy={false}
      onOpen={() => open(item)}
      onUse={() => handleUse(item)}
      onDelete={canDelete(item) ? () => deleteTemplate(item) : null}
    />
  );

  return (
    <ServerPage
      width={1000}
      title="Templates"
      description="Templates create agents and rooms on this workspace. Pick one, fill in what it asks, and everything it describes is created in one go, or nothing is."
      action={
        <Button size="sm" onClick={() => navigate('templateImport', { serverId })}>
          <Upload className="size-4" />
          Import template
        </Button>
      }
    >
      {/* The whole page takes a dropped file: the import view is one step
        away, and a file in hand should not have to find a target first. */}
      <div
        className="relative"
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
          <div className="border-primary pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[11px] border-2 border-dashed bg-[var(--sel-soft)]/90">
            <span className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Upload className="size-4" />
              Drop the template file to import it
            </span>
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-foreground-muted" />
          </div>
        ) : (
          <div className="space-y-8">
            {noProvider && (
              <Alert>
                <CircleAlert />
                <AlertDescription>
                  No agent provider is set up on this computer yet. A template creates an agent that
                  runs here, so it needs an agent CLI such as Claude Code, Codex or OpenCode
                  installed first.
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

            <div className="flex flex-wrap items-center gap-2">
              <SearchInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name and description…"
                aria-label="Search templates by name and description"
                containerClassName="min-w-[220px] flex-1"
                className="h-8"
              />
              <SegmentedControl
                value={kind}
                onChange={setKind}
                options={KIND_OPTIONS}
                ariaLabel="Show templates of one kind"
              />
              <Toggle
                variant="outline"
                size="sm"
                pressed={onlyMine}
                onPressedChange={setOnlyMine}
                aria-label="Only templates you own"
                title={meId ? 'Only templates you saved' : 'Sign in to see which are yours'}
                disabled={meId === null}
              >
                <UserRound />
                Only mine
              </Toggle>
            </div>

            {templatesShown.length > 0 ? (
              <div className={grid}>{templatesShown.map(card)}</div>
            ) : listError ? (
              <div className="flex flex-col items-start gap-2 rounded-[11px] border border-border px-4 py-4">
                <p className="text-sm text-foreground-muted">{listError}</p>
                <Button size="sm" variant="outline" onClick={reload}>
                  Try again
                </Button>
              </div>
            ) : filtering ? (
              <p className="text-sm text-foreground-muted">
                {onlyMine
                  ? 'None of yours match. Import a template and it shows up here as yours.'
                  : 'No template matches.'}
              </p>
            ) : (
              <div className="flex flex-col items-start gap-3 rounded-[11px] border border-dashed border-border px-4 py-5">
                <p className="text-sm text-foreground-muted">
                  No template here yet. Import one, and everyone on this workspace finds it here.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate('templateImport', { serverId })}
                >
                  <Upload className="size-3.5" />
                  Import a template
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </ServerPage>
  );
});

export const templatesView = {
  WrapView: ({ children }: { children: React.ReactNode; serverId: string; kind?: Kind }) => (
    <>{children}</>
  ),
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
} satisfies ViewDefinition<{ serverId: string; kind?: Kind }>;

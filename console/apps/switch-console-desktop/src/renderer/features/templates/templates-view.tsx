import {
  Bot,
  Boxes,
  CircleAlert,
  Clock,
  DoorOpen,
  FileText,
  Loader2,
  Save,
  Upload,
  UserRound,
  Users,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TemplateSummary } from '@main/core/agent-templates/controller';
import type { RecentTemplate } from '@main/core/room-templates/controller';
import type { StoredTemplateSummary } from '@main/core/switch-servers/gateway-client';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useAgentTypeAvailability } from '@renderer/lib/stores/use-switch-setup';
import { Alert, AlertAction, AlertDescription } from '@renderer/lib/ui/alert';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Toggle } from '@renderer/lib/ui/toggle';
import { documentKind, prefillForSave } from './agent-template-data';
import { bundledTemplates } from './bundled-templates';

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

/** One card in the listing: a bundled template, or a template saved on the workspace. */
type TemplateListEntry = {
  /** The id the card opens: a bundled id, or a workspace template id. */
  id: string;
  kind: Kind;
  name: string;
  description: string;
  bundled: boolean;
  server: StoredTemplateSummary | null;
  /** The document text, when it is available without a request (a bundled template). */
  content: string | null;
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

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The card's summary line, for example "Creates 1 room and 2 agents · 4 inputs". */
function summaryLine(s: TemplateSummary): string {
  const parts: string[] = [];
  if (s.rooms > 0) parts.push(plural(s.rooms, 'room'));
  if (s.agents > 0) parts.push(plural(s.agents, 'agent'));
  const creates = parts.length > 0 ? `Creates ${parts.join(' and ')}` : 'Creates nothing yet';
  const inputs = s.inputs === 0 ? 'no inputs' : plural(s.inputs, 'input');
  return `${creates} · ${inputs}`;
}

// The listing endpoint returns no document text, and the summary line
// needs the document. Each card fetches its own once and keeps it for the
// session.
const summaryCache = new Map<string, Promise<TemplateSummary>>();

function fetchSummary(serverId: string, item: TemplateListEntry): Promise<TemplateSummary> {
  const key = `${serverId}:${item.id}`;
  let pending = summaryCache.get(key);
  if (!pending) {
    pending = (async () => {
      const yamlText =
        item.content ??
        (
          await rpc.switchServers.getTemplateDetail({
            serverId,
            templateId: item.id,
          })
        ).definition;
      return rpc.agentTemplates.summarize({ yamlText });
    })();
    pending.catch(() => summaryCache.delete(key));
    summaryCache.set(key, pending);
  }
  return pending;
}

function useTemplateSummary(serverId: string, item: TemplateListEntry): TemplateSummary | null {
  const [summary, setSummary] = useState<TemplateSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchSummary(serverId, item)
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        // The card renders without the summary line when the document cannot be fetched.
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, item]);
  return summary;
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
  serverId,
  item,
  meId,
  busy,
  onOpen,
  onUse,
}: {
  serverId: string;
  item: TemplateListEntry;
  meId: string | null;
  busy: boolean;
  onOpen: () => void;
  onUse: () => void;
}) {
  const Icon = KIND_ICON[item.kind];
  const summary = useTemplateSummary(serverId, item);
  const mine = item.server !== null && meId !== null && item.server.ownerId === meId;
  return (
    <div className="group relative flex min-h-[168px] flex-col rounded-[11px] border border-border bg-background transition-colors hover:border-border-1">
      <button
        type="button"
        aria-label={`Open ${item.name}`}
        className="focus-visible:ring-ring absolute inset-0 cursor-pointer rounded-[11px] focus-visible:ring-2 focus-visible:outline-none"
        onClick={onOpen}
      />
      <div className="pointer-events-none flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-center gap-2">
          <Icon className="size-4.5 shrink-0 text-foreground-muted" />
          <h3 className="min-w-0 truncate font-medium text-foreground">{item.name}</h3>
          {item.bundled && (
            <Badge variant="outline" title="Shipped with Switch">
              Official
            </Badge>
          )}
          {item.server && mine && !item.bundled && <Badge variant="secondary">Yours</Badge>}
          {item.bundled && item.server && (
            <Badge variant="secondary" title="A copy is saved on this workspace; it lists below">
              <Users />
              Saved
            </Badge>
          )}
        </div>
        <p className="line-clamp-3 text-sm text-foreground-muted">
          {item.description || <span className="italic">No description.</span>}
        </p>
        <div className="mt-auto flex flex-col gap-1.5 pt-1 pr-16">
          <span className="text-xs text-foreground-passive">
            {summary ? summaryLine(summary) : ' '}
          </span>
          {item.server && !item.bundled && <OwnerRow name={item.server.creator} mine={mine} />}
        </div>
      </div>
      {/* On top of the overlay: the one action that does not need the page. */}
      <div className="absolute right-3 bottom-3">
        <Button size="sm" variant="outline" onClick={onUse} disabled={busy}>
          {busy ? 'Opening…' : 'Use'}
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-0.5 mb-3 text-xs text-foreground-muted">{subtitle}</p>
      {children}
    </section>
  );
}

function formatTimeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Documents used from this Console, kept locally per workspace. Each can be
 * used again or saved to the workspace, where everyone can find it.
 */
function RecentsSection({
  serverId,
  serverName,
  onWorkspace,
  kind,
  query,
  onSaved,
}: {
  serverId: string;
  serverName: string | null;
  /** Names of templates saved on the workspace. A recent with one of these names gets no Save button. */
  onWorkspace: ReadonlySet<string>;
  /** The listing's kind filter and search text. They apply to the recents too. Only mine does not: every recent is the user's own. */
  kind: KindFilter;
  query: string;
  onSaved: () => void;
}) {
  const { navigate } = useNavigate();
  const showSaveModal = useShowModal('saveTemplateModal');
  const [recents, setRecents] = useState<RecentTemplate[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    rpc.roomTemplates
      .getRecents(serverId)
      // One row per name. The same template used before and after an edit is two
      // documents with one name, and only the newest use is offered.
      .then((list) =>
        setRecents(list.filter((r, i) => list.findIndex((o) => o.name === r.name) === i))
      )
      .catch(() => setRecents([]));
  }, [serverId]);

  const saveToWorkspace = async (recent: RecentTemplate) => {
    setSaving(recent.yamlText);
    try {
      const prefill = await prefillForSave(recent.yamlText, recent.name);
      showSaveModal({
        serverId,
        serverName,
        content: recent.yamlText,
        ...prefill,
        onSuccess: onSaved,
      });
    } catch (error) {
      toast({
        title: `Could not read "${recent.name}"`,
        description: failureText(error, 'The document did not parse.'),
        variant: 'destructive',
      });
    } finally {
      setSaving(null);
    }
  };

  const needle = query.trim().toLowerCase();
  const shown = (recents ?? []).filter(
    (r) =>
      (kind === 'all' || documentKind(r.yamlText) === kind) &&
      (needle.length === 0 || r.name.toLowerCase().includes(needle))
  );
  if (shown.length === 0) return null;

  return (
    <section>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Clock className="size-3.5 text-foreground-muted" />
        Recently used
      </h3>
      <p className="mt-0.5 mb-3 text-xs text-foreground-muted">
        Documents you used from this Console. Kept here only; Save to workspace makes one a template
        everyone on the workspace can find.
      </p>
      <div className="flex flex-col gap-1">
        {shown.map((r) => (
          <div key={r.yamlText} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() =>
                navigate('templateImport', {
                  serverId,
                  yamlText: r.yamlText,
                  sourceName: r.name,
                })
              }
              className="flex flex-1 cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--sel-soft)]"
            >
              <span className="flex items-center gap-2 truncate">
                {(() => {
                  const Icon = KIND_ICON[documentKind(r.yamlText)];
                  return <Icon className="size-3.5 shrink-0 text-foreground-muted" />;
                })()}
                {r.name}
              </span>
              <span className="shrink-0 text-xs text-foreground-passive">
                {formatTimeAgo(r.usedAt)}
              </span>
            </button>
            {onWorkspace.has(r.name) ? (
              <span className="px-3 text-xs text-foreground-passive">On the workspace</span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                title="Save to the workspace, so everyone on it can use it"
                disabled={saving === r.yamlText}
                onClick={() => void saveToWorkspace(r)}
              >
                <Save className="size-3.5" />
                Save to workspace
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

const TemplatesPanel = observer(function TemplatesPanel() {
  const serverId = useServerId();
  const server = switchServersStore.servers.find((s) => s.id === serverId);
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
  // The server searches name and description. The full listing stays loaded
  // for the recents and for marking a built-in as saved, so a search that
  // matches nothing empties the workspace section and nothing else.
  const [searchHits, setSearchHits] = useState<StoredTemplateSummary[] | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setSearchHits(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      rpc.switchServers
        .listTemplates({ serverId, q })
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
  }, [serverId, query, reloadKey]);

  // An agent template needs a coding agent where its agents will run, and
  // this computer is the default run location. Say at the top of the listing
  // when it has none, rather than at the end of the Use page; a host gets
  // its own check there.
  const { data: availability } = useAgentTypeAvailability();
  const noProvider = availability !== undefined && !availability.some((a) => a.available);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setListError(null);
    rpc.switchServers
      .listTemplates({ serverId })
      .then((result) => {
        if (!cancelled) setTemplates(result);
      })
      .catch((e: unknown) => {
        // The bundled templates render either way. A failed request is shown as a
        // failure, not as an empty workspace.
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
  }, [serverId, reloadKey]);

  const { builtIn, onWorkspace } = useMemo(() => {
    // A bundled card is always the bundled document. Saving it creates a
    // workspace template, listed below as the user's own; the bundled card
    // only marks that a copy exists.
    const byName = new Map(templates.map((t) => [t.name, t]));
    const builtIn: TemplateListEntry[] = bundledTemplates.map((b) => ({
      id: b.id,
      kind: kindOf(b.kind),
      name: b.name,
      description: b.description,
      bundled: true,
      server: byName.get(b.name) ?? null,
      content: b.yamlText,
    }));
    const onWorkspace: TemplateListEntry[] = (searchHits ?? templates).map((t) => ({
      id: t.id,
      kind: kindOf(t.kind),
      name: t.name,
      description: t.description,
      bundled: false,
      server: t,
      content: null,
    }));
    const needle = query.trim().toLowerCase();
    const matches = (t: TemplateListEntry) =>
      (kind === 'all' || t.kind === kind) &&
      (needle.length === 0 ||
        t.name.toLowerCase().includes(needle) ||
        t.description.toLowerCase().includes(needle) ||
        (t.server?.creator ?? '').toLowerCase().includes(needle));
    const mine = (t: TemplateListEntry) => meId !== null && t.server?.ownerId === meId;
    return {
      builtIn: onlyMine ? [] : builtIn.filter(matches),
      onWorkspace: onWorkspace.filter((t) => matches(t) && (!onlyMine || mine(t))),
    };
  }, [templates, searchHits, query, kind, onlyMine, meId]);

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
      serverId={serverId}
      item={item}
      meId={meId}
      busy={false}
      onOpen={() => open(item)}
      onUse={() => handleUse(item)}
    />
  );

  return (
    <ServerPage
      title="Templates"
      description="A template is one YAML document that creates a room, an agent, or a group of them. Use one, fill in its inputs, and everything it describes appears on this workspace."
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
                  runs here, so it needs Claude Code, Codex or OpenCode installed with its Switch
                  connector first.
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

            {!onlyMine && (
              <Section
                title="Built in"
                subtitle="Shipped with Switch. Use one to see how a template is put together."
              >
                {builtIn.length > 0 ? (
                  <div className={grid}>{builtIn.map(card)}</div>
                ) : (
                  <p className="text-sm text-foreground-muted">No built-in template matches.</p>
                )}
              </Section>
            )}

            <Section
              title="On this workspace"
              subtitle="Saved here. Each one says who can use it and who can change it."
            >
              {onWorkspace.length > 0 ? (
                <div className={grid}>{onWorkspace.map(card)}</div>
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
                    ? 'None of yours match. Save a template you used, or import one, and it shows up here as yours.'
                    : 'No template on this workspace matches.'}
                </p>
              ) : (
                <div className="flex flex-col items-start gap-3 rounded-[11px] border border-dashed border-border px-4 py-5">
                  <p className="text-sm text-foreground-muted">
                    Nothing saved here yet. Import a template, or save one you have used, and
                    everyone on this workspace finds it here.
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
            </Section>

            <RecentsSection
              serverId={serverId}
              serverName={server?.name ?? null}
              onWorkspace={new Set(templates.map((t) => t.name))}
              kind={kind}
              query={query}
              onSaved={reload}
            />
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

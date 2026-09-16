import { Bot, CircleAlert, Clock, DoorOpen, FileText, Loader2, Save, Upload } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Input } from '@renderer/lib/ui/input';
import { loadAgentTemplateData } from './agent-template-data';
import { bundledTemplates } from './bundled-templates';

function useServerId(): string {
  return useParams('templates').params.serverId;
}

const TemplatesTitlebar = observer(function TemplatesTitlebar() {
  return <ServerSectionTitlebar serverId={useServerId()} icon={FileText} label="Templates" />;
});

/**
 * One card in the listing. A template can be in two places at once: built
 * into the Console, and saved to the server. Those are one template to the
 * person, so they get one card, and the server copy is the one it opens,
 * since that is the copy an admin can maintain.
 */
type Listed = {
  /** The id the page opens: the server row when there is one. */
  id: string;
  kind: 'agent' | 'room';
  name: string;
  description: string;
  bundled: boolean;
  server: StoredTemplateSummary | null;
};

function isAgentDocument(yamlText: string): boolean {
  return /^agent:\s*$/m.test(yamlText) || /^agent:\s+\S/m.test(yamlText);
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsText(file);
  });
}

function Provenance({ item, meId }: { item: Listed; meId: string | null }) {
  const mine = item.server !== null && meId !== null && item.server.ownerId === meId;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {item.bundled && <Badge variant="secondary">Built in</Badge>}
      {item.server && (
        <Badge variant="secondary">
          {mine ? 'On this server · yours' : `On this server · by ${item.server.creator}`}
        </Badge>
      )}
    </span>
  );
}

function TemplateCard({
  item,
  meId,
  busy,
  onOpen,
  onUse,
}: {
  item: Listed;
  meId: string | null;
  busy: boolean;
  onOpen: () => void;
  onUse: () => void;
}) {
  const Icon = item.kind === 'agent' ? Bot : DoorOpen;
  return (
    <div className="group relative flex min-h-[184px] flex-col rounded-[11px] border border-border bg-background transition-colors hover:border-border-1">
      <button
        type="button"
        aria-label={`Open ${item.name}`}
        className="focus-visible:ring-ring absolute inset-0 cursor-pointer rounded-[11px] focus-visible:ring-2 focus-visible:outline-none"
        onClick={onOpen}
      />
      <div className="pointer-events-none flex flex-1 flex-col p-4">
        <div className="mb-2 flex items-center gap-2">
          <Icon className="size-5 shrink-0 text-foreground-muted" />
          <h3 className="truncate font-medium text-foreground">{item.name}</h3>
        </div>
        <p className="mb-3 line-clamp-3 flex-1 text-sm text-foreground-muted">{item.description}</p>
        <div className="flex items-end justify-between gap-2 pr-16">
          <Provenance item={item} meId={meId} />
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

/** The dashed tile: click to go and paste, or drop a file on it to skip that. */
function ImportTile({ onClick, onFile }: { onClick: () => void; onFile: (file: File) => void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
      }}
      className={`flex w-full cursor-pointer items-center justify-center gap-3 rounded-[11px] border border-dashed px-4 py-5 text-foreground-muted transition-colors hover:border-border-1 hover:bg-[var(--sel-soft)] hover:text-foreground ${dragging ? 'border-primary bg-[var(--sel-soft)] text-foreground' : 'border-border'}`}
    >
      <Upload className="size-5 shrink-0" />
      <span className="text-sm">Import from YAML</span>
      <span className="text-xs text-foreground-passive">
        an agent or room template · click to paste, or drop a file here
      </span>
    </button>
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
 * Documents used from this Console before, kept locally per server: use one
 * again, or put it on the server so everyone there finds it.
 */
function RecentsSection({ serverId, onSaved }: { serverId: string; onSaved: () => void }) {
  const { navigate } = useNavigate();
  const [recents, setRecents] = useState<RecentTemplate[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    rpc.roomTemplates
      .getRecents(serverId)
      .then(setRecents)
      .catch(() => setRecents([]));
  }, [serverId]);

  const saveToServer = async (recent: RecentTemplate) => {
    setSaving(recent.yamlText);
    try {
      const name = recent.name.replace(/(\.template)?\.ya?ml$/i, '');
      await rpc.switchServers.saveTemplate({
        serverId,
        name,
        description: '',
        kind: isAgentDocument(recent.yamlText) ? 'agent' : 'room',
        content: recent.yamlText,
      });
      toast({ title: `"${name}" is now on the server` });
      onSaved();
    } catch (error) {
      toast({
        title: `Could not save "${recent.name}" to the server`,
        description: failureText(error, 'Check the server connection and try again.'),
        variant: 'destructive',
      });
    } finally {
      setSaving(null);
    }
  };

  if (!recents || recents.length === 0) return null;

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-medium text-foreground-muted">
        <Clock className="size-3.5" />
        Recently used
      </h3>
      <div className="flex flex-col gap-1">
        {recents.map((r) => (
          <div key={r.yamlText} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() =>
                navigate('templateImport', { serverId, yamlText: r.yamlText, sourceName: r.name })
              }
              className="flex flex-1 cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--sel-soft)]"
            >
              <span className="flex items-center gap-2 truncate">
                {isAgentDocument(r.yamlText) ? (
                  <Bot className="size-3.5 shrink-0 text-foreground-muted" />
                ) : (
                  <DoorOpen className="size-3.5 shrink-0 text-foreground-muted" />
                )}
                {r.name}
              </span>
              <span className="shrink-0 text-xs text-foreground-passive">
                {formatTimeAgo(r.usedAt)}
              </span>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              title="Save to the server, so everyone on it can use it"
              disabled={saving === r.yamlText}
              onClick={() => void saveToServer(r)}
            >
              <Save className="size-3.5" />
              Save to server
            </Button>
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
  const showAddAgentModal = useShowModal('addAgentModal');

  const [templates, setTemplates] = useState<StoredTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // Templates create agents that run on this computer, so a computer with no
  // usable provider cannot use any of them. Say so above the listing rather
  // than three clicks later, greyed out inside the dialog.
  const { data: availability } = useAgentTypeAvailability();
  const noProvider = availability !== undefined && !availability.some((a) => a.available);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    rpc.switchServers
      .listTemplates({ serverId })
      .then((result) => {
        if (!cancelled) setTemplates(result);
      })
      .catch(() => {
        // The bundled templates still render; the server's are an addition.
        if (!cancelled) setTemplates([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, reloadKey]);

  const { agentItems, roomItems } = useMemo(() => {
    const agents = templates.filter((t) => t.kind === 'agent');
    const rooms = templates.filter((t) => t.kind === 'room');
    const byName = new Map(agents.map((t) => [t.name, t]));
    const agentItems: Listed[] = [];
    for (const b of bundledTemplates) {
      if (b.kind !== 'agent') continue;
      const copy = byName.get(b.name) ?? null;
      if (copy) byName.delete(b.name);
      agentItems.push({
        id: copy?.id ?? b.id,
        kind: 'agent',
        name: b.name,
        description: b.description,
        bundled: true,
        server: copy,
      });
    }
    for (const t of byName.values()) {
      agentItems.push({
        id: t.id,
        kind: 'agent',
        name: t.name,
        description: t.description,
        bundled: false,
        server: t,
      });
    }
    const roomItems: Listed[] = rooms.map((t) => ({
      id: t.id,
      kind: 'room',
      name: t.name,
      description: t.description,
      bundled: false,
      server: t,
    }));
    const needle = query.trim().toLowerCase();
    const matches = (t: Listed) =>
      needle.length === 0 ||
      t.name.toLowerCase().includes(needle) ||
      t.description.toLowerCase().includes(needle) ||
      (t.server?.creator ?? '').toLowerCase().includes(needle);
    return { agentItems: agentItems.filter(matches), roomItems: roomItems.filter(matches) };
  }, [templates, query]);

  // An agent template's second step is the add-agent dialog, prefilled; a
  // room template's is the import view's inputs step, with the document loaded.
  const handleUse = async (item: Listed) => {
    if (item.kind === 'room') {
      navigate('templateImport', { serverId, templateId: item.id });
      return;
    }
    setOpening(item.id);
    try {
      const summary: StoredTemplateSummary = item.server ?? {
        id: item.id,
        name: item.name,
        description: item.description,
        kind: 'agent',
        creator: 'Switch',
        ownerId: null,
      };
      const data = await loadAgentTemplateData(serverId, summary);
      showAddAgentModal({ entryPoint: 'server_page', template: data });
    } catch (error) {
      toast({
        title: `Could not use "${item.name}"`,
        description: failureText(error, 'Check the server connection and try again.'),
        variant: 'destructive',
      });
    } finally {
      setOpening(null);
    }
  };

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

  const grid = 'grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-[14px]';
  const searching = query.trim().length > 0;

  return (
    <ServerPage
      title="Templates"
      description={`Agents and rooms to create from a template on ${server?.name ?? 'this server'}.`}
      action={
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search templates"
          className="h-8 w-[240px]"
        />
      }
    >
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

          {!searching && (
            <ImportTile
              onClick={() => navigate('templateImport', { serverId })}
              onFile={(file) => void importFile(file)}
            />
          )}

          <section>
            <h3 className="mb-3 text-sm font-medium text-foreground-muted">Agent templates</h3>
            {agentItems.length > 0 ? (
              <div className={grid}>
                {agentItems.map((item) => (
                  <TemplateCard
                    key={item.id}
                    item={item}
                    meId={meId}
                    busy={opening === item.id}
                    onOpen={() => navigate('templateDetail', { serverId, templateId: item.id })}
                    onUse={() => void handleUse(item)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-foreground-muted">
                {searching ? `No agent template matches “${query}”.` : 'None yet.'}
              </p>
            )}
          </section>

          <section>
            <h3 className="mb-3 text-sm font-medium text-foreground-muted">Room templates</h3>
            {roomItems.length > 0 ? (
              <div className={grid}>
                {roomItems.map((item) => (
                  <TemplateCard
                    key={item.id}
                    item={item}
                    meId={meId}
                    busy={false}
                    onOpen={() => navigate('templateDetail', { serverId, templateId: item.id })}
                    onUse={() => void handleUse(item)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-foreground-muted">
                {searching
                  ? `No room template matches “${query}”.`
                  : 'None on this server yet. Import one, or save one you have used.'}
              </p>
            )}
          </section>

          {!searching && <RecentsSection serverId={serverId} onSaved={reload} />}
        </div>
      )}
    </ServerPage>
  );
});

export const templatesView = {
  WrapView: ({ children }: { children: React.ReactNode; serverId: string }) => <>{children}</>,
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
} satisfies ViewDefinition<{ serverId: string }>;

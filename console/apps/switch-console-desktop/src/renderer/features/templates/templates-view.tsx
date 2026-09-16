import { Bot, CircleAlert, FileText, Loader2, Upload } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
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
  name: string;
  description: string;
  bundled: boolean;
  server: StoredTemplateSummary | null;
};

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
          <Bot className="size-5 shrink-0 text-foreground-muted" />
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

const TemplatesPanel = observer(function TemplatesPanel() {
  const serverId = useServerId();
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  const meId = switchServersStore.statusFor(serverId)?.user?.id ?? null;
  const { navigate } = useNavigate();
  const showAddAgentModal = useShowModal('addAgentModal');
  const showImportModal = useShowModal('importAgentTemplateModal');

  const [templates, setTemplates] = useState<StoredTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  // Templates create agents that run on this computer, so a computer with no
  // usable provider cannot use any of them. Say so above the listing rather
  // than three clicks later, greyed out inside the dialog.
  const { data: availability } = useAgentTypeAvailability();
  const noProvider = availability !== undefined && !availability.some((a) => a.available);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    rpc.switchServers
      .listTemplates({ serverId, kind: 'agent' })
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

  const listed: Listed[] = useMemo(() => {
    const serverRows = templates.filter((t) => t.kind === 'agent');
    const byName = new Map(serverRows.map((t) => [t.name, t]));
    const items: Listed[] = [];
    for (const b of bundledTemplates) {
      if (b.kind !== 'agent') continue;
      const copy = byName.get(b.name) ?? null;
      if (copy) byName.delete(b.name);
      items.push({
        id: copy?.id ?? b.id,
        name: b.name,
        description: b.description,
        bundled: true,
        server: copy,
      });
    }
    for (const t of byName.values()) {
      items.push({ id: t.id, name: t.name, description: t.description, bundled: false, server: t });
    }
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return items;
    return items.filter(
      (t) =>
        t.name.toLowerCase().includes(needle) ||
        t.description.toLowerCase().includes(needle) ||
        (t.server?.creator ?? '').toLowerCase().includes(needle)
    );
  }, [templates, query]);

  // Parse and hand the result to the add-agent modal. Parsing happens here
  // rather than in the modal so a template that does not parse fails on the
  // card, before any dialog opens.
  const handleUse = async (item: Listed) => {
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

  return (
    <ServerPage
      title="Templates"
      description={`Agents and rooms to create from a template on ${server?.name ?? 'this server'}.`}
    >
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-foreground-muted" />
        </div>
      ) : (
        <div className="space-y-6">
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

          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-foreground-muted">Agent templates</h3>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search templates"
                className="h-8 max-w-[260px]"
              />
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-[14px]">
              {listed.map((item) => (
                <TemplateCard
                  key={item.id}
                  item={item}
                  meId={meId}
                  busy={opening === item.id}
                  onOpen={() => navigate('templateDetail', { serverId, templateId: item.id })}
                  onUse={() => void handleUse(item)}
                />
              ))}
              {query.trim().length === 0 && (
                <button
                  type="button"
                  onClick={() =>
                    showImportModal({ serverId, onSuccess: () => setReloadKey((k) => k + 1) })
                  }
                  className="flex min-h-[184px] cursor-pointer flex-col items-center justify-center gap-2 rounded-[11px] border border-dashed border-border p-4 text-foreground-muted transition-colors hover:border-border-1 hover:bg-[var(--sel-soft)] hover:text-foreground"
                >
                  <Upload className="size-5" />
                  <span className="text-sm">Import from YAML</span>
                </button>
              )}
            </div>
            {listed.length === 0 && query.trim().length > 0 && (
              <p className="mt-3 text-sm text-foreground-muted">No template matches “{query}”.</p>
            )}
          </section>

          <section>
            <h3 className="mb-3 text-sm font-medium text-foreground-muted">Room templates</h3>
            <button
              type="button"
              onClick={() => navigate('roomTemplateImport', { serverId })}
              className="flex min-h-[120px] w-full max-w-[300px] cursor-pointer flex-col items-center justify-center gap-2 rounded-[11px] border border-dashed border-border p-4 text-foreground-muted transition-colors hover:border-border-1 hover:bg-[var(--sel-soft)] hover:text-foreground"
            >
              <Upload className="size-5" />
              <span className="text-sm">Import from YAML</span>
            </button>
          </section>
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

import { Bot, ChevronDown, ChevronUp, CircleAlert, FileText, Loader2, Upload } from 'lucide-react';
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
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { type AgentTemplateData, loadAgentTemplateData } from './agent-template-data';
import { bundledTemplates, findBundledTemplate } from './bundled-templates';

function useServerId(): string {
  return useParams('templates').params.serverId;
}

const TemplatesTitlebar = observer(function TemplatesTitlebar() {
  return <ServerSectionTitlebar serverId={useServerId()} icon={FileText} label="Templates" />;
});

const ADDRESSING_LABEL = {
  owner: 'answers only you',
  'owner-agents': 'answers you and your agents',
  anyone: 'answers anyone in its rooms',
} as const;

/** What a template will do, in one glance, from its parsed document. */
function TemplateDetails({ data }: { data: AgentTemplateData }) {
  const firstLines = data.instructions.split('\n').filter((l) => l.trim().length > 0);
  return (
    <div className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3 text-xs text-foreground-muted">
      {data.repoUrl && <span>Works from {data.repoUrl.replace(/^https?:\/\//, '')}</span>}
      {data.sources.length > 0 && (
        <span>Reads {data.sources.map((s) => s.label ?? s.url).join(', ')}</span>
      )}
      <span>
        {data.roomName
          ? `Starts in a room called "${data.roomName.replace('{agent}', data.agentName ?? 'it')}" with you`
          : 'Created on its own, in no room'}
        {data.addressing ? `, ${ADDRESSING_LABEL[data.addressing]}` : ', answers only you'}
      </span>
      <span>
        Instructions, {data.instructions.split('\n').length} lines:{' '}
        <span className="text-foreground">{firstLines.slice(0, 2).join(' ')}</span>
      </span>
    </div>
  );
}

function TemplateCard({
  template,
  busy,
  onUse,
  onSave,
  loadDetails,
}: {
  template: StoredTemplateSummary;
  busy: boolean;
  onUse: () => void;
  /** Store a bundled template on the server, so the whole server sees it. */
  onSave: (() => void) | null;
  loadDetails: () => Promise<AgentTemplateData>;
}) {
  const [details, setDetails] = useState<AgentTemplateData | null>(null);
  const [open, setOpen] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const toggleDetails = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (details) return;
    setLoadingDetails(true);
    try {
      setDetails(await loadDetails());
    } catch (error) {
      setOpen(false);
      toast({
        title: `Could not read "${template.name}"`,
        description: failureText(error, 'The template document did not parse.'),
        variant: 'destructive',
      });
    } finally {
      setLoadingDetails(false);
    }
  };

  return (
    <div className="flex min-h-[184px] flex-col rounded-[11px] border border-border bg-background p-4 transition-colors hover:border-border-1">
      <div className="mb-2 flex items-center gap-2">
        <Bot className="size-5 shrink-0 text-foreground-muted" />
        <h3 className="truncate font-medium text-foreground">{template.name}</h3>
      </div>
      <p className="mb-3 line-clamp-3 flex-1 text-sm text-foreground-muted">
        {template.description}
      </p>
      <div className="flex items-center justify-between">
        <span className="text-xs text-foreground-muted">by {template.creator}</span>
        <div className="flex items-center gap-1">
          {onSave && (
            <Button size="sm" variant="ghost" onClick={onSave} disabled={busy}>
              Save to server
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void toggleDetails()}>
            {loadingDetails ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : open ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
            Details
          </Button>
          <Button size="sm" variant="outline" onClick={onUse} disabled={busy}>
            {busy ? 'Opening…' : 'Use'}
          </Button>
        </div>
      </div>
      {open && details && <TemplateDetails data={details} />}
    </div>
  );
}

const TemplatesPanel = observer(function TemplatesPanel() {
  const serverId = useServerId();
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  const { navigate } = useNavigate();
  const showAddAgentModal = useShowModal('addAgentModal');

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

  // A bundled template lives in this Console only. Saving it puts the same
  // document (persona inlined) on the server's registry, where everyone on
  // the server finds it and the gateway can edit it.
  const handleSaveTemplate = async (template: StoredTemplateSummary) => {
    const bundled = findBundledTemplate(template.id);
    if (!bundled) return;
    setOpening(template.id);
    try {
      const content = await rpc.agentTemplates.compose({
        yamlText: bundled.content,
        instructions: bundled.instructions ?? '',
      });
      await rpc.switchServers.saveTemplate({
        serverId,
        name: bundled.name,
        description: bundled.description,
        kind: bundled.kind,
        content,
      });
      toast({ title: `"${bundled.name}" is now on ${server?.name ?? 'the server'}` });
      setReloadKey((k) => k + 1);
    } catch (error) {
      toast({
        title: `Could not save "${template.name}" to the server`,
        description: failureText(error, 'Check the server connection and try again.'),
        variant: 'destructive',
      });
    } finally {
      setOpening(null);
    }
  };

  // Fetch (for a server template), parse, and hand the result to the
  // add-agent modal. Parsing happens here rather than in the modal so a
  // template that does not parse fails on the card, before any dialog opens.
  const handleUseTemplate = async (template: StoredTemplateSummary) => {
    setOpening(template.id);
    try {
      const data = await loadAgentTemplateData(serverId, template);
      showAddAgentModal({ entryPoint: 'server_page', template: data });
    } catch (error) {
      toast({
        title: `Could not use "${template.name}"`,
        description: failureText(error, 'Check the server connection and try again.'),
        variant: 'destructive',
      });
    } finally {
      setOpening(null);
    }
  };

  const agentTemplates: StoredTemplateSummary[] = useMemo(() => {
    const all = [
      ...bundledTemplates
        .filter((b) => b.kind === 'agent')
        .map(({ id, name, description, kind, creator }) => ({
          id,
          name,
          description,
          kind,
          creator,
        })),
      ...templates.filter((t) => t.kind === 'agent'),
    ];
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return all;
    return all.filter(
      (t) =>
        t.name.toLowerCase().includes(needle) ||
        t.description.toLowerCase().includes(needle) ||
        t.creator.toLowerCase().includes(needle)
    );
  }, [templates, query]);

  return (
    <ServerPage
      title="Templates"
      description={`Browse and create agents from templates on ${server?.name ?? 'this server'}.`}
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
            {agentTemplates.length > 0 ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-[14px]">
                {agentTemplates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    busy={opening === t.id}
                    onUse={() => void handleUseTemplate(t)}
                    onSave={
                      findBundledTemplate(t.id) && !templates.some((s) => s.name === t.name)
                        ? () => void handleSaveTemplate(t)
                        : null
                    }
                    loadDetails={() => loadAgentTemplateData(serverId, t)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-foreground-muted">No template matches “{query}”.</p>
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

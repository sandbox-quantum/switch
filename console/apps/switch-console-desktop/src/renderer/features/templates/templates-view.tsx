import { Bot, FileText, Loader2, Upload } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
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
import { Button } from '@renderer/lib/ui/button';
import { loadAgentTemplateData } from './agent-template-data';
import { bundledTemplates } from './bundled-templates';

function useServerId(): string {
  return useParams('templates').params.serverId;
}

const TemplatesTitlebar = observer(function TemplatesTitlebar() {
  return <ServerSectionTitlebar serverId={useServerId()} icon={FileText} label="Templates" />;
});

function TemplateCard({
  template,
  busy,
  onUse,
}: {
  template: StoredTemplateSummary;
  busy: boolean;
  onUse: () => void;
}) {
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
  const { navigate } = useNavigate();
  const showAddAgentModal = useShowModal('addAgentModal');

  const [templates, setTemplates] = useState<StoredTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);

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
  }, [serverId]);

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

  const agentTemplates: StoredTemplateSummary[] = [
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
          {agentTemplates.length > 0 && (
            <section>
              <h3 className="mb-3 text-sm font-medium text-foreground-muted">Agent templates</h3>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-[14px]">
                {agentTemplates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    busy={opening === t.id}
                    onUse={() => void handleUseTemplate(t)}
                  />
                ))}
              </div>
            </section>
          )}

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

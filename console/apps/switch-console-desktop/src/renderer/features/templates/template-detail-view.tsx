import { ArrowLeft, Check, Copy, Download, FileText, Loader2, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { PageHeader } from '@renderer/lib/components/page-header';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { type LoadedTemplate, loadTemplateById } from './agent-template-data';

function useViewParams() {
  return useParams('templateDetail').params;
}

const ADDRESSING_LABEL = {
  owner: 'Only its owner',
  'owner-agents': 'Its owner and their agents',
  anyone: 'Anyone in its rooms',
} as const;

const TemplateDetailTitlebar = observer(function TemplateDetailTitlebar() {
  const { serverId } = useViewParams();
  const { navigate } = useNavigate();
  return (
    <ServerSectionTitlebar
      serverId={serverId}
      icon={FileText}
      label="Templates"
      onSectionClick={() => navigate('templates', { serverId })}
      item={{ label: useTemplateName() ?? 'Template' }}
    />
  );
});

// The name is loaded by the panel; the titlebar reads it back from a tiny
// shared cell rather than fetching twice.
let currentName: string | null = null;
const nameListeners = new Set<(name: string | null) => void>();
function setCurrentName(name: string | null) {
  currentName = name;
  for (const l of nameListeners) l(name);
}
function useTemplateName(): string | null {
  const [name, setName] = useState(currentName);
  useEffect(() => {
    nameListeners.add(setName);
    return () => {
      nameListeners.delete(setName);
    };
  }, []);
  return name;
}

/** One line of a definition list: a fixed label, then the fact. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-28 shrink-0 text-foreground-muted">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Link({ url, label }: { url: string; label?: string | null }) {
  return (
    <button
      type="button"
      className="cursor-pointer underline underline-offset-2"
      onClick={() => void openExternalUrl(url, 'Could not open the page')}
    >
      {label ?? url.replace(/^https?:\/\//, '')}
    </button>
  );
}

/** A read-only block of text that starts folded and unfolds in place. */
function TextBlock({
  text,
  collapsedHeight = 'max-h-56',
}: {
  text: string;
  collapsedHeight?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split('\n').length;
  return (
    <div className="flex flex-col gap-2">
      <pre
        className={`overflow-auto rounded-md border border-border bg-background-2 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground ${expanded ? '' : collapsedHeight}`}
      >
        {text}
      </pre>
      {lines > 12 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="cursor-pointer self-start text-sm text-foreground-muted hover:text-foreground"
        >
          {expanded ? 'Collapse' : `Expand (${lines} lines)`}
        </button>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? (
        <Check className="size-3.5 text-foreground-success" />
      ) : (
        <Copy className="size-3.5" />
      )}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

const TemplateDetailPanel = observer(function TemplateDetailPanel() {
  const { serverId, templateId } = useViewParams();
  const { navigate } = useNavigate();
  const showAddAgentModal = useShowModal('addAgentModal');
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  const me = switchServersStore.statusFor(serverId)?.user ?? null;

  const [loaded, setLoaded] = useState<LoadedTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'delete' | 'export' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    loadTemplateById(serverId, templateId)
      .then((t) => {
        if (cancelled) return;
        setLoaded(t);
        setCurrentName(t.name);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(failureText(e, 'Could not load this template.'));
      });
    return () => {
      cancelled = true;
      setCurrentName(null);
    };
  }, [serverId, templateId]);

  const back = (
    <Button
      size="sm"
      variant="ghost"
      className="-ml-2"
      onClick={() => navigate('templates', { serverId })}
    >
      <ArrowLeft className="size-4" /> All templates
    </Button>
  );

  if (error) {
    return (
      <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-auto bg-background">
        <div className="space-y-6 px-8 pb-10">
          <PageHeader sticky title="Template" back={back} />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-foreground-muted" />
      </div>
    );
  }

  const mine = loaded.server !== null && me !== null && loaded.server.ownerId === me.id;
  const canDelete = loaded.server !== null && (mine || me?.role === 'admin');

  // An agent template's second step is the add-agent dialog; a room
  // template's is the import view's inputs step, with the document loaded.
  const use = () => {
    if (loaded.agent) showAddAgentModal({ entryPoint: 'server_page', template: loaded.agent });
    else navigate('templateImport', { serverId, templateId });
  };

  const saveToServer = async () => {
    if (!loaded.bundled) return;
    setBusy('save');
    try {
      const saved = await rpc.switchServers.saveTemplate({
        serverId,
        name: loaded.bundled.name,
        description: loaded.bundled.description,
        kind: loaded.bundled.kind,
        content: loaded.document,
      });
      toast({
        title: `"${loaded.name}" is now on ${server?.name ?? 'the server'}`,
      });
      navigate('templateDetail', { serverId, templateId: saved.id });
    } catch (e) {
      toast({
        title: 'Could not save the template to the server',
        description: failureText(e, 'Check the server connection and try again.'),
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!loaded.server) return;
    setBusy('delete');
    try {
      await rpc.switchServers.deleteTemplate({
        serverId,
        templateId: loaded.server.id,
      });
      toast({
        title: `"${loaded.name}" removed from ${server?.name ?? 'the server'}`,
      });
      navigate('templates', { serverId });
    } catch (e) {
      toast({
        title: 'Could not remove the template',
        description: failureText(e, 'Check the server connection and try again.'),
        variant: 'destructive',
      });
      setBusy(null);
    }
  };

  const exportYaml = async () => {
    setBusy('export');
    try {
      const slug = (loaded.agent?.agentName ?? loaded.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-');
      const path = await rpc.app.saveTextFile({
        title: 'Export template',
        defaultPath: `${slug}.template.yaml`,
        content: loaded.document,
      });
      if (path) toast({ title: 'Exported', description: path });
    } catch (e) {
      toast({
        title: 'Could not export the template',
        description: failureText(e, ''),
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      <div className="space-y-8 px-8 pb-10">
        <PageHeader sticky title={loaded.name} description={loaded.description} back={back}>
          <div className="flex items-center gap-2">
            {loaded.bundled && !loaded.server && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void saveToServer()}
              >
                {busy === 'save' ? 'Saving…' : 'Save to workspace'}
              </Button>
            )}
            {canDelete && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  // Second click removes; the first only asks. A page action
                  // has no dialog to hide behind, and the row is gone for
                  // everyone on the workspace once it goes.
                  if (confirmRemove) void remove();
                  else setConfirmRemove(true);
                }}
                onBlur={() => setConfirmRemove(false)}
              >
                <Trash2 className="size-3.5" />
                {busy === 'delete'
                  ? 'Removing…'
                  : confirmRemove
                    ? 'Click again to remove'
                    : 'Remove from workspace'}
              </Button>
            )}
            <Button type="button" size="sm" onClick={use} disabled={busy !== null}>
              Use
            </Button>
          </div>
        </PageHeader>

        <div className="flex flex-wrap items-center gap-2">
          {loaded.bundled && (
            <Badge variant="outline" title="Shipped with Switch">
              Official
            </Badge>
          )}
          {loaded.server && (
            <Badge variant="secondary">
              {mine
                ? 'On this workspace · yours'
                : `On this workspace · by ${loaded.server.creator}`}
            </Badge>
          )}
          <Badge variant="outline">
            {loaded.kind === 'agent' ? 'agent template' : 'room template'}
          </Badge>
        </div>

        {loaded.agent && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-foreground">What it creates</h2>
            <Row label="Agent">
              {loaded.agent.agentName ? (
                <span className="font-mono">{loaded.agent.agentName}</span>
              ) : (
                <span className="text-foreground-muted">Named when created</span>
              )}
            </Row>
            {loaded.agent.repoUrl && (
              <Row label="Repository">
                <Link url={loaded.agent.repoUrl} />
                <span className="text-foreground-muted">, cloned into its directory</span>
              </Row>
            )}
            {loaded.agent.sources.length > 0 && (
              <Row label="Sources">
                <span className="flex flex-wrap gap-x-1.5">
                  {loaded.agent.sources.map((src, i) => (
                    <span key={src.url}>
                      {i > 0 && <span className="text-foreground-muted">· </span>}
                      <Link url={src.url} label={src.label} />
                    </span>
                  ))}
                </span>
              </Row>
            )}
            <Row label="Room">
              {loaded.agent.roomName ? (
                <>
                  <span>
                    &quot;
                    {loaded.agent.roomName.replace('{agent}', loaded.agent.agentName ?? 'it')}
                    &quot;
                  </span>
                  <span className="text-foreground-muted">, with you, kickoff sent as you</span>
                </>
              ) : (
                <span className="text-foreground-muted">None. Add it to a room to start it.</span>
              )}
            </Row>
            <Row label="Answers">{ADDRESSING_LABEL[loaded.agent.addressing ?? 'owner']}</Row>
          </section>
        )}

        {loaded.room && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-foreground">What it creates</h2>
            <Row label="Room">
              {loaded.room.roomName ?? (
                <span className="text-foreground-muted">Named on create</span>
              )}
            </Row>
            <Row label="Agents">
              {loaded.room.agents.length > 0 ? (
                <span className="font-mono">{loaded.room.agents.join(', ')}</span>
              ) : (
                <span className="text-foreground-muted">None</span>
              )}
            </Row>
            <Row label="People">
              {loaded.room.users.length > 0 ? (
                loaded.room.users.join(', ')
              ) : (
                <span className="text-foreground-muted">None</span>
              )}
            </Row>
            <Row label="Inputs">
              {loaded.room.params.length > 0 ? (
                loaded.room.params.map((p) => p.name).join(', ')
              ) : (
                <span className="text-foreground-muted">None</span>
              )}
            </Row>
            <Row label="Kickoff">
              {loaded.room.kickoff ? (
                <span className="whitespace-pre-wrap">{loaded.room.kickoff.trim()}</span>
              ) : (
                <span className="text-foreground-muted">None</span>
              )}
            </Row>
          </section>
        )}

        {loaded.agent && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-foreground">Instructions</h2>
            <TextBlock text={loaded.agent.instructions} />
          </section>
        )}

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">Document</h2>
            <div className="flex items-center gap-2">
              <CopyButton text={loaded.document} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void exportYaml()}
              >
                <Download className="size-3.5" />
                Export YAML
              </Button>
            </div>
          </div>
          <TextBlock text={loaded.document} collapsedHeight="max-h-72" />
        </section>
      </div>
    </div>
  );
});

export const templateDetailView = {
  WrapView: ({ children }: { children: React.ReactNode; serverId: string; templateId: string }) => (
    <>{children}</>
  ),
  TitlebarSlot: TemplateDetailTitlebar,
  MainPanel: TemplateDetailPanel,
  canActivate: (params: unknown): GuardResult => {
    const p =
      typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
    if (typeof p.serverId !== 'string' || typeof p.templateId !== 'string') {
      return { ok: false, redirect: 'home' };
    }
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string; templateId: string }>;

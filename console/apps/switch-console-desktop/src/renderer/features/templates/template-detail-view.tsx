import {
  ArrowLeft,
  Bot,
  Check,
  Copy,
  DoorOpen,
  Download,
  FileText,
  Loader2,
  Pencil,
  Trash2,
} from 'lucide-react';
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
import { openExternalUrl } from '@renderer/lib/open-external';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { DisclosureRow } from '@renderer/lib/ui/disclosure-row';
import { cn } from '@renderer/utils/utils';
import { type LoadedTemplate, loadTemplateById } from './agent-template-data';
import { accessLine, accessOf } from './template-visibility';
import { isRequired, typeLabel } from './use/use-template-model';

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

// The panel loads the template; the titlebar shows its name. They share the
// name through this module-level value so the titlebar does not load the
// template a second time.
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

function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
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

function ExpandableTextBlock({
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

const KIND_LABEL: Record<LoadedTemplate['kind'], string> = {
  agent: 'Agent',
  room: 'Room',
  group: 'Group',
};

const TemplateDetailPanel = observer(function TemplateDetailPanel() {
  const { serverId, templateId } = useViewParams();
  const { navigate } = useNavigate();
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  const me = switchServersStore.statusFor(serverId)?.user ?? null;

  const [loaded, setLoaded] = useState<LoadedTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'delete' | 'export' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showDocument, setShowDocument] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);

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
  // The server says what this user may do: it knows who administers the
  // workspace, which the user's global role does not tell. An older server
  // leaves the answer out, and the owner-or-admin guess stands in.
  const canManage =
    loaded.server !== null && (loaded.server.canManage ?? (mine || me?.role === 'admin'));
  const canEdit =
    loaded.server !== null &&
    (loaded.server.canEdit ?? (canManage || loaded.server.writeVisibility === 'public'));
  const singleAgent = loaded.kind === 'agent' ? (loaded.agents[0] ?? null) : null;
  // In a single-agent document the room refers to the agent as `{agent}`. The
  // Console fills that in with the agent's name, so it is not an input to list.
  const params = (loaded.room?.params ?? []).filter((p) => !(singleAgent && p.name === 'agent'));
  const slug = (singleAgent?.name ?? loaded.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const use = () => navigate('templateUse', { serverId, templateId });

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
      toast({ title: `"${loaded.name}" is now on ${server?.name ?? 'the workspace'}` });
      navigate('templateDetail', { serverId, templateId: saved.id });
    } catch (e) {
      toast({
        title: 'Could not save the template to the workspace',
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
      await rpc.switchServers.deleteTemplate({ serverId, templateId: loaded.server.id });
      toast({ title: `"${loaded.name}" removed from ${server?.name ?? 'the workspace'}` });
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

  const ownerLine = loaded.bundled
    ? 'Shipped with Switch'
    : mine
      ? 'Yours'
      : `Uploaded by ${loaded.server?.creator ?? 'someone'}`;
  const visibilityLine = loaded.server
    ? accessLine(accessOf(loaded.server))
    : 'Shared with everyone';

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      <div className="mx-auto w-full max-w-4xl space-y-7 px-8 pb-10">
        <PageHeader
          sticky
          title={loaded.name}
          description={
            <span className="flex flex-col gap-1.5">
              <span>{loaded.description || 'No description.'}</span>
              <span className="flex items-center gap-2 text-xs text-foreground-passive">
                <span>{ownerLine}</span>
                <span>·</span>
                <span>{visibilityLine}</span>
                {loaded.server && loaded.server.version > 1 && (
                  <>
                    <span>·</span>
                    <span>Version {loaded.server.version}</span>
                  </>
                )}
                {loaded.copyOf && (
                  <>
                    <span>·</span>
                    <span>A copy of the built-in one</span>
                  </>
                )}
                {loaded.savedCopy && (
                  <>
                    <span>·</span>
                    <button
                      type="button"
                      className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                      onClick={() =>
                        navigate('templateDetail', { serverId, templateId: loaded.savedCopy!.id })
                      }
                    >
                      A copy is saved on this workspace
                    </button>
                  </>
                )}
              </span>
            </span>
          }
          back={back}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{KIND_LABEL[loaded.kind]}</Badge>
            {loaded.bundled && (
              <Badge variant="outline" title="Shipped with Switch">
                Official
              </Badge>
            )}
            <span className="flex-1" />
            {loaded.bundled && !loaded.savedCopy && (
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
            {canEdit && loaded.server && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  navigate('templateImport', {
                    serverId,
                    yamlText: loaded.document,
                    edit: true,
                    editingTemplate: {
                      id: loaded.server!.id,
                      name: loaded.name,
                      description: loaded.description,
                      access: accessOf(loaded.server!),
                      canChangeAccess: canManage,
                    },
                  })
                }
              >
                <Pencil className="size-3.5" />
                Edit
              </Button>
            )}
            {canManage && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  // The first click asks for confirmation, the second removes.
                  // Removal is visible to everyone on the workspace and cannot
                  // be undone, and this page has no confirmation dialog.
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
              Use template
            </Button>
          </div>
        </PageHeader>

        <section className="flex flex-col gap-2.5">
          <h2 className="text-sm font-semibold text-foreground">What it creates</h2>
          {loaded.summary.creates.length > 0 ? (
            <div className="flex flex-col divide-y divide-border overflow-hidden rounded-[11px] border border-border bg-background-1">
              {loaded.summary.creates.map((c, i) => {
                const Icon = c.kind === 'room' ? DoorOpen : Bot;
                return (
                  <div key={i} className="flex items-center gap-3 px-3.5 py-3">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-background-2 text-foreground-muted">
                      <Icon className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[13px] font-medium">{c.name}</div>
                      <div className="mt-0.5 text-xs leading-snug text-foreground-muted">
                        {c.description}
                      </div>
                    </div>
                    <span className="shrink-0 text-[11px] text-foreground-passive">
                      {c.kind === 'room' ? 'Room' : 'Agent'}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-foreground-muted">Nothing yet: the document is empty.</p>
          )}
          {singleAgent && (
            <div className="flex flex-col gap-2 pt-1">
              {singleAgent.repoUrl && (
                <FactRow label="Repository">
                  <Link url={singleAgent.repoUrl} />
                  <span className="text-foreground-muted">, cloned into its directory</span>
                </FactRow>
              )}
              {singleAgent.sources.length > 0 && (
                <FactRow label="Sources">
                  <span className="flex flex-wrap gap-x-1.5">
                    {singleAgent.sources.map((src, i) => (
                      <span key={src.url}>
                        {i > 0 && <span className="text-foreground-muted">· </span>}
                        <Link url={src.url} label={src.label} />
                      </span>
                    ))}
                  </span>
                </FactRow>
              )}
              <FactRow label="Answers">
                {ADDRESSING_LABEL[singleAgent.addressing ?? 'owner']}
              </FactRow>
              {loaded.room?.kickoff && (
                <FactRow label="Kickoff">
                  <span className="text-foreground-muted">Posted as you once the room exists</span>
                </FactRow>
              )}
            </div>
          )}
          {!singleAgent && loaded.room?.kickoff && (
            <FactRow label="Kickoff">
              <span className="whitespace-pre-wrap">{loaded.room.kickoff.trim()}</span>
            </FactRow>
          )}
        </section>

        {params.length > 0 && (
          <section className="flex flex-col gap-2.5">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-foreground">Inputs</h2>
              <span className="text-xs text-foreground-passive">
                You fill these in when you use it.
              </span>
            </div>
            <div className="flex flex-col divide-y divide-border overflow-hidden rounded-[11px] border border-border bg-background-1">
              {params.map((p) => (
                <div key={p.name} className="flex items-start gap-3 px-3.5 py-2.5 text-[12.5px]">
                  <span className="w-36 shrink-0 truncate font-mono">{p.name}</span>
                  <span className="w-16 shrink-0 text-[11.5px] text-foreground-passive">
                    {typeLabel(p.type)}
                  </span>
                  <span className="min-w-0 flex-1 leading-snug text-foreground-muted">
                    {p.description ??
                      (p.default !== null ? `Defaults to ${String(p.default)}` : '')}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 text-[11.5px]',
                      isRequired(p)
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-foreground-passive'
                    )}
                  >
                    {isRequired(p) ? 'Required' : 'Optional'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {singleAgent && (
          <section className="flex flex-col gap-2.5">
            <DisclosureRow
              open={showInstructions}
              title={showInstructions ? 'Hide the instructions' : 'Show the instructions'}
              meta={`${singleAgent.instructions.split('\n').length} lines`}
              onToggle={() => setShowInstructions((o) => !o)}
            />
            {showInstructions && (
              <ExpandableTextBlock text={singleAgent.instructions} collapsedHeight="max-h-none" />
            )}
          </section>
        )}

        <section className="flex flex-col gap-2.5">
          <DisclosureRow
            open={showDocument}
            title={showDocument ? 'Hide the document' : 'Show the document'}
            onToggle={() => setShowDocument((o) => !o)}
          />
          {showDocument && (
            <div className="overflow-hidden rounded-[11px] border border-border bg-background-1">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11.5px] text-foreground-passive">
                <span className="min-w-0 flex-1 truncate font-mono">{slug}.template.yaml</span>
                <span className="shrink-0">
                  {loaded.server ? 'Stored exactly as uploaded' : 'Bundled with the Console'}
                </span>
                <CopyButton text={loaded.document} />
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy !== null}
                  onClick={() => void exportYaml()}
                >
                  <Download className="size-3.5" />
                  Export YAML
                </Button>
              </div>
              <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground-muted">
                {loaded.document}
              </pre>
            </div>
          )}
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

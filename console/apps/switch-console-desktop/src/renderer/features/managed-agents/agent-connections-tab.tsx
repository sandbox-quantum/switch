import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  CLOUD_GITHUB_GRANT_NOTES,
  GITHUB_GRANT_NOTES,
  REMOVED_GRANT_NOTE,
} from '@renderer/features/locations/components/settings-view/sections/service-grants';
import {
  GitHubGrantForm,
  GrantCard,
  OnOffGrant,
} from '@renderer/features/locations/components/settings-view/sections/service-grants-settings-section';
import { ConnectionIcon } from '@renderer/features/switch-servers/connection-icon';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Alert, AlertAction, AlertDescription } from '@renderer/lib/ui/alert';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import {
  type AgentConnectionCard,
  agentConnectionCards,
  connectionCardDetail,
  connectionCardStatus,
  ownerOnlyRequest,
  ownerOnlyWarningText,
  showsOwnerOnlyWarning,
  unconnectedNote,
} from './agent-connections';

type Access = 'read' | 'write';

const DRAWER_WIDTH = 480;

/**
 * The agent's grants, under the key its Service access row reads, so the two
 * share one cache. Null when they are not the caller's.
 */
export function useAgentServiceGrants(shown: boolean, workspaceId: string | null, agentId: string) {
  return useQuery({
    queryKey: ['agent-service-grants', workspaceId, agentId],
    queryFn: () => rpc.workspaces.getServiceGrants({ workspaceId: workspaceId as string, agentId }),
    enabled: shown && workspaceId !== null,
    retry: false,
  });
}

/**
 * An agent's Connections tab, on a managed or a local agent's page: one card
 * per service its owner has connected, and a drawer to grant or change one.
 * The drawer sits over the page rather than replacing it: picking a service
 * is a look, not a move. `cloud` is for a cloud agent, whose sessions have no
 * GitHub sign-in of their own and run on no machine of the owner's.
 */
export function AgentConnectionsTab({
  workspaceId,
  agentId,
  agentName: label,
  cloud,
}: {
  workspaceId: string;
  /** The agent's id in Switch. */
  agentId: string;
  agentName: string;
  cloud: boolean;
}) {
  const queryClient = useQueryClient();
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const grants = useAgentServiceGrants(true, workspaceId, agentId);
  // The agent's workspace, not whichever one is active on its server.
  const github = useQuery({
    queryKey: ['workspace-github', workspaceId],
    queryFn: () => rpc.workspaces.getGitHubConnection(workspaceId),
    retry: false,
  });
  const services = useQuery({
    queryKey: ['workspace-service-connections', workspaceId],
    queryFn: () => rpc.workspaces.getServiceConnections(workspaceId),
    retry: false,
  });

  const change = useMutation({
    mutationFn: async (run: () => Promise<string | null | void>) => run(),
    onSuccess: async (warning) => {
      setNotice(warning ?? null);
      setEditing(false);
      await queryClient.invalidateQueries({
        queryKey: ['agent-service-grants', workspaceId, agentId],
      });
    },
  });
  const set = (service: string, access: Access | null, resources: Record<string, unknown>) =>
    change.mutate(() =>
      rpc.workspaces.setServiceGrant({ workspaceId, agentId, service, access, resources })
    );
  const remove = (service: string) =>
    change.mutate(async () => {
      const warning = await rpc.workspaces.removeServiceGrant({ workspaceId, agentId, service });
      return [warning, cloud ? null : REMOVED_GRANT_NOTE].filter(Boolean).join(' ') || null;
    });
  const open = (slug: string | null) => {
    change.reset();
    setNotice(null);
    setEditing(false);
    setOpenSlug(slug);
  };

  const page = (children: ReactNode) => (
    <ServerPage
      width={900}
      title="Connections"
      description={`What ${label} may use of your own connections. Its sessions are given short-lived access for what you turn on, and nothing else.`}
    >
      {children}
    </ServerPage>
  );
  if (grants.isPending)
    return page(
      <p className="flex items-center gap-2 text-sm">
        <Spinner /> Loading service access…
      </p>
    );
  if (grants.isError)
    return page(
      <p role="alert" className="text-sm text-destructive">
        {failureText(grants.error, 'Could not load service access.')}
      </p>
    );
  // The page hides this tab once the grants come back null; this is the moment before.
  if (grants.data === null) return page(null);
  const current = grants.data;
  const { cards, unconnected } = agentConnectionCards(services.data ?? [], current.grants);
  const note = unconnectedNote(unconnected);
  const opened = cards.find((card) => card.slug === openSlug) ?? null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {page(
        <>
          {showsOwnerOnlyWarning(current) && (
            <Alert variant="warning">
              <AlertDescription>{ownerOnlyWarningText(label)}</AlertDescription>
              <AlertAction>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={change.isPending}
                  onClick={() =>
                    change.mutate(async () => {
                      await rpc.workspaces.updateAddressingPolicy(
                        ownerOnlyRequest(workspaceId, agentId)
                      );
                      await queryClient.invalidateQueries({
                        queryKey: ['agent-addressing-policy', workspaceId, agentId],
                      });
                    })
                  }
                >
                  Make owner-only
                </Button>
              </AlertAction>
            </Alert>
          )}
          {change.isError && opened === null && (
            <p role="alert" className="text-sm text-destructive">
              {failureText(change.error, 'Could not make the agent owner-only.')}
            </p>
          )}
          {services.isError && (
            <p role="alert" className="text-sm text-destructive">
              {failureText(services.error, 'Could not load your connections.')}
            </p>
          )}
          {services.isPending ? (
            <p className="flex items-center gap-2 text-sm">
              <Spinner /> Loading your connections…
            </p>
          ) : (
            cards.length > 0 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {cards.map((card) => (
                  <ConnectionCard
                    key={card.slug}
                    card={card}
                    selected={card.slug === openSlug}
                    onOpen={() => open(card.slug)}
                  />
                ))}
              </div>
            )
          )}
          {services.isSuccess && cards.length === 0 && note === null && (
            <p className="text-sm text-foreground-muted">
              No service on this server can be turned on for {label} yet.
            </p>
          )}
          {note && <p className="text-sm text-foreground-muted">{note}</p>}
        </>
      )}
      {opened && (
        <ConnectionDrawer key={opened.slug} card={opened} onClose={() => open(null)}>
          {change.isError && (
            <p role="alert" className="text-xs text-destructive">
              {failureText(change.error, `Could not change its ${opened.name} access.`)}
            </p>
          )}
          {notice && <p className="text-xs text-foreground-muted">{notice}</p>}
          {opened.kind === 'on-off' && opened.service && (
            <OnOffGrant
              service={opened.service}
              grant={opened.grant}
              agentName={label}
              busy={change.isPending}
              onTurnOn={() => set(opened.slug, null, {})}
              onTurnOff={() => remove(opened.slug)}
            />
          )}
          {opened.kind === 'github' && (
            <GitHubDrawerBody
              card={opened}
              github={github}
              agentName={label}
              cloud={cloud}
              busy={change.isPending}
              editing={editing}
              onEdit={setEditing}
              onSave={(access, resources) => set('github', access, resources)}
              onRemove={() => remove('github')}
            />
          )}
          {opened.kind === 'other' && opened.grant && (
            <GrantCard
              grant={opened.grant}
              github={github.data}
              busy={change.isPending}
              onChange={null}
              removeNote={cloud ? null : REMOVED_GRANT_NOTE}
              onRemove={() => remove(opened.slug)}
            />
          )}
        </ConnectionDrawer>
      )}
    </div>
  );
}

function ConnectionCard({
  card,
  selected,
  onOpen,
}: {
  card: AgentConnectionCard;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={selected}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        selected ? 'border-foreground/30 bg-background-2' : 'border-border hover:bg-background-2'
      )}
    >
      <ConnectionIcon slug={card.slug} name={card.name} />
      <span className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{card.name}</span>
          <Badge variant="outline">{connectionCardStatus(card)}</Badge>
          <ChevronRight className="size-4 shrink-0 text-foreground-muted" aria-hidden />
        </span>
        <span className="text-sm text-foreground-muted">{connectionCardDetail(card)}</span>
      </span>
    </button>
  );
}

/**
 * The drawer over the page's right edge. It is not modal: the cards stay in
 * view, focus moves in when it opens and back to its card when it closes, and
 * Escape closes it wherever focus is.
 */
function ConnectionDrawer({
  card,
  onClose,
  children,
}: {
  card: AgentConnectionCard;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={card.name}
      tabIndex={-1}
      style={{ width: DRAWER_WIDTH, maxWidth: '100%' }}
      className="absolute inset-y-0 right-0 z-20 flex flex-col border-l border-border bg-background shadow-lg focus:outline-none"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border p-3 pl-4">
        <ConnectionIcon slug={card.slug} name={card.name} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{card.name}</h3>
        <Button
          variant="ghost"
          size="sm"
          className="size-7 p-0"
          aria-label={`Close ${card.name}`}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">{children}</div>
    </div>
  );
}

function GitHubDrawerBody({
  card,
  github,
  agentName,
  cloud,
  busy,
  editing,
  onEdit,
  onSave,
  onRemove,
}: {
  card: AgentConnectionCard;
  github: Parameters<typeof GitHubGrantForm>[0]['github'];
  agentName: string;
  cloud: boolean;
  busy: boolean;
  /** Whether the form for changing an existing grant is open. */
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onSave: (access: Access, resources: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const { grant } = card;
  return (
    <>
      {grant && (
        <GrantCard
          grant={grant}
          github={github.data}
          busy={busy}
          onChange={() => onEdit(true)}
          removeNote={cloud ? null : REMOVED_GRANT_NOTE}
          onRemove={onRemove}
        />
      )}
      {(editing || !grant) && (
        <GitHubGrantForm
          github={github}
          current={grant}
          agentName={agentName}
          busy={busy}
          onCancel={grant ? () => onEdit(false) : null}
          onSave={onSave}
        />
      )}
      <ul className="list-disc space-y-1 pl-5 text-xs text-foreground-muted">
        {(cloud ? CLOUD_GITHUB_GRANT_NOTES : GITHUB_GRANT_NOTES).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </>
  );
}

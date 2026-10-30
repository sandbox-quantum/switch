import { useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { AgentIdentityActions } from '@renderer/features/agent-identity/agent-identity-actions';
import { directChats } from '@renderer/features/chats/start-direct-chat';
import { useConfirmDeleteAgent } from '@renderer/features/locations/hooks/use-confirm-delete-agent';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { AgentIconPicker } from '@renderer/lib/components/agent-icon-picker';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import {
  workspaceAgentsQueryKey,
  useWorkspaceAgents,
} from '@renderer/lib/stores/use-workspace-agents';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';

/**
 * Who this page is about: the agent's mark, its name and provider, the
 * description the rest of the team reads to know what it is for, and the two
 * things you come here to do.
 *
 * The description is the agent's own, held on its Switch server — the same
 * sentence written when it was created. It is not editable from here.
 */
export const AgentPageHeader = observer(function AgentPageHeader() {
  const {
    params: { locationId, agentName },
  } = useParams('location');
  const showCreateSessionModal = useShowModal('sessionModal');
  const { navigate } = useNavigate();
  const showAddToRoom = useShowModal('addAgentToRoomModal');
  const showRename = useShowModal('renameAgentModal');
  const confirmDeleteAgent = useConfirmDeleteAgent();

  const agent = agentsStore.agentAtLocation(locationId, agentName);
  // Never the location's name: a directory is not an agent, and standing its
  // basename in here also seeds the generated avatar from it, so the page
  // presents a whole identity that belongs to no agent.
  const agentMachineName = agent?.name ?? agentName ?? 'Agent';
  const provider = agent?.providerId ? providerDisplayName(agent.providerId) : null;

  const workspaceId = agent?.workspaceId ?? null;
  const { data: remoteAgents } = useWorkspaceAgents(workspaceId);
  const remote = (remoteAgents ?? []).find((a) => a.id === agent?.switchAgentId) ?? null;
  const description = remote?.description ?? null;

  // Use displayName as primary title, with fallback to the machine name
  const title = remote?.displayName ?? agentMachineName;
  // Show machine name as subtitle only if displayName exists and differs from name
  const showMachineName = remote?.displayName != null && remote.displayName !== agentMachineName;

  const roomable = workspaceId !== null && agent?.switchAgentId != null;

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const switchAgentId = agent?.switchAgentId ?? null;
  // A managed agent's page is where its chats are.
  const managedAgents = useManagedAgents(agent?.serverId ?? null);
  const chatsEnabled = useFeatureFlags(agent?.serverId).agent_chats;
  const chatsTab =
    chatsEnabled && (managedAgents.data ?? []).some((managed) => managed.agentId === switchAgentId);
  const newChat = chatsEnabled && agent?.serverId != null && switchAgentId !== null;

  /** The icon is stored on the Switch server, not locally, so a change is a
   * request that can fail. It is reported rather than swallowed: a picture
   * that silently reverts on the next refresh is worse than an error. */
  const changeIcon = async (iconUrl: string | null) => {
    if (workspaceId === null || switchAgentId === null) return;
    try {
      await rpc.workspaces.updateAgentIcon({ workspaceId, agentId: switchAgentId, iconUrl });
      await queryClient.invalidateQueries({ queryKey: workspaceAgentsQueryKey(workspaceId) });
    } catch (cause) {
      const { headline, detail } = describeFailure(cause, "Could not change the agent's icon.");
      toast({
        title: headline,
        description: detail ?? undefined,
        variant: 'destructive',
      });
    }
  };

  const editableIcon = workspaceId !== null && switchAgentId !== null;

  // Renaming is the server's to do first: an agent not registered on one has
  // nothing to rename there yet.
  const rename =
    workspaceId !== null && switchAgentId !== null && agent
      ? () =>
          showRename({
            workspaceId,
            switchAgentId,
            currentName: agentMachineName,
            currentDisplayName: remote?.displayName ?? null,
            localAgentId: agent.id,
            onSuccess: ({ outcome, localProblem }) => {
              void queryClient.invalidateQueries({
                queryKey: workspaceAgentsQueryKey(workspaceId),
              });
              const lines = [
                ...outcome.bridgeFailures.map((failure) => `Not yet updated on ${failure}.`),
                ...(localProblem ? [localProblem] : []),
              ];
              toast({
                title: `Renamed to ${outcome.agent.displayName ?? outcome.agent.name}`,
                description: lines.length > 0 ? lines.join(' ') : undefined,
                variant: lines.length > 0 ? 'destructive' : undefined,
              });
              navigate('location', { locationId, agentName: outcome.agent.name });
            },
          })
      : null;
  const remove = agent
    ? () =>
        void confirmDeleteAgent({
          locationId,
          agentId: agent.id,
          locationLabel: title,
          onDeleted: () => navigate('home'),
        })
    : null;

  return (
    <AgentHeaderLayout
      avatar={
        editableIcon ? (
          <AgentIconPicker
            serverId={agent?.serverId ?? null}
            name={title}
            iconUrl={remote?.iconUrl ?? null}
            onChange={changeIcon}
            size={88}
          />
        ) : (
          // Not registered on a server yet, so there is nothing to change the
          // icon on — shown, but not offered as editable.
          <AgentAvatar name={title} iconUrl={null} serverId={agent?.serverId ?? null} size={88} />
        )
      }
      title={title}
      badges={
        provider && (
          <Badge variant="secondary" className="h-5 shrink-0 px-2 text-[11px]">
            {provider}
          </Badge>
        )
      }
      titleActions={<AgentIdentityActions onRename={rename} onDelete={remove} disabled={false} />}
      machineName={showMachineName ? agentMachineName : null}
      description={description}
      actions={
        <>
          {!newChat && (
            <Button
              onClick={() =>
                showCreateSessionModal({ locationId, agentName, entryPoint: 'agent_page' })
              }
            >
              New Session
            </Button>
          )}
          {newChat && (
            <Button
              onClick={() => {
                const serverId = agent.serverId as string;
                const switchAgentId = agent.switchAgentId as string;
                if (chatsTab) {
                  navigate('managedAgent', { serverId, agentId: switchAgentId, name: title });
                  return;
                }
                const roomId = directChats.start(serverId, switchAgentId);
                navigate('chat', { serverId, roomId, agentId: switchAgentId });
              }}
            >
              New chat
            </Button>
          )}
          {roomable && (
            <Button
              variant="outline"
              onClick={() =>
                showAddToRoom({
                  workspaceId: workspaceId as string,
                  switchAgentId: agent.switchAgentId as string,
                  agentName: title,
                })
              }
            >
              Add to room
            </Button>
          )}
        </>
      }
    />
  );
});

/**
 * The header's arrangement, whatever agent it is about: the mark on the left,
 * then the title with its badges (which wrap under a title too long to share
 * its line, rather than shortening it), the agent's own name when the title is a
 * display name, its description, and the page's actions.
 */
export function AgentHeaderLayout({
  avatar,
  title,
  badges,
  titleActions,
  machineName,
  description,
  actions,
}: {
  avatar: React.ReactNode;
  title: React.ReactNode;
  badges: React.ReactNode;
  /** Small controls on the right of the title's line (Rename, Delete); null for none. */
  titleActions: React.ReactNode;
  /** The agent's name, shown under a display name that differs from it; null to leave it out. */
  machineName: string | null;
  description: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <header className="flex shrink-0 items-start gap-5 pt-10">
      <span className="flex size-[88px] shrink-0 items-center justify-center">{avatar}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h1 className="max-w-full shrink-0 text-3xl font-semibold tracking-tight [overflow-wrap:anywhere] text-foreground">
              {title}
            </h1>
            {badges}
          </div>
          {titleActions}
        </div>
        {machineName !== null && (
          <p className="text-sm text-foreground-muted">
            Machine name: <span className="font-mono">{machineName}</span>
          </p>
        )}
        {description && <p className="text-sm text-foreground-muted">{description}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div>
      </div>
    </header>
  );
}

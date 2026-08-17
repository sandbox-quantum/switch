import { useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import {
  getLocationStore,
  locationDisplayName,
} from '@renderer/features/locations/stores/location-selectors';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { AgentIconPicker } from '@renderer/lib/components/agent-icon-picker';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { remoteAgentsQueryKey, useRemoteAgents } from '@renderer/lib/stores/use-remote-agents';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
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
  const showAddToRoom = useShowModal('addAgentToRoomModal');

  const agent = agentsStore.agentAtLocation(locationId, agentName);
  const title = agent?.name ?? agentName ?? locationDisplayName(getLocationStore(locationId)) ?? '';
  const provider = agent?.providerId ? providerDisplayName(agent.providerId) : null;

  const serverId = agent?.serverId ?? null;
  const { data: remoteAgents } = useRemoteAgents(serverId);
  const remote = (remoteAgents ?? []).find((a) => a.id === agent?.switchAgentId) ?? null;
  const description = remote?.description ?? null;

  const roomable = serverId !== null && agent?.switchAgentId != null;

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const switchAgentId = agent?.switchAgentId ?? null;

  /** The icon is stored on the Switch server, not locally, so a change is a
   * request that can fail. It is reported rather than swallowed: a picture
   * that silently reverts on the next refresh is worse than an error. */
  const changeIcon = async (iconUrl: string | null) => {
    if (serverId === null || switchAgentId === null) return;
    try {
      await rpc.switchServers.updateAgentIcon({ serverId, agentId: switchAgentId, iconUrl });
      await queryClient.invalidateQueries({ queryKey: remoteAgentsQueryKey(serverId) });
    } catch (cause) {
      toast({
        title: "Could not change the agent's icon",
        description: cause instanceof Error ? cause.message : String(cause),
        variant: 'destructive',
      });
    }
  };

  const editableIcon = serverId !== null && switchAgentId !== null;

  return (
    <header className="flex shrink-0 items-start gap-5 pt-10">
      <span className="flex size-[88px] shrink-0 items-center justify-center">
        {editableIcon ? (
          <AgentIconPicker
            name={title}
            iconUrl={remote?.iconUrl ?? null}
            onChange={changeIcon}
            size={88}
          />
        ) : (
          // Not registered on a server yet, so there is nothing to change the
          // icon on — shown, but not offered as editable.
          <AgentAvatar name={title} iconUrl={null} size={88} />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate text-3xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {provider && (
            <Badge variant="secondary" className="h-5 shrink-0 px-2 text-[11px]">
              {provider}
            </Badge>
          )}
        </div>
        {description && <p className="text-sm text-foreground-muted">{description}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button onClick={() => showCreateSessionModal({ locationId, agentName })}>
            New Session <BoundShortcut settingsKey="newSession" />
          </Button>
          {roomable && (
            <Button
              variant="outline"
              onClick={() =>
                showAddToRoom({
                  serverId: serverId as string,
                  switchAgentId: agent.switchAgentId as string,
                  agentName: title,
                })
              }
            >
              Add to room
            </Button>
          )}
        </div>
      </div>
    </header>
  );
});

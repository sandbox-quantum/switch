import { type ChatSummary } from '@switch-console/chat-ui/contracts/chats';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { chatFailure } from '@renderer/features/chats/chat-errors';
import { workspaceRosterQuery } from '@renderer/features/chats/chat-people';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { ParticipantPicker } from '@renderer/lib/components/participant-picker';
import {
  agentParticipant,
  type Participant,
  personParticipant,
} from '@renderer/lib/components/participant-search';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import {
  invitableAgents,
  useRoomAgentCandidates,
} from '@renderer/lib/stores/use-room-agent-candidates';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@renderer/lib/ui/input-group';
import { cn } from '@renderer/utils/utils';
import { knownAgentTypeDisplayName } from '@shared/core/providers/agent-provider-registry';
import { runsOnThisComputer } from '@shared/core/switch-servers/switch-servers';
import type { RemoteRoomDetail } from '@shared/core/switch-servers/switch-servers';
import { administersWorkspace } from '@shared/core/workspaces/workspaces';
import { addableAgents, addableBridgePeople, addablePeople } from './room-labels';
import { agentKindFor, localAgentFor, PersonMark, roomDetailKey } from './room-participants';

/*
 * Adding agents and people to a room, as the room's participant column offers
 * it: through the chats API for a Console chat, through the room for anything
 * else.
 */

/** Adds a picked participant through the chats API: an agent to the chat, a person as a member. */
export async function addToChat(
  api: Pick<typeof rpc.chats, 'addAgent' | 'addMember'>,
  serverId: string,
  roomId: string,
  participant: Participant
): Promise<
  | { kind: 'agent'; chat: ChatSummary }
  | { kind: 'person'; members: Awaited<ReturnType<typeof rpc.chats.addMember>> }
> {
  if (participant.kind === 'agent')
    return {
      kind: 'agent',
      chat: await api.addAgent({ serverId, roomId, agentId: participant.id }),
    };
  return {
    kind: 'person',
    members: await api.addMember({ serverId, roomId, userId: participant.id }),
  };
}

const ADD_PARTICIPANT_INPUT = 'chat-add-participant';

/** The Add button's label: how many it adds once there is more than one. */
export function addLabel(count: number): string {
  return count > 1 ? `Add ${count}` : 'Add';
}

/**
 * Adds each pick in turn through the chats API, telling `onAdded` of each
 * success; resolves to the picks the server refused, each with its reason.
 * One at a time, so each add sees the chat as the one before left it.
 */
export async function addAllToChat(
  api: Pick<typeof rpc.chats, 'addAgent' | 'addMember'>,
  serverId: string,
  roomId: string,
  picks: Participant[],
  onAdded: (added: Awaited<ReturnType<typeof addToChat>>) => void
): Promise<{ participant: Participant; reason: string }[]> {
  const failures: { participant: Participant; reason: string }[] = [];
  for (const participant of picks) {
    try {
      onAdded(await addToChat(api, serverId, roomId, participant));
    } catch (cause) {
      failures.push({ participant, reason: chatFailure(cause).message });
    }
  }
  return failures;
}

/**
 * The New room dialog's participant field: picks gather as chips, and Add
 * puts them all in the chat. It offers the agents the viewer may add and the
 * people on the roster, never someone already in the chat.
 */
export const ChatAddParticipantPanel = observer(function ChatAddParticipantPanel({
  serverId,
  workspaceId,
  chat,
  memberIds,
  onAddedPeople,
}: {
  serverId: string;
  workspaceId: string | null;
  chat: ChatSummary;
  /** The people in the chat, the viewer included. */
  memberIds: Set<string>;
  onAddedPeople: (members: Awaited<ReturnType<typeof rpc.chats.addMember>>) => void;
}) {
  const tenantId = chatsStore.tenantId;
  const agents = useWorkspaceAgents(workspaceId);
  const roster = useQuery(workspaceRosterQuery(serverId, tenantId));
  const allowed = useQuery({
    // Keyed by the chat's agents, so adding or removing one asks again.
    queryKey: [
      'chat-agent-candidates',
      serverId,
      workspaceId,
      chat.roomId,
      chat.agents.map((agent) => agent.id).join(','),
    ],
    queryFn: () => rpc.chats.agentCandidates({ serverId, roomId: chat.roomId }),
  });
  const [picked, setPicked] = useState<Participant[]>([]);
  const [adding, setAdding] = useState(false);
  const [refused, setRefused] = useState<string[]>([]);
  const candidates = [
    ...addableAgents(agents.data ?? [], allowed.data ?? []).map((agent) =>
      agentParticipant(agent, knownAgentTypeDisplayName(agent.knownAgentType) ?? 'Agent')
    ),
    ...addablePeople(roster.data ?? [], memberIds).map(personParticipant),
  ];

  async function addAll() {
    if (adding || picked.length === 0) return;
    setAdding(true);
    setRefused([]);
    const failures = await addAllToChat(rpc.chats, serverId, chat.roomId, picked, (added) => {
      if (added.kind === 'agent') chatsStore.add(serverId, added.chat);
      else onAddedPeople(added.members);
    });
    setPicked(failures.map((failure) => failure.participant));
    setRefused(
      failures.map(({ participant, reason }) => `${participant.name} was not added — ${reason}`)
    );
    setAdding(false);
  }

  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <ParticipantPicker
            inputId={ADD_PARTICIPANT_INPUT}
            autoFocus={false}
            busy={adding}
            overlay
            candidates={candidates}
            picked={picked}
            onChange={setPicked}
            serverId={serverId}
            loading={
              agents.isPending || allowed.isPending || (tenantId !== null && roster.isPending)
            }
          />
        </div>
        <ConfirmButton
          size="sm"
          className="h-8 shrink-0"
          disabled={picked.length === 0 || adding}
          onClick={() => void addAll()}
        >
          {addLabel(picked.length)}
        </ConfirmButton>
      </div>
      {refused.map((line) => (
        <p key={line} className="text-xs text-destructive">
          {line}
        </p>
      ))}
      {(agents.isError || allowed.isError) && (
        <p className="text-xs text-destructive">
          {failureText(agents.error ?? allowed.error, 'Could not list the agents.')}
        </p>
      )}
      {tenantId === null ? (
        <p className="text-xs text-destructive">
          This workspace has no tenant to list people from.
        </p>
      ) : (
        roster.isError && (
          <p className="text-xs text-destructive">
            {failureText(roster.error, 'Could not list the people.')}
          </p>
        )
      )}
      <InviteHint workspaceId={workspaceId} canInvite={canInvite(serverId, workspaceId)} />
    </div>
  );
});

/** Whether the viewer may invite people to the workspace, as the workspace menu decides it. */
function canInvite(serverId: string, workspaceId: string | null): boolean {
  const workspace = workspacesStore.workspaces.find((each) => each.id === workspaceId) ?? null;
  const server = switchServersStore.servers.find((each) => each.id === serverId) ?? null;
  return (
    workspace !== null &&
    server !== null &&
    administersWorkspace(workspace) &&
    !runsOnThisComputer(server)
  );
}

/** Where to go for someone the roster does not have yet. */
export function InviteHint({
  workspaceId,
  canInvite,
}: {
  workspaceId: string | null;
  canInvite: boolean;
}) {
  const showInvitePeopleModal = useShowModal('invitePeopleModal');
  return (
    <p className="px-1 text-xs text-foreground-muted">
      Don&apos;t see someone?{' '}
      {canInvite && workspaceId !== null ? (
        <button
          type="button"
          className="cursor-pointer underline hover:text-foreground"
          onClick={() => showInvitePeopleModal({ workspaceId })}
        >
          Invite them to the workspace
        </button>
      ) : (
        'Ask a workspace admin to invite them.'
      )}
    </p>
  );
}

/**
 * Invite people to a bridged room from the messaging app's users Switch knows.
 * The server does not say who it could not add, so the names asked for are
 * compared with the room's people afterwards and any missing are named.
 */
export const AddPeoplePanel = observer(function AddPeoplePanel({
  workspaceId,
  room,
  bridgeId,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
  bridgeId: string;
}) {
  const queryClient = useQueryClient();
  const [notAdded, setNotAdded] = useState<string | null>(null);
  const people = useQuery({
    queryKey: ['bridge-people', workspaceId, bridgeId],
    queryFn: () => rpc.workspaces.listBridgePeople({ workspaceId, bridgeId }),
  });
  const present = new Set(room.connectedUserNames);
  return (
    <>
      <AddParticipantPanel
        noun="person"
        searchPlaceholder={`Search people on ${room.bridgeDisplayName ?? 'the messaging app'}…`}
        allInText="Everyone Switch knows on this messaging app is already in the room."
        loading={people.isPending}
        loadError={people.isError ? failureText(people.error, 'Could not list the people.') : null}
        candidates={addableBridgePeople(people.data ?? [], present).map((person) => ({
          ...person,
          mark: <PersonMark name={person.name} size="sm" />,
        }))}
        footer={
          <p className="px-1 text-xs text-foreground-muted">
            Only people Switch has seen on this messaging app are listed.
          </p>
        }
        onAdd={async (username) => {
          setNotAdded(null);
          const updated = await rpc.workspaces.addRoomUsers({
            workspaceId,
            roomId: room.id,
            userNames: [username],
          });
          queryClient.setQueryData(roomDetailKey(workspaceId, room.id), updated);
          if (!updated.connectedUserNames.includes(username))
            setNotAdded(
              `@${username} was not added. The messaging app may not have let Switch invite them.`
            );
        }}
      />
      {notAdded !== null && <p className="text-xs text-destructive">{notAdded}</p>}
    </>
  );
});

type Candidate = { id: string; name: string; mark: React.ReactNode; detail: string };

/**
 * A searchable list of who could join, each row adding one. A refusal is shown
 * in the words `onAdd` threw with.
 */
function AddParticipantPanel({
  noun,
  searchPlaceholder,
  allInText,
  loading,
  loadError,
  candidates,
  footer,
  onAdd,
}: {
  noun: string;
  searchPlaceholder: string;
  allInText: string;
  loading: boolean;
  loadError: string | null;
  candidates: Candidate[];
  /** Under the list, such as where to go for someone who is not in it. */
  footer: React.ReactNode;
  onAdd: (id: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = filter.trim().toLowerCase();
  const shown = candidates.filter(
    (candidate) =>
      query === '' || `${candidate.name}\n${candidate.detail}`.toLowerCase().includes(query)
  );

  async function add(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await onAdd(id);
    } catch (cause) {
      setError(failureText(cause, `Could not add the ${noun}.`));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 pt-1">
      <InputGroup>
        <InputGroupAddon>
          <Search className="size-3.5 text-foreground-muted" />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus
          placeholder={searchPlaceholder}
          aria-label={`Search for a ${noun} to add`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter !== '' && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label="Clear the search"
              onClick={() => setFilter('')}
            >
              <X className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>

      {error !== null && <p className="text-xs text-destructive">Not added — {error}</p>}
      {loadError !== null && <p className="text-xs text-destructive">{loadError}</p>}

      {loading ? (
        <p className="px-1 py-2 text-sm text-foreground-muted">Loading…</p>
      ) : shown.length === 0 ? (
        loadError === null && (
          <p className="px-1 py-2 text-sm text-foreground-muted">
            {query === '' ? allInText : `No ${noun} here matches “${filter.trim()}”.`}
          </p>
        )
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
          {shown.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              disabled={busyId !== null}
              onClick={() => void add(candidate.id)}
              className={cn(
                'flex w-full cursor-pointer items-center gap-3 bg-background px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--fill)]',
                busyId !== null && 'cursor-wait'
              )}
            >
              {candidate.mark}
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {candidate.name}
              </span>
              <span className="shrink-0 text-xs text-foreground-muted">{candidate.detail}</span>
              <span className="shrink-0 text-xs font-medium text-foreground">
                {busyId === candidate.id ? 'Adding…' : 'Add'}
              </span>
            </button>
          ))}
        </div>
      )}
      {footer}
    </div>
  );
}

/**
 * Search the server's agents and put one in the room — any agent the viewer can
 * see, as the gateway offers. Whether an agent then answers anyone in the room
 * is still up to its own addressing rules.
 */
export const AddAgentPanel = observer(function AddAgentPanel({
  workspaceId,
  room,
  onAdded,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
  onAdded: () => Promise<void>;
}) {
  const members = new Set(room.agentIds);
  const remoteAgents = useWorkspaceAgents(workspaceId);
  // Only the agents the server would let this person invite are listed.
  const candidates = useRoomAgentCandidates(workspaceId, room.id);
  const serverId = workspacesStore.serverIdFor(workspaceId);
  const viewerId = serverId ? (switchServersStore.statusFor(serverId)?.user?.id ?? null) : null;
  return (
    <AddParticipantPanel
      noun="agent"
      footer={null}
      searchPlaceholder="Search agents…"
      allInText={
        (remoteAgents.data ?? []).length === 0
          ? 'There are no agents on this server yet.'
          : candidates.data
            ? 'No other agents you can invite. You can bring in your own agents and agents that anyone may address.'
            : 'Every agent on this server is already in this room.'
      }
      loading={remoteAgents.isPending || candidates.isPending}
      loadError={
        remoteAgents.isError
          ? failureText(remoteAgents.error, 'Could not list the agents.')
          : candidates.isError
            ? failureText(candidates.error, 'Could not work out which agents you can invite.')
            : null
      }
      candidates={invitableAgents(remoteAgents.data ?? [], candidates.data)
        .filter((agent) => !members.has(agent.id))
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          mark: (
            <AgentAvatar name={agent.name} iconUrl={agent.iconUrl} serverId={serverId} size={22} />
          ),
          detail: [
            localAgentFor(agent.id, workspaceId) ||
            (viewerId !== null && agent.ownerId === viewerId)
              ? 'yours'
              : agent.ownerName
                ? `${agent.ownerName}’s`
                : null,
            agentKindFor(agent.id, workspaceId, new Map([[agent.id, agent]])),
          ]
            .filter(Boolean)
            .join(' · '),
        }))}
      onAdd={async (agentId) => {
        await rpc.workspaces.addRoomAgents({
          workspaceId,
          roomId: room.id,
          agentIds: [agentId],
          direction: 'agents_to_room',
        });
        await onAdded();
      }}
    />
  );
});

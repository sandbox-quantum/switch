import { useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { chatFailure } from '@renderer/features/chats/chat-errors';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { openRoomView } from '@renderer/features/sidebar/sidebar-room-grouping';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { addableAgents, addablePeople } from '@renderer/features/switch-rooms/room-labels';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { agentProviderLabel } from '@renderer/lib/components/agent-mark';
import { agentProviderLabelFor } from '@renderer/lib/components/agent-picker';
import {
  type FixedParticipant,
  ParticipantPicker,
} from '@renderer/lib/components/participant-picker';
import {
  agentParticipant,
  bridgePersonParticipant,
  carryPicks,
  type Participant,
  personParticipant,
} from '@renderer/lib/components/participant-search';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps, useModalContext } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import {
  invitableAgents,
  useRoomAgentCandidates,
} from '@renderer/lib/stores/use-room-agent-candidates';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Textarea } from '@renderer/lib/ui/textarea';
import { knownAgentTypeDisplayName } from '@shared/core/providers/agent-provider-registry';
import { CreateRoomOptions, RoomChannelField } from './create-room-options';
import { MessagingAppSelector, SWITCH_CONSOLE } from './messaging-app-selector';
import { optionsForBridge } from './room-channel-choices';
import {
  CreateRequestIds,
  canCreate,
  DEFAULT_ROOM_OPTIONS,
  dropsStartingAgent,
  type RoomCreateOptions,
  roomCreateRequest,
  roomOptionsReady,
  startingAgentResolution,
} from './room-create-request';
import { RoomNameInput } from './room-name-input';
import { switchServersStore } from './switch-servers-store';
import { useMyIdentities } from './use-my-identities';
import { administersWorkspaceById } from './workspace-admin';

type CreateRoomModalArgs = {
  /** Create on this server instead of the active one — for callers that are not
   * driven by the sidebar's server scope, such as onboarding. */
  serverId?: string;
  /** An agent to start the room with, already picked: the room is made from its page. */
  agentId?: string;
};

type Props = BaseModalProps<{ roomId: string }> & CreateRoomModalArgs;

/**
 * A new room: its name, then who is in it — agents and people found in one
 * field — and, when the server has a messaging app that can make channels,
 * where it lives. Switch Console is the default and needs no app. Either way
 * it can be made with its description, instructions, group and access; only
 * a room on a messaging app has a channel to choose.
 */
export const CreateRoomModal = observer(function CreateRoomModal({
  serverId: overrideServerId,
  agentId: startingAgentId,
  onSuccess,
  onClose,
}: Props) {
  const { setCloseGuard } = useModalContext();

  // The sidebar shows one server at a time, so the room belongs to that server;
  // asking again would let the user create a room somewhere they are not
  // looking, and then wonder where it went.
  const serverId = overrideServerId ?? switchServersStore.activeServerId ?? '';
  const workspaceId = workspacesStore.idOnServerInScope(serverId || null);
  const workspace = workspacesStore.workspaces.find((each) => each.id === workspaceId) ?? null;
  // Whether the private channel note applies: a platform that needs the
  // person as the channel's owner takes only a confirmed linked account.
  const { identities } = useMyIdentities(workspaceId);
  const server = switchServersStore.servers.find((s) => s.id === serverId) ?? null;
  const myUserId = switchServersStore.statusFor(serverId)?.user?.id ?? null;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [where, setWhere] = useState(SWITCH_CONSOLE);
  const [options, setOptions] = useState<RoomCreateOptions>(DEFAULT_ROOM_OPTIONS);
  const [picked, setPicked] = useState<Participant[]>([]);
  // Who a change of messaging app left out, as no one of theirs is known there.
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [switchingApp, setSwitchingApp] = useState(false);
  // Which change of app is the latest: an earlier one finishing after it is dropped.
  const appChange = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [requestIds] = useState(() => new CreateRequestIds(() => crypto.randomUUID()));

  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', workspaceId],
    queryFn: () => rpc.workspaces.listBridges(workspaceId as string),
    enabled: workspaceId !== null,
  });
  const agentsQuery = useQuery({
    queryKey: ['remote-agents', workspaceId],
    queryFn: () => rpc.workspaces.listAgents(workspaceId as string),
    enabled: workspaceId !== null,
  });
  const tenantId = workspace?.tenantId ?? null;
  const rosterQuery = useQuery({
    queryKey: ['workspace-members', serverId, tenantId],
    queryFn: () => rpc.chats.workspaceMembers({ serverId, tenantId: tenantId as string }),
    enabled: tenantId !== null,
  });
  // Only an admin files a room in a group; for anyone else it is made with none.
  const administers = workspaceId !== null && administersWorkspaceById(workspaceId);
  // A group's rules can admit an agent there and nowhere else, so the agents
  // offered follow the group chosen.
  const candidateGroupId = administers ? options.groupId : null;
  const allowedQuery = useQuery({
    queryKey: ['chat-agent-candidates', serverId, workspaceId, null, candidateGroupId],
    queryFn: () => rpc.chats.agentCandidates({ serverId, roomId: null, groupId: candidateGroupId }),
    enabled: serverId !== '',
  });
  const managedQuery = useManagedAgents(serverId || null);
  const bridgePeopleQuery = (bridgeId: string) => ({
    queryKey: ['bridge-people', workspaceId, bridgeId],
    queryFn: () =>
      rpc.workspaces.listBridgePeople({ workspaceId: workspaceId as string, bridgeId }),
  });
  // The agents the server's invite rule lets this person put into a new room.
  const invitableQuery = useRoomAgentCandidates(workspaceId, null);

  // Only a running bridge allowed to create channels can back a new room.
  const bridges = (bridgesQuery.data ?? []).filter(
    (b) => b.status === 'active' && b.canCreateChannels
  );
  // Without the server's group_chats flag there are no Switch Console rooms: a room is a bridged one.
  const consoleOffered = useFeatureFlags(serverId || null).group_chats;
  const selectedBridge =
    bridges.find((b) => b.id === where) ?? (consoleOffered ? null : (bridges[0] ?? null));
  const nowhere = !consoleOffered && selectedBridge === null && !bridgesQuery.isLoading;
  // A channel, and above all a typed id, belongs to the app it was chosen for:
  // when the app the room would go to changes, however it changed, the choice
  // starts again from a new public channel. Picking the app already shown keeps it.
  const resolvedBridgeId = selectedBridge?.id ?? null;
  const channelBridgeId = useRef(resolvedBridgeId);
  useEffect(() => {
    if (channelBridgeId.current === resolvedBridgeId) return;
    channelBridgeId.current = resolvedBridgeId;
    setOptions((now) => ({ ...now, channel: DEFAULT_ROOM_OPTIONS.channel }));
  }, [resolvedBridgeId]);

  const peopleQuery = useQuery({
    ...bridgePeopleQuery(resolvedBridgeId ?? ''),
    enabled: workspaceId !== null && resolvedBridgeId !== null,
  });

  const managedProviders = new Map(
    (managedQuery.data ?? []).map((managed) => [managed.agentId, managed.definition.provider])
  );
  const providerLabel = (agentId: string, knownType: string | null) =>
    managedProviders.has(agentId)
      ? agentProviderLabel(managedProviders.get(agentId))
      : (knownAgentTypeDisplayName(knownType) ?? agentProviderLabelFor(agentId, workspaceId));
  // A bridged room is driven from this install, so it takes only the agents
  // this install registered or manages, and the people Switch knows on its
  // app. A Switch Console room is driven through the server: the agents the
  // server says the person may use, and its people.
  const agentCandidates = selectedBridge
    ? invitableAgents(agentsQuery.data ?? [], invitableQuery.data).filter(
        (remote) =>
          workspaceId !== null &&
          (managedProviders.has(remote.id) ||
            agentsStore
              .agentsInWorkspace(workspaceId)
              .some((local) => local.switchAgentId === remote.id))
      )
    : addableAgents(agentsQuery.data ?? [], allowedQuery.data ?? []);
  // A new channel on an app is made with its creator in it, so they are shown
  // in it, through the account of theirs it will use, rather than offered. A
  // private one says plainly when they have none, as it would be refused; a
  // public one is made without them then, and on an app where joining a
  // public channel means more (Teams), so it shows nobody.
  const offeredChannel = optionsForBridge(options, selectedBridge).channel;
  const makesPrivateChannel =
    selectedBridge !== null && offeredChannel.kind === 'new' && offeredChannel.private;
  const myAccount = selectedBridge
    ? (identities ?? []).find((each) => each.bridgeId === selectedBridge.id && each.verified)
    : undefined;
  const addsMeToPublicChannel =
    selectedBridge !== null &&
    offeredChannel.kind === 'new' &&
    !offeredChannel.private &&
    selectedBridge.publicChannelAddsCreator &&
    myAccount !== undefined;
  const addsMe = makesPrivateChannel || addsMeToPublicChannel;
  const fixed: FixedParticipant[] =
    addsMe && selectedBridge
      ? [
          {
            participant: { kind: 'person', id: myUserId ?? 'me', name: 'You', detail: '' },
            detail: myAccount
              ? `@${myAccount.externalUsername}`
              : identities === null
                ? ''
                : `No linked ${selectedBridge.displayName} account`,
            warning: identities !== null && myAccount === undefined,
          },
        ]
      : [];
  const people: Participant[] = selectedBridge
    ? (peopleQuery.data ?? [])
        .filter((person) => !(addsMe && person.externalUserId === myAccount?.externalUserId))
        .map(bridgePersonParticipant)
    : addablePeople(rosterQuery.data ?? [], new Set([myUserId ?? ''])).map(personParticipant);
  const candidates: Participant[] = [
    ...agentCandidates.map((agent) =>
      agentParticipant(agent, providerLabel(agent.id, agent.knownAgentType))
    ),
    ...people,
  ];
  // The agent the room is made from shows picked once the agents are read, whatever
  // else is edited meanwhile, until its chip is removed.
  const [startDropped, setStartDropped] = useState(false);
  const startChip =
    startingAgentId === undefined || startDropped
      ? null
      : (candidates.find((each) => each.kind === 'agent' && each.id === startingAgentId) ?? null);
  const shownPicked = startChip
    ? [startChip, ...picked.filter((each) => each.id !== startChip.id)]
    : picked;
  const changePicks = (next: Participant[]) => {
    if (dropsStartingAgent(startChip, next)) setStartDropped(true);
    setPicked(next);
  };
  // A choice the chosen app does not offer (a private channel on Telegram, say)
  // falls back to a new public channel rather than being sent and refused.
  const bridgeOptions = optionsForBridge(options, selectedBridge);
  const roomOptions = administers ? bridgeOptions : { ...bridgeOptions, groupId: null };
  const agentIds = shownPicked.filter((each) => each.kind === 'agent').map((each) => each.id);
  const pickedPeople = shownPicked.filter((each) => each.kind === 'person').map((each) => each.id);
  const memberUserIds = selectedBridge ? [] : pickedPeople;
  const userNames = selectedBridge ? pickedPeople : [];

  const trimmedName = name.trim();
  // The agent the room is made from must be applied, or known not to be, before creating:
  // a quick Create would otherwise make the room without it.
  const startingAgentState = startingAgentResolution({
    startingAgentId,
    applied: startDropped || startChip !== null,
    failed: agentsQuery.isError || (!selectedBridge && allowedQuery.isError),
    loaded:
      agentsQuery.isSuccess &&
      !agentsQuery.isFetching &&
      (selectedBridge === null || !invitableQuery.isPending) &&
      (selectedBridge !== null || (allowedQuery.isSuccess && !allowedQuery.isFetching)),
  });
  const startingAgentName =
    (agentsQuery.data ?? []).find((agent) => agent.id === startingAgentId)?.name ?? 'This agent';
  const canSubmit =
    workspaceId !== null &&
    startingAgentState !== 'pending' &&
    !nowhere &&
    !switchingApp &&
    canCreate({ name }) &&
    (selectedBridge === null || roomOptionsReady(roomOptions, selectedBridge.type)) &&
    !isSubmitting;

  /**
   * Move the room to another app, keeping the people picked who are known
   * there too (the same Switch user, through an account they linked) and
   * saying who is not. Create waits until that is worked out, so a pick is
   * never sent to an app it does not belong to.
   */
  async function changeApp(next: string) {
    setError(null);
    const change = ++appChange.current;
    const pickedPeople = shownPicked.filter((each) => each.kind === 'person');
    if (pickedPeople.length === 0 || workspaceId === null) {
      setLeftOut([]);
      setWhere(next);
      setSwitchingApp(false);
      return;
    }
    // The app and the picks are held still meanwhile, so nothing picked in
    // the wait is lost when the people carried over are put in.
    setSwitchingApp(true);
    try {
      let there: Participant[] = [];
      try {
        there =
          next === SWITCH_CONSOLE
            ? addablePeople(rosterQuery.data ?? [], new Set([myUserId ?? ''])).map(
                personParticipant
              )
            : (await queryClient.fetchQuery(bridgePeopleQuery(next))).map(bridgePersonParticipant);
      } catch {
        // Unknown there: nobody can be carried, and each is named as left out.
      }
      if (change !== appChange.current) return;
      const { kept, dropped } = carryPicks(pickedPeople, there);
      changePicks([...shownPicked.filter((each) => each.kind === 'agent'), ...kept]);
      setLeftOut(dropped.map((each) => each.name));
      setWhere(next);
    } finally {
      if (change === appChange.current) setSwitchingApp(false);
    }
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setCloseGuard(true);
    setError(null);

    try {
      const bridgeId = selectedBridge?.id ?? null;
      const request = roomCreateRequest({
        serverId,
        workspaceId: workspaceId as string,
        bridgeId,
        bridgeType: selectedBridge?.type ?? null,
        name,
        description,
        instructions,
        agentIds,
        memberUserIds,
        userNames,
        requestId: requestIds.for({
          bridgeId,
          name,
          agentIds,
          memberUserIds: [...memberUserIds, ...userNames],
          settings: [description.trim(), instructions.trim(), roomOptions],
        }),
        options: roomOptions,
      });
      if (request.kind === 'chat') {
        const chat = await rpc.chats.create(request.params);
        requestIds.succeeded();
        chatsStore.add(serverId, chat);
        sidebarStore.setGrouping('room');
        openRoomView(chat.roomId);
        onSuccess({ roomId: chat.roomId });
        return;
      }
      const result = await rpc.workspaces.createRoom(request.params);

      if (result.kind !== 'created') {
        setError(messageFor(result));
        return;
      }

      // Re-read the room state so the sidebar shows the room straight away
      // rather than at the next window focus. This goes through the sidebar's
      // own refresh rather than `refreshRoomState`, which only re-reads
      // membership for the agents the sidebar knew about when it last loaded —
      // an agent onboarded moments ago is not among them, so the room would
      // appear with nothing under it until the next reconcile.
      await refreshSidebarRoomState(true);

      // Open what was just created: listed in the sidebar, expanded in the
      // tree, and shown in the main panel. Creating a room and being left where
      // you were reads as if nothing happened — and the agent grouping does not
      // list rooms at all, so the new room would be nowhere on screen.
      sidebarStore.setGrouping('room');
      sidebarStore.ensureRoomExpanded(result.room.id);
      openRoomView(result.room.id);

      onSuccess({ roomId: result.room.id });
    } catch (cause) {
      setError(
        selectedBridge
          ? failureText(cause, 'Could not create the room.')
          : chatFailure(cause).message
      );
    } finally {
      setIsSubmitting(false);
      setCloseGuard(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>New room</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <div className="flex w-full flex-col gap-5">
          {!server && (
            <p className="text-xs text-destructive">
              No Switch server is selected, so there is nowhere to create a room. Choose a server in
              the sidebar first.
            </p>
          )}

          <Field>
            <FieldLabel htmlFor="new-room-name">Name</FieldLabel>
            <RoomNameInput
              id="new-room-name"
              value={name}
              onChange={(next) => {
                setName(next);
                setError(null);
              }}
              onSubmit={() => {
                if (canSubmit) void handleSubmit();
              }}
            />
            {/* What the name becomes, where it becomes it: a bridged room is a
                channel of the same name in its app. */}
            {trimmedName !== '' && selectedBridge && roomOptions.channel.kind === 'new' && (
              <span className="text-xs text-foreground-muted">
                {`Created as ${roomOptions.channel.private ? 'private ' : ''}#${trimmedName} in ${selectedBridge.displayName}.`}
              </span>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="new-room-participants">Participants</FieldLabel>
            <ParticipantPicker
              inputId="new-room-participants"
              autoFocus={false}
              busy={isSubmitting || switchingApp}
              busyLabel={switchingApp ? 'Matching people…' : 'Adding…'}
              overlay={false}
              candidates={candidates}
              picked={shownPicked}
              onChange={changePicks}
              serverId={serverId || null}
              loading={
                agentsQuery.isLoading ||
                (selectedBridge ? peopleQuery.isLoading : rosterQuery.isLoading) ||
                (!selectedBridge && allowedQuery.isLoading)
              }
              fixed={fixed}
            />
            {leftOut.length > 0 && (
              <p className="text-xs text-foreground-muted">
                {selectedBridge
                  ? `Not added: ${leftOut.join(', ')}. Switch doesn’t know them on ${selectedBridge.displayName}.`
                  : `Not added: ${leftOut.join(', ')}. They have no Switch account linked to theirs.`}
              </p>
            )}
            <span className="text-xs text-foreground-muted">
              Agents answer only when someone @-mentions them.
            </span>
            {(agentsQuery.isError || (!selectedBridge && allowedQuery.isError)) && (
              <p className="text-xs text-destructive">
                {failureText(agentsQuery.error ?? allowedQuery.error, 'Could not load the agents.')}
              </p>
            )}
            {selectedBridge && invitableQuery.isError && (
              <p className="text-xs text-destructive">
                {failureText(
                  invitableQuery.error,
                  'Could not work out which agents you can invite.'
                )}
              </p>
            )}
            {(selectedBridge ? peopleQuery.isError : rosterQuery.isError) && (
              <p className="text-xs text-destructive">
                {failureText(
                  selectedBridge ? peopleQuery.error : rosterQuery.error,
                  'Could not load the people.'
                )}
              </p>
            )}
          </Field>

          {/* Where a bridged room lives is decided now: Console cannot move it later. */}
          {selectedBridge && (
            <RoomChannelField
              bridge={selectedBridge}
              linkedHere={
                identities === null
                  ? null
                  : identities.some((each) => each.bridgeId === selectedBridge.id && each.verified)
              }
              value={roomOptions}
              onChange={(next) => {
                setOptions(next);
                setError(null);
              }}
            />
          )}

          {/* The room's own settings, wherever it lives. */}
          {!nowhere && (
            <>
              <Field>
                <FieldLabel htmlFor="new-room-description">Description (optional)</FieldLabel>
                <Input
                  id="new-room-description"
                  placeholder="What this room is for"
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setError(null);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="new-room-instructions">Instructions (optional)</FieldLabel>
                <Textarea
                  id="new-room-instructions"
                  placeholder="Guidance shown to agents when they enter the room"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={3}
                />
              </Field>
              <CreateRoomOptions
                workspaceId={workspaceId}
                administersWorkspace={administers}
                bridged={selectedBridge !== null}
                value={roomOptions}
                onChange={(next) => {
                  setOptions(next);
                  setError(null);
                }}
              />
            </>
          )}

          {nowhere && (
            <p className="text-xs text-destructive">
              This server does not offer Switch Console rooms yet, and none of its messaging apps
              can create a channel, so there is nowhere to create a room.
            </p>
          )}
          {startingAgentState === 'failed' && (
            <p className="text-xs text-destructive">
              {startingAgentName} can&apos;t be added to the new room:{' '}
              {failureText(
                agentsQuery.error ?? allowedQuery.error,
                'the agents could not be loaded.'
              )}
            </p>
          )}
          {startingAgentState === 'unavailable' && (
            <p className="text-xs text-destructive">
              {startingAgentName} can&apos;t be added to this room: it is not one you can add here.
            </p>
          )}
          {bridgesQuery.isError && (
            <p className="text-xs text-destructive">
              {failureText(bridgesQuery.error, 'Could not load messaging apps.')}
            </p>
          )}
        </div>
      </DialogContentArea>
      {/* Outside the scrolling form, beside the button that caused it, so a
          refusal is never scrolled out of sight under a long form. */}
      {error && (
        <p role="alert" className="px-6 pb-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter className="sm:justify-between">
        <MessagingAppSelector
          bridges={bridges}
          consoleOffered={consoleOffered}
          value={where}
          onChange={(next) => void changeApp(next)}
          disabled={switchingApp || isSubmitting}
        />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <ConfirmButton onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {isSubmitting ? 'Creating…' : 'Create room'}
          </ConfirmButton>
        </div>
      </DialogFooter>
    </>
  );
});

/** Turn a failed create into something the user can act on. */
function messageFor(result: { kind: string; message?: string }): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'bridge-unavailable':
      return result.message ?? 'The messaging app is not available.';
    default:
      return result.message ?? 'Could not create the room.';
  }
}

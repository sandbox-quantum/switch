import { observer } from 'mobx-react-lite';
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from 'react';
import type { RemoteBridge } from '../contracts/switch-servers';
import { chatFailure, failureText } from '../model/failures';
import {
  bridgePersonParticipant,
  carryPicks,
  type Participant,
  personParticipant,
} from '../model/participant-search';
import {
  channelChoiceCards,
  channelIdProblem,
  normalizedChannelId,
  optionsForBridge,
} from '../model/room-channel-choices';
import {
  CreateRequestIds,
  canCreate,
  DEFAULT_ROOM_OPTIONS,
  dropsStartingAgent,
  type RoomCreateOptions,
  type RoomCreateRequest,
  roomCreateRequest,
  roomOptionsReady,
  startingAgentResolution,
} from '../model/room-creation';
import { Button } from '../primitives/button';
import { DialogContentArea, DialogFooter, DialogHeader, DialogTitle } from '../primitives/dialog';
import { Field, FieldLabel } from '../primitives/field';
import { Input } from '../primitives/input';
import { Textarea } from '../primitives/textarea';
import { CreateRoomOptions, type CreateRoomQuery, RoomChannelField } from './create-room-options';
import { type MessagingAppSelectorProps, NO_MESSAGING_APP } from './messaging-app-selector';
import {
  type FixedParticipant,
  ParticipantPicker,
  type ParticipantMarks,
} from './participant-picker';
import { RoomNameInput } from './room-name-input';

export type CreateRoomBridge = Pick<
  RemoteBridge,
  | 'id'
  | 'type'
  | 'displayName'
  | 'status'
  | 'canCreateChannels'
  | 'channelIdsRefused'
  | 'privateChannels'
  | 'privateChannelNeedsLinkedAccount'
  | 'publicChannelAddsCreator'
>;

/** Someone Switch knows on a messaging app. */
export type CreateRoomBridgePerson = {
  username: string;
  externalUserId: string;
  linkedUserIds: string[];
  linkedName: string | null;
};

/** An account the signed-in person linked on a messaging app, by the name it is shown under. */
export type CreateRoomIdentity = {
  bridgeId: string;
  externalUserId: string;
  name: string;
  verified: boolean;
};

/** How making a room on a messaging app went: made, or why not. */
export type CreateRoomOutcome =
  | { kind: 'created'; room: { id: string } }
  | { kind: 'unauthenticated' }
  | { kind: 'bridge-unavailable' | 'invalid' | 'error'; message?: string };

/** The agents a new room can be made with, as the app reads them. */
export type CreateRoomAgents = {
  /** The agents offered for the room being made, as participants. */
  offered: Participant[];
  /** Every agent the workspace lists, to name the one the room is made from. */
  all: { id: string; name: string }[];
  loading: boolean;
  /** Read in full, so an agent not offered is known not to be. */
  loaded: boolean;
  /** Why the agents could not be read; null when they could. */
  error: unknown;
  /** Why the agents the person may invite could not be worked out; null when they could. */
  inviteError: unknown;
};

/**
 * What the app showing the dialog provides: where the room is made, what it
 * can be made with, how it is made and opened, and the pieces of the app's own
 * UI it draws. Hooks are called on every render, in order, like any hook.
 */
export type CreateRoomHost = {
  /** The server the room is made on; empty when none is chosen. */
  serverId: string;
  /** Null while there is no workspace to make the room in. */
  workspaceId: string | null;
  /** Whether a server is chosen at all. */
  hasServer: boolean;
  myUserId: string | null;
  /** Only an admin files a room in a group. */
  administers: boolean;
  /** Whether rooms on no messaging app may be made (the server's group chats). */
  consoleOffered: boolean;
  /** The app as the person knows it, in "… can’t move a room to another channel later". */
  appName: string;
  bridges: CreateRoomQuery<CreateRoomBridge[]>;
  /** The workspace's people who can be added, the signed-in person left out. */
  roster: CreateRoomQuery<{ userId: string; name: string; email: string | null }[]>;
  /** The person's linked accounts; null while unknown. */
  identities: CreateRoomIdentity[] | null;
  groups: CreateRoomQuery<{ id: string; name: string }[]>;
  /** The agents offered for a room on a messaging app (`bridged`) or on none, filed under `groupId`. */
  useAgents: (bridged: boolean, groupId: string | null) => CreateRoomAgents;
  useBridgePeople: (bridgeId: string | null) => CreateRoomQuery<CreateRoomBridgePerson[]>;
  fetchBridgePeople: (bridgeId: string) => Promise<CreateRoomBridgePerson[]>;
  /** Makes a room on no messaging app, shows it, and answers its id. */
  createChat: (params: Extract<RoomCreateRequest, { kind: 'chat' }>['params']) => Promise<string>;
  /** Makes a room on a messaging app and, once made, shows it. */
  createRoom: (
    params: Extract<RoomCreateRequest, { kind: 'room' }>['params']
  ) => Promise<CreateRoomOutcome>;
  /** Keeps the dialog open while a create is under way. */
  setCloseGuard: (active: boolean) => void;
  marks: ParticipantMarks;
  MessagingAppSelector: ComponentType<MessagingAppSelectorProps>;
  ConfirmButton: ComponentType<{ onClick: () => void; disabled: boolean; children: ReactNode }>;
};

/**
 * A new room: its name, then who is in it — agents and people found in one
 * field — and, when the server has a messaging app that can make channels,
 * where it lives. The app's own place is the default and needs no messaging
 * app. Either way it can be made with its description, instructions, group
 * and access; only a room on a messaging app has a channel to choose.
 */
export const CreateRoomDialog = observer(function CreateRoomDialog({
  host,
  startingAgentId,
  onSuccess,
  onClose,
}: {
  host: CreateRoomHost;
  /** An agent to start the room with, already picked: the room is made from its page. */
  startingAgentId?: string;
  onSuccess: (result: { roomId: string }) => void;
  onClose: () => void;
}) {
  const {
    serverId,
    workspaceId,
    identities,
    myUserId,
    setCloseGuard,
    administers,
    consoleOffered,
    MessagingAppSelector,
    ConfirmButton,
  } = host;
  const bridgesQuery = host.bridges;
  const rosterQuery = host.roster;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [where, setWhere] = useState(NO_MESSAGING_APP);
  const [options, setOptions] = useState<RoomCreateOptions>(DEFAULT_ROOM_OPTIONS);
  const [picked, setPicked] = useState<Participant[]>([]);
  // Who a change of messaging app left out, as no one of theirs is known there.
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [switchingApp, setSwitchingApp] = useState(false);
  // Which change of app is the latest: an earlier one finishing after it is dropped.
  const appChange = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [requestIds] = useState(() => new CreateRequestIds(() => crypto.randomUUID()));

  // A group's rules can admit an agent there and nowhere else, so the agents
  // offered follow the group chosen.
  const candidateGroupId = administers ? options.groupId : null;

  // Only a running bridge allowed to create channels can back a new room.
  const bridges = (bridgesQuery.data ?? []).filter(
    (b) => b.status === 'active' && b.canCreateChannels
  );
  // Without the server's group_chats flag there are no rooms on no app: a room is a bridged one.
  const selectedBridge =
    bridges.find((b) => b.id === where) ?? (consoleOffered ? null : (bridges[0] ?? null));
  const nowhere = !consoleOffered && selectedBridge === null && !bridgesQuery.isLoading;
  // A channel, and above all a typed id, belongs to the app it was chosen for:
  // when the app the room would go to changes, however it changed, the choice
  // starts again from the default. Picking the app already shown keeps it.
  const resolvedBridgeId = selectedBridge?.id ?? null;
  const channelBridgeId = useRef(resolvedBridgeId);
  // Whether the person picked a channel on this app themselves.
  const [channelChosen, setChannelChosen] = useState(false);
  useEffect(() => {
    if (channelBridgeId.current === resolvedBridgeId) return;
    channelBridgeId.current = resolvedBridgeId;
    setOptions((now) => ({ ...now, channel: DEFAULT_ROOM_OPTIONS.channel }));
    setChannelChosen(false);
  }, [resolvedBridgeId]);
  // Whether the person has a confirmed account linked on the chosen app; null
  // while unknown or with no app.
  const linkedHere =
    selectedBridge === null || identities === null
      ? null
      : identities.some((each) => each.bridgeId === selectedBridge.id && each.verified);
  // A new room is private, but a private channel needs its creator's linked
  // account. Without one, and with no channel picked, a new public channel is
  // offered instead, saying how to make it private; picking private still asks
  // for it, and the server says why it needs the account.
  const chosenOptions: RoomCreateOptions =
    !channelChosen &&
    linkedHere === false &&
    options.channel.kind === 'new' &&
    options.channel.private
      ? { ...options, channel: { kind: 'new', private: false } }
      : options;

  const peopleQuery = host.useBridgePeople(resolvedBridgeId);
  const agents = host.useAgents(selectedBridge !== null, candidateGroupId);
  // A new channel on an app is made with its creator in it, so they are shown
  // in it, through the account of theirs it will use, rather than offered. A
  // private one says plainly when they have none, as it would be refused; a
  // public one is made without them then, and on an app where joining a
  // public channel means more (Teams), so it shows nobody.
  const offeredChannel = optionsForBridge(chosenOptions, selectedBridge).channel;
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
              ? myAccount.name
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
    : (rosterQuery.data ?? []).map(personParticipant);
  const candidates: Participant[] = [...agents.offered, ...people];
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
  const bridgeOptions = optionsForBridge(chosenOptions, selectedBridge);
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
    failed: agents.error !== null,
    loaded: agents.loaded,
  });
  const startingAgentName =
    agents.all.find((agent) => agent.id === startingAgentId)?.name ?? 'This agent';
  const canSubmit =
    workspaceId !== null &&
    startingAgentState !== 'pending' &&
    !nowhere &&
    !switchingApp &&
    canCreate({ name }) &&
    (selectedBridge === null ||
      roomOptionsReady(roomOptions, selectedBridge.type, channelIdProblem)) &&
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
          next === NO_MESSAGING_APP
            ? (rosterQuery.data ?? []).map(personParticipant)
            : (await host.fetchBridgePeople(next)).map(bridgePersonParticipant);
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
      const request = roomCreateRequest(
        {
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
        },
        normalizedChannelId
      );
      if (request.kind === 'chat') {
        const roomId = await host.createChat(request.params);
        requestIds.succeeded();
        onSuccess({ roomId });
        return;
      }
      const result = await host.createRoom(request.params);

      if (result.kind !== 'created') {
        setError(messageFor(result));
        return;
      }

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

  if (nowhere) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>New room</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="pt-0">
          <div className="flex w-full flex-col gap-2 text-sm">
            <p>This server can’t create rooms yet.</p>
            <p className="text-foreground-muted">
              Group chats need a newer Switch server, or connect a messaging app that can create
              channels. You can still start a 1-1 chat from an agent’s page.
            </p>
            {bridgesQuery.isError && (
              <p className="text-xs text-destructive">
                {failureText(bridgesQuery.error, 'Could not load messaging apps.')}
              </p>
            )}
          </div>
        </DialogContentArea>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>New room</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <div className="flex w-full flex-col gap-5">
          {!host.hasServer && (
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
                agents.loading || (selectedBridge ? peopleQuery.isLoading : rosterQuery.isLoading)
              }
              fixed={fixed}
              marks={host.marks}
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
            {agents.error !== null && (
              <p className="text-xs text-destructive">
                {failureText(agents.error, 'Could not load the agents.')}
              </p>
            )}
            {agents.inviteError !== null && (
              <p className="text-xs text-destructive">
                {failureText(agents.inviteError, 'Could not work out which agents you can invite.')}
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
            <>
              <RoomChannelField
                bridge={selectedBridge}
                linkedHere={linkedHere}
                appName={host.appName}
                value={roomOptions}
                onChange={(next) => {
                  setOptions(next);
                  setChannelChosen(true);
                  setError(null);
                }}
              />
              {linkedHere === false &&
                offeredChannel.kind === 'new' &&
                !offeredChannel.private &&
                channelChoiceCards(selectedBridge, linkedHere).some(
                  (card) => card.value === 'private'
                ) && (
                  <p data-testid="link-to-make-private" className="text-xs text-foreground-muted">
                    Link your account to make it private, in Settings → Messaging apps.
                  </p>
                )}
            </>
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
                groups={host.groups}
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

          {startingAgentState === 'failed' && (
            <p className="text-xs text-destructive">
              {startingAgentName} can&apos;t be added to the new room:{' '}
              {failureText(agents.error, 'the agents could not be loaded.')}
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

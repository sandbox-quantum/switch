import type { NewRoomChannel, RoomAccess } from '@shared/core/switch-servers/switch-servers';
import { channelIdProblem, normalizedChannelId } from './room-channel-choices';

/** What the New room dialog asks the server for: a Switch Console chat when no messaging app is chosen, else a room bridged to the chosen one. */
export type RoomCreateRequest =
  | {
      kind: 'chat';
      params: {
        serverId: string;
        name: string;
        agentIds: string[];
        memberUserIds: string[];
        requestId: string;
        greeting: null;
        /** A room made here is a group even with one agent and nobody else. */
        kind: 'group';
      };
    }
  | {
      kind: 'room';
      params: {
        workspaceId: string;
        name: string;
        description: string;
        instructions: string | undefined;
        bridgeId: string;
        agentIds: string[];
        channel: NewRoomChannel;
        groupId: string | null;
        /** Absent leaves the server's default. */
        access?: RoomAccess;
      };
    };

/** The New room dialog's More options, for a room on a messaging app. */
export type RoomCreateOptions = {
  channel: NewRoomChannel;
  groupId: string | null;
  /** Null leaves the server's default. */
  access: RoomAccess | null;
};

export const DEFAULT_ROOM_OPTIONS: RoomCreateOptions = {
  channel: { kind: 'new', private: false },
  groupId: null,
  access: null,
};

export function roomCreateRequest(form: {
  serverId: string;
  workspaceId: string;
  /** Null for Switch Console. */
  bridgeId: string | null;
  /** The chosen app's platform, so an existing channel's id is sent as it writes it. */
  bridgeType?: string;
  name: string;
  description: string;
  instructions: string;
  agentIds: string[];
  /** The people to add; a bridged room is created without them. */
  memberUserIds: string[];
  requestId: string;
  /** A bridged room's More options; a Switch Console room has none. */
  options?: RoomCreateOptions;
}): RoomCreateRequest {
  const name = form.name.trim();
  const agentIds = [...new Set(form.agentIds)];
  if (form.bridgeId === null)
    return {
      kind: 'chat',
      params: {
        serverId: form.serverId,
        name,
        agentIds,
        memberUserIds: [...new Set(form.memberUserIds)],
        requestId: form.requestId,
        greeting: null,
        kind: 'group',
      },
    };
  return {
    kind: 'room',
    params: {
      workspaceId: form.workspaceId,
      name,
      description: form.description.trim(),
      instructions: form.instructions.trim() || undefined,
      bridgeId: form.bridgeId,
      agentIds,
      ...roomOptionsParams(form.options ?? DEFAULT_ROOM_OPTIONS, form.bridgeType ?? ''),
    },
  };
}

function roomOptionsParams(options: RoomCreateOptions, bridgeType: string) {
  const channel: NewRoomChannel =
    options.channel.kind === 'existing'
      ? {
          kind: 'existing',
          externalChannelId: normalizedChannelId(bridgeType, options.channel.externalChannelId),
        }
      : options.channel;
  return {
    channel,
    groupId: options.groupId,
    ...(options.access ? { access: options.access } : {}),
  };
}

/** Whether the options can be sent: an existing channel has to be named, by an id of its app's shape. */
export function roomOptionsReady(options: RoomCreateOptions, bridgeType: string): boolean {
  if (options.channel.kind !== 'existing') return true;
  const id = options.channel.externalChannelId;
  return id.trim() !== '' && channelIdProblem(bridgeType, id) === null;
}

/** A room needs only a name; a bridged room's description is optional, as its channel topic is. */
export function canCreate(form: { name: string }) {
  return form.name.trim() !== '';
}

/**
 * One request id per form, as the direct-chat starter keeps one per agent: a
 * retry of an unchanged form after an answer that never arrived resumes the
 * chat it may already have made instead of making a second; a changed form,
 * or a create that succeeded, takes a new one.
 */
export class CreateRequestIds {
  private key: string | null = null;
  private id = '';

  constructor(private readonly newId: () => string) {}

  for(form: {
    bridgeId: string | null;
    name: string;
    agentIds: string[];
    memberUserIds: string[];
  }): string {
    const key = JSON.stringify([
      form.bridgeId,
      form.name.trim(),
      form.agentIds,
      form.memberUserIds,
    ]);
    if (key !== this.key) {
      this.key = key;
      this.id = this.newId();
    }
    return this.id;
  }

  succeeded(): void {
    this.key = null;
  }
}

/**
 * Whether a change to the picks removes the starting agent the dialog shows: only
 * that leaves it out. Other edits, made before or after it resolves, keep it.
 */
export function dropsStartingAgent(
  shown: { kind: string; id: string } | null,
  next: { kind: string; id: string }[]
): boolean {
  return shown !== null && !next.some((each) => each.kind === shown.kind && each.id === shown.id);
}

/**
 * Where the agent a room is made from stands: no such agent or already picked
 * (`resolved`), the agents still loading (`pending`, when Create waits), or it
 * cannot be picked because the agents failed to load or it is not among them.
 */
export function startingAgentResolution(state: {
  startingAgentId: string | undefined;
  applied: boolean;
  failed: boolean;
  loaded: boolean;
}): 'resolved' | 'pending' | 'failed' | 'unavailable' {
  if (state.startingAgentId === undefined || state.applied) return 'resolved';
  if (state.failed) return 'failed';
  return state.loaded ? 'unavailable' : 'pending';
}

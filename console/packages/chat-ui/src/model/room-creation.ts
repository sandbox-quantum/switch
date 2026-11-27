/**
 * Room creation request building and validation. Pure logic that works
 * identically in Console and the gateway.
 */

import type { NewRoomChannel, RoomAccess } from '../contracts/switch-servers';

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
        kind: 'group';
        description: string;
        instructions: string | undefined;
        groupId: string | null;
        access: RoomAccess | null;
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
        userNames: string[];
        channel: NewRoomChannel;
        groupId: string | null;
        access: RoomAccess | null;
      };
    };

export type RoomCreateOptions = {
  channel: NewRoomChannel;
  groupId: string | null;
  access: RoomAccess | null;
};

export const DEFAULT_ROOM_OPTIONS: RoomCreateOptions = {
  channel: { kind: 'new', private: true },
  groupId: null,
  access: null,
};

export function roomCreateRequest(
  form: {
    serverId: string;
    workspaceId: string;
    bridgeId: string | null;
    bridgeType: string | null;
    name: string;
    description: string;
    instructions: string;
    agentIds: string[];
    memberUserIds: string[];
    userNames: string[];
    requestId: string;
    options: RoomCreateOptions;
  },
  normalizeChannelId: (bridgeType: string, channelId: string) => string
): RoomCreateRequest {
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
        description: form.description.trim(),
        instructions: form.instructions.trim() || undefined,
        groupId: form.options.groupId,
        access: form.options.access,
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
      userNames: [...new Set(form.userNames)],
      ...roomOptionsParams(form.options, form.bridgeType ?? '', normalizeChannelId),
    },
  };
}

function roomOptionsParams(
  options: RoomCreateOptions,
  bridgeType: string,
  normalizeChannelId: (bridgeType: string, channelId: string) => string
) {
  const channel: NewRoomChannel =
    options.channel.kind === 'existing'
      ? {
          kind: 'existing',
          externalChannelId: normalizeChannelId(bridgeType, options.channel.externalChannelId),
        }
      : options.channel;
  return {
    channel,
    groupId: options.groupId,
    access: null,
  };
}

export function roomOptionsReady(
  options: RoomCreateOptions,
  bridgeType: string,
  channelIdProblem: (bridgeType: string, channelId: string) => string | null
): boolean {
  if (options.channel.kind !== 'existing') return true;
  const id = options.channel.externalChannelId;
  return id.trim() !== '' && channelIdProblem(bridgeType, id) === null;
}

export function canCreate(form: { name: string }) {
  return form.name.trim() !== '';
}

export class CreateRequestIds {
  private key: string | null = null;
  private id = '';

  constructor(private readonly newId: () => string) {}

  for(form: {
    bridgeId: string | null;
    name: string;
    agentIds: string[];
    memberUserIds: string[];
    settings?: unknown;
  }): string {
    const key = JSON.stringify([
      form.bridgeId,
      form.name.trim(),
      form.agentIds,
      form.memberUserIds,
      form.settings ?? null,
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

export function dropsStartingAgent(
  shown: { kind: string; id: string } | null,
  next: { kind: string; id: string }[]
): boolean {
  return shown !== null && !next.some((each) => each.kind === shown.kind && each.id === shown.id);
}

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

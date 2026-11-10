import { describe, expect, it } from 'vitest';
import {
  CreateRequestIds,
  canCreate,
  dropsStartingAgent,
  DEFAULT_ROOM_OPTIONS,
  roomCreateRequest,
  roomOptionsReady,
  startingAgentResolution,
} from './room-create-request';

const form = {
  serverId: 's',
  workspaceId: 'w',
  name: ' Ship review ',
  description: ' Reviews ',
  instructions: '',
  agentIds: ['a1'],
  memberUserIds: ['u2'],
  userNames: [],
  requestId: 'req',
  bridgeType: null,
  options: DEFAULT_ROOM_OPTIONS,
};

describe('roomCreateRequest', () => {
  it('creates a Switch Console group, people included, even with one agent', () => {
    expect(roomCreateRequest({ ...form, bridgeId: null })).toEqual({
      kind: 'chat',
      params: {
        serverId: 's',
        name: 'Ship review',
        agentIds: ['a1'],
        memberUserIds: ['u2'],
        requestId: 'req',
        greeting: null,
        kind: 'group',
        description: 'Reviews',
        instructions: undefined,
        groupId: null,
        access: null,
      },
    });
  });

  it('gives a Switch Console chat its group and access, but no channel', () => {
    const request = roomCreateRequest({
      ...form,
      bridgeId: null,
      options: {
        channel: { kind: 'new', private: true },
        groupId: 'g1',
        access: 'read_only',
      },
    });
    expect(request.kind).toBe('chat');
    expect(request.params).toMatchObject({ groupId: 'g1', access: 'read_only' });
    expect(request.params).not.toHaveProperty('channel');
  });

  it('never sends an id twice', () => {
    const request = roomCreateRequest({
      ...form,
      bridgeId: null,
      agentIds: ['a1', 'a1'],
      memberUserIds: ['u2', 'u2'],
    });
    expect(request.params.agentIds).toEqual(['a1']);
    expect(request.kind === 'chat' && request.params.memberUserIds).toEqual(['u2']);
  });

  it('creates a bridged room as before when an app is chosen', () => {
    expect(roomCreateRequest({ ...form, bridgeId: 'b1', agentIds: [] })).toEqual({
      kind: 'room',
      params: {
        workspaceId: 'w',
        name: 'Ship review',
        description: 'Reviews',
        instructions: undefined,
        bridgeId: 'b1',
        agentIds: [],
        userNames: [],
        // A new public channel and the server's default access, as before.
        channel: { kind: 'new', private: false },
        groupId: null,
        access: null,
      },
    });
  });

  it('gives a bridged room its people by their username on the app, once each', () => {
    const request = roomCreateRequest({
      ...form,
      bridgeId: 'b1',
      userNames: ['bob', 'carol', 'bob'],
    });
    expect(request.kind === 'room' && request.params.userNames).toEqual(['bob', 'carol']);
  });

  it('carries the More options: a private channel, a group and an access choice', () => {
    const request = roomCreateRequest({
      ...form,
      bridgeId: 'b1',
      options: { channel: { kind: 'new', private: true }, groupId: 'g1', access: 'read_only' },
    });
    expect(request.kind === 'room' && request.params).toMatchObject({
      channel: { kind: 'new', private: true },
      groupId: 'g1',
      access: 'read_only',
    });
  });

  it('binds an existing channel by its id, written as its app writes it', () => {
    const request = roomCreateRequest({
      ...form,
      bridgeId: 'b1',
      bridgeType: 'slack',
      options: {
        channel: { kind: 'existing', externalChannelId: ' c123 ' },
        groupId: null,
        access: null,
      },
    });
    expect(request.kind === 'room' && request.params.channel).toEqual({
      kind: 'existing',
      externalChannelId: 'C123',
    });
  });
});

describe('roomOptionsReady', () => {
  it('needs a channel id only when binding an existing channel', () => {
    expect(roomOptionsReady(DEFAULT_ROOM_OPTIONS, 'slack')).toBe(true);
    const existing = (id: string) => ({
      ...DEFAULT_ROOM_OPTIONS,
      channel: { kind: 'existing' as const, externalChannelId: id },
    });
    expect(roomOptionsReady(existing('  '), 'slack')).toBe(false);
    expect(roomOptionsReady(existing('C0123ABCD'), 'slack')).toBe(true);
    // An id not of the app's shape is held back, with the reason shown beside it.
    expect(roomOptionsReady(existing('general'), 'slack')).toBe(false);
  });
});

describe('canCreate', () => {
  it('asks only for a name, a bridged room included', () => {
    expect(canCreate({ name: 'x' })).toBe(true);
    expect(canCreate({ name: ' ' })).toBe(false);
  });
});

describe('CreateRequestIds', () => {
  it('reuses the id for an unchanged form and takes a new one on a change or a success', () => {
    let n = 0;
    const ids = new CreateRequestIds(() => `id-${++n}`);
    const chatForm = { bridgeId: null, name: 'Ship review', agentIds: ['a1'], memberUserIds: [] };
    const first = ids.for(chatForm);
    expect(ids.for({ ...chatForm, name: ' Ship review ' })).toBe(first);
    expect(ids.for({ ...chatForm, name: 'Ship reviews' })).toBe('id-2');
    expect(ids.for({ ...chatForm, name: 'Ship reviews', memberUserIds: ['u2'] })).toBe('id-3');
    expect(ids.for({ ...chatForm, name: 'Ship reviews', memberUserIds: ['u2'] })).toBe('id-3');
    ids.succeeded();
    expect(ids.for({ ...chatForm, name: 'Ship reviews', memberUserIds: ['u2'] })).toBe('id-4');
  });

  it('takes a new id when the room’s settings change, as the server refuses them under the old one', () => {
    let n = 0;
    const ids = new CreateRequestIds(() => `id-${++n}`);
    const chatForm = { bridgeId: null, name: 'r', agentIds: [], memberUserIds: [] };
    const first = ids.for({ ...chatForm, settings: ['A'] });
    expect(ids.for({ ...chatForm, settings: ['A'] })).toBe(first);
    expect(ids.for({ ...chatForm, settings: ['B'] })).toBe('id-2');
  });
});

describe('startingAgentResolution', () => {
  const base = { startingAgentId: 'a1', applied: false, failed: false, loaded: false };

  it('keeps Create waiting while the agents load, then is resolved once the agent is picked', () => {
    expect(startingAgentResolution(base)).toBe('pending');
    expect(startingAgentResolution({ ...base, loaded: true, applied: true })).toBe('resolved');
    expect(startingAgentResolution({ ...base, startingAgentId: undefined })).toBe('resolved');
  });

  it('says why the agent is left out when the agents fail to load or it is not among them', () => {
    expect(startingAgentResolution({ ...base, failed: true })).toBe('failed');
    expect(startingAgentResolution({ ...base, loaded: true })).toBe('unavailable');
  });
});

describe('dropsStartingAgent', () => {
  const agent = { kind: 'agent', id: 'a1' };
  const person = { kind: 'person', id: 'u2' };

  it('keeps the starting agent through edits made while it loads, then applies it', () => {
    // Picking a person, or switching app, before the agent resolves: nothing is shown yet.
    expect(dropsStartingAgent(null, [person])).toBe(false);
    expect(dropsStartingAgent(null, [])).toBe(false);
    const waiting = { startingAgentId: 'a1', applied: false, failed: false, loaded: false };
    expect(startingAgentResolution(waiting)).toBe('pending');
    // Resolved: its chip is shown, so it is applied.
    expect(startingAgentResolution({ ...waiting, loaded: true, applied: true })).toBe('resolved');
  });

  it('keeps it when other picks change or a bridged app keeps only agents', () => {
    expect(dropsStartingAgent(agent, [agent, person])).toBe(false);
    expect(dropsStartingAgent(agent, [agent])).toBe(false);
  });

  it('leaves it out only when its chip is removed', () => {
    expect(dropsStartingAgent(agent, [person])).toBe(true);
    expect(dropsStartingAgent(agent, [{ kind: 'person', id: 'a1' }])).toBe(true);
  });
});

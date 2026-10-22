import { describe, expect, it } from 'vitest';
import { CreateRequestIds, canCreate, roomCreateRequest } from './room-create-request';

const form = {
  serverId: 's',
  workspaceId: 'w',
  name: ' Ship review ',
  description: ' Reviews ',
  instructions: '',
  agentIds: ['a1'],
  memberUserIds: ['u2'],
  requestId: 'req',
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
      },
    });
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
      },
    });
  });
});

describe('canCreate', () => {
  it('asks a chat only for a name, a bridged room for a description too', () => {
    expect(canCreate({ bridgeId: null, name: 'x', description: '' })).toBe(true);
    expect(canCreate({ bridgeId: 'b1', name: 'x', description: '' })).toBe(false);
    expect(canCreate({ bridgeId: 'b1', name: 'x', description: 'd' })).toBe(true);
    expect(canCreate({ bridgeId: null, name: ' ', description: 'd' })).toBe(false);
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
});

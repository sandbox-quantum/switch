import { describe, expect, it } from 'vitest';
import {
  CreateRequestIds,
  canCreate,
  dropsStartingAgent,
  roomCreateRequest,
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

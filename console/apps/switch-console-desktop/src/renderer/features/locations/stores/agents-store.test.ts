import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@shared/core/agents/agents';
import { agentsStore } from './agents-store';

vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));

function agent(locationId: string, serverId: string | null, name: string): Agent {
  return { locationId, serverId, name } as Agent;
}

/**
 * The premise these cover: a directory can hold agents registered against
 * several Switch servers at once, so "which server does this directory belong
 * to" has no single answer and must not be asked (CHOO-2044).
 */
describe('AgentsStore server scoping', () => {
  afterEach(() => {
    agentsStore.byLocation.clear();
    agentsStore.optimisticServerByLocation.clear();
  });

  it('returns only the agents belonging to the given server', () => {
    agentsStore.byLocation.set('shared', [
      agent('shared', 'server-1', 'a'),
      agent('shared', 'server-2', 'b'),
      agent('shared', null, 'unlinked'),
    ]);

    expect(agentsStore.agentsOnServerAtLocation('shared', 'server-1').map((a) => a.name)).toEqual([
      'a',
    ]);
    expect(agentsStore.agentsOnServerAtLocation('shared', 'server-2').map((a) => a.name)).toEqual([
      'b',
    ]);
    expect(agentsStore.agentsOnServerAtLocation('shared', 'server-3')).toEqual([]);
  });

  it('reports a shared directory as present on every server it has agents on', () => {
    agentsStore.byLocation.set('shared', [
      agent('shared', 'server-1', 'a'),
      agent('shared', 'server-2', 'b'),
    ]);

    expect(agentsStore.locationHasAgentsOnServer('shared', 'server-1')).toBe(true);
    expect(agentsStore.locationHasAgentsOnServer('shared', 'server-2')).toBe(true);
    expect(agentsStore.locationHasAgentsOnServer('shared', 'server-3')).toBe(false);
    expect(agentsStore.serverIdsForLocation('shared').sort()).toEqual(['server-1', 'server-2']);
  });

  it('keeps a just-created location in scope before its agent row lands', () => {
    agentsStore.noteLocationServer('fresh', 'server-1');

    expect(agentsStore.locationHasAgentsOnServer('fresh', 'server-1')).toBe(true);
    expect(agentsStore.locationHasAgentsOnServer('fresh', 'server-2')).toBe(false);
    expect(agentsStore.serverIdsForLocation('fresh')).toEqual(['server-1']);
  });

  it('ignores the optimistic note once real agents exist', () => {
    agentsStore.noteLocationServer('shared', 'server-9');
    agentsStore.byLocation.set('shared', [agent('shared', 'server-1', 'a')]);

    expect(agentsStore.serverIdsForLocation('shared')).toEqual(['server-1']);
    expect(agentsStore.locationHasAgentsOnServer('shared', 'server-9')).toBe(false);
  });

  it('treats a location with only unlinked agents as on no server', () => {
    agentsStore.byLocation.set('orphan', [agent('orphan', null, 'a')]);

    expect(agentsStore.serverIdsForLocation('orphan')).toEqual([]);
    expect(agentsStore.locationHasAgentsOnServer('orphan', 'server-1')).toBe(false);
  });
});

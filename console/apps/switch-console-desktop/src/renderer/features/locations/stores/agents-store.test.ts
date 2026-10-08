import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@shared/core/agents/agents';
import { agentsStore } from './agents-store';

vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));

function agent(locationId: string, workspaceId: string | null, name: string): Agent {
  return { locationId, workspaceId, name } as Agent;
}

/**
 * The premise these cover: a directory can hold agents registered against
 * several workspaces at once, so "which workspace does this directory belong
 * to" has no single answer and must not be asked (CHOO-2044).
 */
describe('AgentsStore workspace scoping', () => {
  afterEach(() => {
    agentsStore.byLocation.clear();
    agentsStore.optimisticWorkspaceByLocation.clear();
  });

  it('returns only the agents belonging to the given workspace', () => {
    agentsStore.byLocation.set('shared', [
      agent('shared', 'ws-1', 'a'),
      agent('shared', 'ws-2', 'b'),
      agent('shared', null, 'unlinked'),
    ]);

    expect(agentsStore.agentsInWorkspaceAtLocation('shared', 'ws-1').map((a) => a.name)).toEqual([
      'a',
    ]);
    expect(agentsStore.agentsInWorkspaceAtLocation('shared', 'ws-2').map((a) => a.name)).toEqual([
      'b',
    ]);
    expect(agentsStore.agentsInWorkspaceAtLocation('shared', 'ws-3')).toEqual([]);
  });

  /**
   * Two workspaces on the same server are still two scopes: the sidebar shows
   * one of them at a time, so a directory present in both must answer for each
   * separately rather than for the server they share.
   */
  it('separates two workspaces that live on the same server', () => {
    agentsStore.byLocation.set('shared', [
      agent('shared', 'ws-1', 'a'),
      agent('shared', 'ws-2', 'b'),
    ]);

    expect(agentsStore.locationHasAgentsInWorkspace('shared', 'ws-1')).toBe(true);
    expect(agentsStore.locationHasAgentsInWorkspace('shared', 'ws-2')).toBe(true);
    expect(agentsStore.locationHasAgentsInWorkspace('shared', 'ws-3')).toBe(false);
    expect(agentsStore.workspaceIdsForLocation('shared').sort()).toEqual(['ws-1', 'ws-2']);
  });

  it('keeps a just-created location in scope before its agent row lands', () => {
    agentsStore.noteLocationWorkspace('fresh', 'ws-1');

    expect(agentsStore.locationHasAgentsInWorkspace('fresh', 'ws-1')).toBe(true);
    expect(agentsStore.locationHasAgentsInWorkspace('fresh', 'ws-2')).toBe(false);
    expect(agentsStore.workspaceIdsForLocation('fresh')).toEqual(['ws-1']);
  });

  it('ignores the optimistic note once real agents exist', () => {
    agentsStore.noteLocationWorkspace('shared', 'ws-9');
    agentsStore.byLocation.set('shared', [agent('shared', 'ws-1', 'a')]);

    expect(agentsStore.workspaceIdsForLocation('shared')).toEqual(['ws-1']);
    expect(agentsStore.locationHasAgentsInWorkspace('shared', 'ws-9')).toBe(false);
  });

  it('treats a location with only unlinked agents as in no workspace', () => {
    agentsStore.byLocation.set('orphan', [agent('orphan', null, 'a')]);

    expect(agentsStore.workspaceIdsForLocation('orphan')).toEqual([]);
    expect(agentsStore.locationHasAgentsInWorkspace('orphan', 'ws-1')).toBe(false);
  });
});

/**
 * Which agent an agent page is about (CHOO-2173).
 *
 * The route identifies one by location *and* name. Creating an agent used to
 * navigate with the location alone, and with nothing to resolve, every surface
 * on the page fell back to the directory's name — so a new agent opened under
 * the folder's name and an avatar generated from it.
 */
describe('resolving the agent a location route is about', () => {
  afterEach(() => {
    agentsStore.byLocation.clear();
    agentsStore.optimisticWorkspaceByLocation.clear();
  });

  it('picks the named agent out of a shared directory', () => {
    agentsStore.byLocation.set('dir', [
      agent('dir', 'ws-1', 'charlie'),
      agent('dir', 'ws-1', 'delta'),
    ]);

    expect(agentsStore.agentAtLocation('dir', 'charlie')?.name).toBe('charlie');
    expect(agentsStore.agentAtLocation('dir', 'delta')?.name).toBe('delta');
  });

  it('resolves an unnamed route when the directory holds exactly one agent', () => {
    // Nothing to choose between, so there is nothing to get wrong.
    agentsStore.byLocation.set('dir', [agent('dir', 'ws-1', 'charlie')]);

    expect(agentsStore.agentAtLocation('dir', undefined)?.name).toBe('charlie');
  });

  it('refuses to guess between several agents', () => {
    agentsStore.byLocation.set('dir', [
      agent('dir', 'ws-1', 'charlie'),
      agent('dir', 'ws-1', 'delta'),
    ]);

    expect(agentsStore.agentAtLocation('dir', undefined)).toBeNull();
  });

  it('is null for a name that is not there, rather than the first agent', () => {
    agentsStore.byLocation.set('dir', [agent('dir', 'ws-1', 'charlie')]);

    expect(agentsStore.agentAtLocation('dir', 'nobody')).toBeNull();
  });

  it('is null for a directory with no agents at all', () => {
    expect(agentsStore.agentAtLocation('empty', undefined)).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));
vi.mock('@renderer/features/switch-servers/server-availability', () => ({
  serverAvailability: () => 'available',
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {},
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {},
}));
const moved = vi.hoisted(() => new Set<string>());
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { isMoved: (agentId: string) => moved.has(agentId) },
}));

const { withoutManaged } = await import('./use-managed-agents');

const managed = (agentId: string) => ({ agentId }) as ManagedAgentView;

describe('withoutManaged', () => {
  it('drops the Console rows of agents the server manages, keeping the rest', () => {
    const rows = [
      { id: 'moved', switchAgentId: 'sw-moved' },
      { id: 'local', switchAgentId: 'sw-local' },
      { id: 'unlinked', switchAgentId: null },
    ];
    expect(withoutManaged(rows, [managed('sw-moved')]).map((row) => row.id)).toEqual([
      'local',
      'unlinked',
    ]);
  });

  it('keeps every row while the server list is not in yet', () => {
    const rows = [{ id: 'moved', switchAgentId: 'sw-moved' }];
    expect(withoutManaged(rows, undefined)).toEqual(rows);
  });

  it('never shows a moved agent’s old row, whatever the server lists', () => {
    moved.add('moved');
    try {
      const rows = [
        { id: 'moved', switchAgentId: 'sw-moved' },
        { id: 'local', switchAgentId: 'sw-local' },
      ];
      // Deleted on the server, another account, or no access: the list lacks it.
      expect(withoutManaged(rows, []).map((row) => row.id)).toEqual(['local']);
      expect(withoutManaged(rows, null).map((row) => row.id)).toEqual(['local']);
      expect(withoutManaged(rows, undefined).map((row) => row.id)).toEqual(['local']);
    } finally {
      moved.clear();
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {},
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {},
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
});

import { expect, it } from 'vitest';
import { groupDiscoveryFailures } from './group-discovery-failures';

const unreachable = 'Session discovery failed: Could not reach http://localhost:5173';

// A server going down failed discovery for every agent on it, and the sidebar
// rendered one identical banner and retry button per agent.
it('reports one banner for agents that failed for the same reason', () => {
  const grouped = groupDiscoveryFailures(
    ['a', 'b', 'c', 'd'].map((agentId) => ({ agentId, message: unreachable }))
  );
  expect(grouped).toEqual([{ message: unreachable, agentIds: ['a', 'b', 'c', 'd'] }]);
});

it('keeps failures apart when their causes differ', () => {
  expect(
    groupDiscoveryFailures([
      { agentId: 'a', message: unreachable },
      { agentId: 'b', message: 'Session discovery failed: unsupported provider' },
      { agentId: 'c', message: unreachable },
    ])
  ).toEqual([
    { message: unreachable, agentIds: ['a', 'c'] },
    { message: 'Session discovery failed: unsupported provider', agentIds: ['b'] },
  ]);
});

it('reports nothing when discovery is healthy', () => {
  expect(groupDiscoveryFailures([])).toEqual([]);
});

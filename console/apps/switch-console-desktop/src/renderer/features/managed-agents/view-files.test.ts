import { describe, expect, it } from 'vitest';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { viewFilesAgent } from './view-files';

const AGENT: ManagedAgentView = {
  serverId: 'server-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  name: 'web-frontend',
  displayName: 'Web front end',
  iconUrl: null,
  description: '',
  machine: { id: 'controller-1', name: 'Switch cloud', kind: 'ec2', state: 'online' },
  desiredState: 'running',
  revision: 1,
  definition: {
    provider: 'claude',
    model: null,
    advancedConfig: {},
    instructions: '',
    autoApprove: false,
    autoMode: false,
    directory: null,
    isolation: 'shared',
  },
  status: { process: 'running', attached: true, reason: null, detail: null, directory: null },
};

describe('viewFilesAgent', () => {
  it('opens a cloud agent by its name, never its label', () => {
    expect(viewFilesAgent(AGENT, true)).toBe('web-frontend');
  });

  it('shows on a resting box too: the explorer wakes it', () => {
    expect(
      viewFilesAgent({ ...AGENT, machine: { ...AGENT.machine!, state: 'offline' } }, true)
    ).toBe('web-frontend');
  });

  it('is hidden while Your cloud files is hidden', () => {
    expect(viewFilesAgent(AGENT, false)).toBeNull();
  });

  it('is hidden for an agent on the owner’s own computer, or on no machine', () => {
    expect(
      viewFilesAgent({ ...AGENT, machine: { ...AGENT.machine!, kind: 'console' } }, true)
    ).toBeNull();
    expect(
      viewFilesAgent({ ...AGENT, machine: { ...AGENT.machine!, kind: 'daemon' } }, true)
    ).toBeNull();
    expect(viewFilesAgent({ ...AGENT, machine: null }, true)).toBeNull();
  });
});

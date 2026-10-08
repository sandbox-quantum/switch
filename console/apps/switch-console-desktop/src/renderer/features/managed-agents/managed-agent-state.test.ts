import { describe, expect, it } from 'vitest';
import type { ManagedAgentView, OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  machineProblem,
  machineTone,
  machineWorkspaceFor,
  managedAgentState,
} from './managed-agent-state';

const AGENT: ManagedAgentView = {
  serverId: 'server-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  name: 'pm-agent',
  displayName: null,
  iconUrl: null,
  description: '',
  machine: { id: 'controller-1', name: 'laptop', kind: 'console', state: 'online' },
  desiredState: 'running',
  revision: 1,
  definition: {
    provider: 'claude',
    model: null,
    advancedConfig: {},
    instructions: '',
    autoApprove: false,
    directory: null,
    isolation: 'shared',
  },
  status: { process: 'running', attached: true, reason: null, detail: null, directory: null },
};

describe('managedAgentState', () => {
  it('is running once its machine says it runs and is connected', () => {
    expect(managedAgentState(AGENT)).toEqual({ label: 'Running', tone: 'ok', detail: null });
  });

  it('is connecting while it runs but has not connected to Switch', () => {
    expect(
      managedAgentState({ ...AGENT, status: { ...AGENT.status!, attached: false } }).label
    ).toBe('Connecting');
  });

  it('is starting before its machine reports it', () => {
    expect(managedAgentState({ ...AGENT, status: null }).label).toBe('Starting');
  });

  it('says why it failed, in its machine’s words', () => {
    expect(
      managedAgentState({
        ...AGENT,
        status: {
          process: 'failed',
          attached: false,
          reason: 'crash_loop',
          detail: 'Exited 1',
          directory: null,
        },
      })
    ).toEqual({ label: 'Failed', tone: 'problem', detail: 'Exited 1' });
  });

  it('is stopping until its machine stops it, then stopped', () => {
    expect(managedAgentState({ ...AGENT, desiredState: 'stopped' }).label).toBe('Stopping');
    expect(managedAgentState({ ...AGENT, desiredState: 'stopped', status: null }).label).toBe(
      'Stopped'
    );
  });

  it('says its machine is offline or gone rather than guessing at the agent', () => {
    expect(
      managedAgentState({ ...AGENT, machine: { ...AGENT.machine!, state: 'unknown' } }).label
    ).toBe('Machine offline');
    expect(
      managedAgentState({ ...AGENT, machine: { ...AGENT.machine!, state: 'revoked' } }).label
    ).toBe('Machine removed');
    expect(managedAgentState({ ...AGENT, machine: null }).label).toBe('No machine');
  });
});

const LAPTOP: OwnedMachine = {
  ...AGENT.machine!,
  local: { kind: 'this-computer' },
  providers: [{ provider: 'claude', ready: true, problem: null }],
  workspacesDir: null,
};

describe('machineWorkspaceFor', () => {
  it('joins the machine’s workspaces folder and the agent’s name', () => {
    expect(machineWorkspaceFor({ ...LAPTOP, workspacesDir: '/srv/ws/' }, 'pm-agent')).toBe(
      '/srv/ws/pm-agent'
    );
    expect(machineWorkspaceFor({ ...LAPTOP, workspacesDir: 'C:\\ws' }, 'pm-agent')).toBe(
      'C:\\ws\\pm-agent'
    );
  });

  it('is null without a folder or a name', () => {
    expect(machineWorkspaceFor(LAPTOP, 'pm-agent')).toBeNull();
    expect(machineWorkspaceFor({ ...LAPTOP, workspacesDir: '/srv/ws' }, ' ')).toBeNull();
  });
});

describe('machineProblem', () => {
  it('finds nothing wrong with an agent running on an answering machine', () => {
    expect(machineProblem(AGENT, LAPTOP)).toBeNull();
    expect(machineTone(AGENT, LAPTOP)).toBe('ok');
  });

  it('says the machine stopped answering', () => {
    const offline = { ...AGENT, machine: { ...AGENT.machine!, state: 'unknown' as const } };
    expect(machineProblem(offline, LAPTOP)).toBe(
      'laptop stopped answering. The agent resumes when it reconnects.'
    );
    expect(machineTone(offline, LAPTOP)).toBe('problem');
  });

  it('gives the agent’s failure in its machine’s words', () => {
    const failed = {
      ...AGENT,
      status: {
        process: 'failed',
        attached: false,
        reason: 'crash_loop',
        detail: 'Exited 1',
        directory: null,
      },
    };
    expect(machineProblem(failed, LAPTOP)).toBe('Exited 1');
  });

  it('says the provider is not ready there', () => {
    expect(
      machineProblem(AGENT, {
        ...LAPTOP,
        providers: [{ provider: 'claude', ready: false, problem: 'not logged in' }],
      })
    ).toBe('Claude Code is not ready on laptop: not logged in.');
  });

  it('is quiet, not alarming, while the agent is stopped', () => {
    const stopped = { ...AGENT, desiredState: 'stopped' as const, status: null };
    expect(machineProblem(stopped, LAPTOP)).toBeNull();
    expect(machineTone(stopped, LAPTOP)).toBe('idle');
  });
});

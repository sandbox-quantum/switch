import { describe, expect, it, vi } from 'vitest';
import { buildSessionProviders } from './workspace-factory';

const connect = vi.hoisted(() => vi.fn(async () => ({ isConnected: true })));
const register = vi.hoisted(() => vi.fn());
const sshAgentRuntimeCtor = vi.hoisted(() => vi.fn());
const sshTerminalCtor = vi.hoisted(() => vi.fn());

// The ssh branch never touches the database; stub the client so importing the
// local-provider transitive graph doesn't open a real sqlite file at load.
vi.mock('@main/db/client', () => ({ db: {}, sqlite: {} }));

vi.mock('@main/core/ssh/lifecycle/production-ssh-connection-manager', () => ({
  sshConnectionManager: { register, connect, on: vi.fn() },
}));

vi.mock('@main/core/sessions/remote-session-preflight', () => ({
  preflightRemoteSession: vi.fn(async () => {}),
}));

vi.mock('@main/core/agent-runtime/impl/ssh-agent-runtime', () => ({
  SshAgentRuntime: vi.fn(function (args: unknown) {
    sshAgentRuntimeCtor(args);
  }),
}));

vi.mock('@main/core/terminals/impl/ssh-terminal-provider', () => ({
  SshTerminalProvider: vi.fn(function (args: unknown) {
    sshTerminalCtor(args);
  }),
}));

const SSH_TYPE = {
  kind: 'ssh' as const,
  host: 'box',
  remoteRepoDir: '/home/dev/r',
  connectionId: 'agent-ssh:box',
};

const OPTS = {
  projectId: 'proj-1',
  sessionId: 'session-1',
  workspaceId: 'proj-1:ssh:box:/home/dev/r',
  sessionPath: '/home/dev/r',
  tmuxEnabled: false, // project setting is off; remote must still force tmux on
  sessionEnvVars: {},
};

describe('buildSessionProviders (ssh)', () => {
  it('connects to the agent host and builds SSH providers with tmux forced on', async () => {
    await buildSessionProviders(SSH_TYPE, OPTS);

    expect(register).toHaveBeenCalledWith('agent-ssh:box', expect.any(Function));
    expect(connect).toHaveBeenCalledWith('agent-ssh:box');

    expect(sshAgentRuntimeCtor).toHaveBeenCalledTimes(1);
    const agentArgs = sshAgentRuntimeCtor.mock.calls[0]![0] as Record<string, unknown>;
    expect(agentArgs.tmux).toBe(true);
    expect(agentArgs.connectionId).toBe('agent-ssh:box');
    expect(agentArgs.fs).toBeDefined();
    expect(agentArgs.proxy).toBeDefined();

    const termArgs = sshTerminalCtor.mock.calls[0]![0] as Record<string, unknown>;
    expect(termArgs.tmux).toBe(true);
    expect(termArgs.connectionId).toBe('agent-ssh:box');
  });
});

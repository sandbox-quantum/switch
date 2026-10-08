import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exec: vi.fn(), sessions: vi.fn(), watcher: vi.fn() }));
vi.mock('electron', () => ({ app: {} }));
vi.mock('@main/core/agent-runtime/impl/resolve-sidecar-bundle', () => ({
  resolveSharedHostBundlePath: () => import.meta.filename,
}));
vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: async () => ({
    id: 'agent',
    switchAgentId: 'remote-agent',
    workspaceId: 'workspace',
  }),
}));
vi.mock('@main/core/agents/agent-location', () => ({
  getAgentLocation: async () => ({ sshHost: 'host', dir: '/work' }),
}));
vi.mock('@main/core/agents/connect-remote-agent', () => ({
  connectRemoteAgent: async () => ({ ctx: { exec: mocks.exec } }),
}));
vi.mock('@main/core/execution-context/local-execution-context', () => ({
  LocalExecutionContext: class {},
}));
vi.mock('@main/core/workspaces/workspace-session', () => ({
  withWorkspaceSession: (_workspaceId: string, fn: (server: { id: string }) => Promise<unknown>) =>
    fn({ id: 'server' }),
}));
vi.mock('./host-sessions', () => ({ listHostSessions: mocks.sessions }));
vi.mock('./host-watcher-snapshot', () => ({ hostWatcherStatus: mocks.watcher }));
const { sharedAgentDiagnostics, sharedAgentLogs } = await import('./diagnostics');
beforeEach(() => {
  vi.resetAllMocks();
  mocks.exec.mockResolvedValue({ stdout: '[]' });
  mocks.sessions.mockResolvedValue([]);
  mocks.watcher.mockResolvedValue(null);
});
it('keeps host management available while explicitly reporting a session-list failure', async () => {
  mocks.sessions.mockRejectedValue(new Error('Server unreachable'));
  const result = await sharedAgentDiagnostics('agent');
  expect(result).toMatchObject({
    workingDir: '/work',
    transport: 'ssh',
    watchers: [],
    sessions: null,
    sessionError: 'Error: Server unreachable',
  });
  expect(result.availableBuildHash).toMatch(/^[a-f0-9]{64}$/);
});
it('redacts secrets from logs before returning them to the renderer', async () => {
  mocks.exec.mockResolvedValue({
    stdout: JSON.stringify('token=example-placeholder\nWatcher started'),
  });
  const log = await sharedAgentLogs('agent');
  expect(log).not.toContain('example-placeholder');
  expect(log).toContain('[REDACTED]');
  expect(log).toContain('Watcher started');
  expect(mocks.exec.mock.calls[0][1].slice(-2)).toEqual(['remote-agent', 'logs']);
});
it('reads a remote watcher from its host’s snapshot, redacted, and propagates SSH failures', async () => {
  mocks.watcher.mockResolvedValueOnce({
    agentId: 'remote-agent',
    root: '/state/sdk-watchers/remote',
    running: false,
    build: `/state/sdk-host/shared-host-${'a'.repeat(64)}.mjs`,
    enabled: true,
    spawn: true,
    stoodDown: true,
    supervisorPid: 100,
    workerPid: 101,
    workerAlive: false,
    health: null,
    failure: 'token=example-placeholder',
    takenOver: { at: '2026-01-01T00:00:00.000Z', reason: 'token=example-placeholder' },
  });
  const [watcher] = (await sharedAgentDiagnostics('agent')).watchers;
  expect(watcher).toMatchObject({
    running: false,
    enabled: true,
    pid: null,
    supervisorPid: null,
    buildHash: 'a'.repeat(64),
  });
  expect(watcher.failure).toContain('[REDACTED]');
  // Whatever the server said when it evicted us reaches the panel too, so it
  // goes through the same redaction as any other reported text.
  expect(watcher.takenOver?.reason).toContain('[REDACTED]');
  // The panel no longer asks the host separately: it shares the snapshot.
  expect(mocks.exec).not.toHaveBeenCalled();
  mocks.watcher.mockRejectedValueOnce(new Error('SSH unavailable'));
  await expect(sharedAgentDiagnostics('agent')).rejects.toThrow('SSH unavailable');
});

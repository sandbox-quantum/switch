import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exec: vi.fn(), sessions: vi.fn() }));
vi.mock('electron', () => ({ app: {} }));
vi.mock('@main/core/agent-runtime/impl/resolve-sidecar-bundle', () => ({
  resolveSharedHostBundlePath: () => import.meta.filename,
}));
vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: async () => ({ id: 'agent', switchAgentId: 'remote-agent', serverId: 'server' }),
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
vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer: async () => ({ id: 'server' }),
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({ fetchSdkSessions: mocks.sessions }));
const { sharedAgentDiagnostics, sharedAgentLogs } = await import('./diagnostics');
beforeEach(() => {
  vi.resetAllMocks();
  mocks.exec.mockResolvedValue({ stdout: '[]' });
  mocks.sessions.mockResolvedValue([]);
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
it('redacts watcher failures and propagates SSH failures', async () => {
  mocks.exec.mockResolvedValueOnce({
    stdout: JSON.stringify([
      {
        running: false,
        enabled: true,
        pid: null,
        supervisorPid: null,
        buildHash: null,
        failure: 'token=example-placeholder',
        takenOver: { at: '2026-01-01T00:00:00.000Z', reason: 'token=example-placeholder' },
      },
    ]),
  });
  const [watcher] = (await sharedAgentDiagnostics('agent')).watchers;
  expect(watcher.failure).toContain('[REDACTED]');
  // Whatever the server said when it evicted us reaches the panel too, so it
  // goes through the same redaction as any other reported text.
  expect(watcher.takenOver?.reason).toContain('[REDACTED]');
  mocks.exec.mockRejectedValueOnce(new Error('SSH unavailable'));
  await expect(sharedAgentDiagnostics('agent')).rejects.toThrow('SSH unavailable');
});

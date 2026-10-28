import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        sessionCapabilities: { resume: {} },
        mcpCapabilities: { http: true },
      },
    }));
    server.replyAlways('authenticate', () => ({}));
    server.replyAlways('session/new', () => ({
      sessionId: 'native',
      configOptions: [
        { id: 'model', type: 'select', options: [{ value: 'qwen-coder-plus', name: 'Qwen Coder Plus' }] },
      ],
    }));
    server.replyAlways('session/resume', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));

const servers: FakeAppServer[] = [];
const { qwenAcp, createQwenAdapter } = await import('./qwen-acp');

beforeEach(() => {
  servers.length = 0;
});
afterEach(() => {
  for (const server of servers) server.kill();
});

it('launches with qwen --acp', async () => {
  const launch = await Promise.resolve(
    qwenAcp.launch({ binaryPath: '/usr/local/bin/qwen', cwd: '/work', env: { PATH: '/usr/bin' } })
  );
  expect(launch.command).toBe('/usr/local/bin/qwen');
  expect(launch.args).toEqual(['--acp']);
});

it('maps full-access to yolo mode', () => {
  expect(qwenAcp.sessionMode?.('full-access')).toBe('yolo');
});

it('maps auto-accept-edits to auto_edit mode', () => {
  expect(qwenAcp.sessionMode?.('auto-accept-edits')).toBe('auto_edit');
});

it('maps auto to auto_edit mode', () => {
  expect(qwenAcp.sessionMode?.('auto')).toBe('auto_edit');
});

it('maps approval-required to default mode', () => {
  expect(qwenAcp.sessionMode?.('approval-required')).toBe('default');
});

it('starts a session and resumes the native session id', async () => {
  const adapter = createQwenAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {
      switch: {
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: {},
      },
    },
    connectorMcpServers: [],
    resume: { nativeSessionId: 'native' },
  });
  expect(session.nativeSessionId).toBe('native');
  const server = servers.at(-1)!;
  const resumeMsg = server.received.find((m) => m.method === 'session/resume');
  expect(resumeMsg?.params).toMatchObject({ sessionId: 'native' });
});

it('has the correct provider id and default binary', () => {
  expect(qwenAcp.provider).toBe('qwen');
  expect(qwenAcp.defaultBinary).toBe('qwen');
});

it('declares approvals capability', () => {
  expect(qwenAcp.capabilities.approvals).toBe(true);
});

it('declares resume capability', () => {
  expect(qwenAcp.capabilities.resume).toBe(true);
});

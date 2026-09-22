import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildSharedHostConfig } from './build-shared-config';
import { executeHostedOperation } from './hosted-control';
import { applyHostedProvider } from './hosted-provider';
import { ensureSharedProcess } from './launch';

const root = await mkdtemp(join(tmpdir(), 'hosted-control-test-'));
vi.mock('./launch', () => ({
  sharedSessionRoot: (id: string) => join(root, id),
  sharedSessionsBase: () => root,
  liveSupervisor: vi.fn(),
  ensureSharedProcess: vi.fn(),
}));
afterEach(async () => {
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});
const supervision = { build: 'fixture', start: vi.fn(), stop: vi.fn() };
const config = () =>
  buildSharedHostConfig({
    session: { sessionId: 'watcher', agentId: 'agent-one', provider: 'claude' },
    launch: { cwd: '/workspace', runtimeMode: 'approval-required', env: {} },
    capabilities: { approvals: true, userInput: true },
    roomConnection: { rooms: [], startCursor: 0 },
    execution: {
      credentialsPath: '/credentials',
      inheritEnv: [],
      mcpRuntime: 'fixture',
      codexConfig: '',
      skill: '',
      context: '',
    },
    ids: { hostId: 'host', epoch: 'epoch', connectionId: 'watcher-connection' },
  });

it('starts an independent session without sharing the watcher connection', async () => {
  const template = config();
  await executeHostedOperation(
    template,
    { id: crypto.randomUUID(), session_id: 'session-one', action: 'start' },
    supervision
  );
  const args = vi.mocked(ensureSharedProcess).mock.calls[0]![0];
  expect(args.config.session.sessionId).toBe('session-one');
  expect(args.config.roomConnection!.connectionId).not.toBe(template.roomConnection!.connectionId);
  expect(args.config.roomConnection!.rooms).toEqual([]);
  expect(args.restart).toBe(false);
});

it('refuses to restart a saved session belonging to a different agent', async () => {
  const saved = config();
  saved.session.agentId = 'other-agent';
  saved.session.sessionId = 'session-one';
  await mkdir(join(root, 'session-one'), { recursive: true });
  await writeFile(join(root, 'session-one', 'config.json'), JSON.stringify(saved));
  await expect(
    executeHostedOperation(
      config(),
      { id: crypto.randomUUID(), session_id: 'session-one', action: 'restart' },
      supervision
    )
  ).rejects.toThrow('another agent');
  expect(ensureSharedProcess).not.toHaveBeenCalled();
});

it('switches credential types without retaining old secrets and fails closed on revocation', () => {
  const env = { ANTHROPIC_API_KEY: 'old-key', CLAUDE_CODE_OAUTH_TOKEN: 'old-token' };
  applyHostedProvider(env, {
    status: 'connected',
    revision: 'one',
    provider: 'claude',
    kind: 'setup-token',
    credential: 'new-token',
    sessions: [],
  });
  expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'new-token' });
  expect(() => applyHostedProvider(env, { status: 'revoked' })).toThrow('disconnected');
  expect(env).toEqual({});
});

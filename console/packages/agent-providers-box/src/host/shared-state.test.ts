import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SharedHostOptions } from './shared-host';
import { SharedState } from './shared-state';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'shared-state-'));
  roots.push(root);
  return root;
}

const session = {
  sessionId: 'session-id',
  agentId: 'agent-id',
  hostId: 'host-id',
  epoch: 'epoch',
  provider: 'claude',
  status: 'starting',
  connectivity: 'online',
  pendingRequestIds: [],
  capabilities: {
    input: 'queue',
    approvals: true,
    questions: true,
    interrupt: true,
    reset: true,
    compact: true,
    modelChange: false,
    attachmentMimeTypes: [],
  },
};

function options(
  root: string,
  overrides: { agentApiUrl?: string; session?: Partial<typeof session>; cwd?: string } = {}
): SharedHostOptions {
  return {
    root: join(root, 'host'),
    agentApiUrl: overrides.agentApiUrl ?? 'http://127.0.0.1:28300/',
    input: { cwd: overrides.cwd ?? root },
    session: { ...session, ...overrides.session },
  } as unknown as SharedHostOptions;
}

async function openAndClose(value: SharedHostOptions): Promise<SharedState> {
  const state = await SharedState.open(value);
  await state.unlock();
  return state;
}

describe('SharedState identity', () => {
  it('reopens the same session after the Switch API address changed', async () => {
    const root = await temporary();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await openAndClose(options(root));

    const moved = await openAndClose(options(root, { agentApiUrl: 'http://127.0.0.1:28301/' }));

    expect(moved.identity.session.sessionId).toBe('session-id');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('http://127.0.0.1:28301/'));
    await expect(openAndClose(options(root))).resolves.toBeDefined();
  });

  it.each([
    ['another agent', { session: { agentId: 'other-agent' } }],
    ['another session', { session: { sessionId: 'other-session' } }],
    ['another host', { session: { hostId: 'other-host' } }],
    ['another provider', { session: { provider: 'codex' } }],
    ['another directory', { cwd: '/somewhere/else' }],
  ])('still refuses %s', async (_label, overrides) => {
    const root = await temporary();
    await openAndClose(options(root));

    await expect(SharedState.open(options(root, overrides))).rejects.toThrow(
      'Shared host saved identity does not match the configuration.'
    );
    await expect(
      openAndClose(options(root, { agentApiUrl: 'http://127.0.0.1:28301/' }))
    ).resolves.toBeDefined();
  });
});

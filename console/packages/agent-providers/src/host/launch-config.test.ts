import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type * as Launch from './launch';
import { ensureSharedProcess } from './launch';
import { sharedConfigSchema } from './shared-config';
import { SharedWatchAssignments } from './shared-watcher';
const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('./launch', async (original) => ({
  ...(await original<typeof Launch>()),
  sharedSessionsBase: () => paths.root,
  sharedSessionRoot: (id: string) => join(paths.root, id),
}));

it('preserves a Console-updated session config when its watcher launches again', async () => {
  const base = await mkdtemp(join(tmpdir(), 'watcher-config-'));
  paths.root = base;
  try {
    const agentId = randomUUID();
    const template = sharedConfigSchema.parse({
      session: {
        sessionId: 'watcher',
        agentId,
        hostId: 'h',
        epoch: 'e',
        provider: 'claude',
        status: 'starting',
        connectivity: 'online',
        pendingRequestIds: [],
        capabilities: {
          input: 'queue',
          approvals: true,
          questions: true,
          interrupt: true,
          reset: false,
          compact: false,
          modelChange: false,
          attachmentMimeTypes: [],
        },
      },
      start: {
        provider: 'claude',
        input: {
          sessionId: 'watcher',
          cwd: base,
          runtimeMode: 'approval-required',
          env: {},
          mcpServers: {},
          model: { id: 'model-A' },
        },
      },
      roomConnection: { connectionId: 'watcher', rooms: [], startCursor: 0 },
    });
    const watcherRoot = join(base, 'watcher');
    const S = await (
      await SharedWatchAssignments.open(watcherRoot)
    ).assign(template, { sequence: 5, roomId: '!r', messageId: 'm1' });
    const root = join(base, S.session.sessionId);
    const supervision = { build: 'b', start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    await ensureSharedProcess({
      root,
      config: S,
      resuming: false,
      watcher: false,
      restart: false,
      supervision,
    });
    const consoleConfig = structuredClone(S);
    consoleConfig.start.input.model = { id: 'model-B' };
    consoleConfig.session.hostId = randomUUID();
    await ensureSharedProcess({
      root,
      config: consoleConfig,
      resuming: true,
      watcher: false,
      restart: true,
      supervision,
    });
    const again = await (
      await SharedWatchAssignments.open(watcherRoot)
    ).assign(sharedConfigSchema.parse(template), { sequence: 6, roomId: '!r', messageId: 'm2' });
    expect(again.start.input.model).toEqual({ id: 'model-B' });
    await ensureSharedProcess({
      root,
      config: S,
      resuming: false,
      watcher: false,
      restart: false,
      supervision,
    });
    const afterWatcher = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
    expect(afterWatcher.start.input.model).toEqual({ id: 'model-B' });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

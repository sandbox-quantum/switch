import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sharedConfigSchema } from './shared-config';
import { SharedWatchAssignments } from './shared-watcher';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('./launch', () => ({
  sharedSessionRoot: (id: string) => join(paths.root, id),
  ensureSharedProcess: vi.fn(),
}));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(['claude', 'codex', 'opencode', 'gemini', 'cursor'])(
  'keeps %s room assignments across a crash before launch and duplicate delivery',
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-test-'));
    roots.push(root);
    paths.root = root;
    const template = sharedConfigSchema.parse({
      session: {
        sessionId: 'watcher',
        agentId: randomUUID(),
        hostId: 'host',
        epoch: 'initial',
        provider,
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
        provider,
        input: {
          sessionId: 'watcher',
          cwd: root,
          runtimeMode: 'approval-required',
          env: { TEST_SETTING: 'preserved', SWITCHDASH_SESSION_ID: 'watcher' },
          mcpServers: {},
        },
      },
      roomConnection: { connectionId: 'watcher', rooms: [], startCursor: 0 },
    });
    const event = { sequence: 7, roomId: 'room', messageId: 'message' };
    const first = await (await SharedWatchAssignments.open(root)).assign(template, event);
    const restarted = await SharedWatchAssignments.open(root);
    expect(restarted.cursor).toBe(7);
    expect(await restarted.assign(template, event)).toEqual(first);
    expect(await restarted.assign(template, { ...event, sequence: 8, messageId: 'next' })).toEqual(
      first
    );
    expect(restarted.sessions()).toHaveLength(1);
    expect(first.roomConnection).toMatchObject({ rooms: ['room'], startCursor: 6 });
    expect(first.start.input.env).toEqual({
      TEST_SETTING: 'preserved',
      SWITCHDASH_SESSION_ID: first.session.sessionId,
    });
    await expect(restarted.assign(template, { ...event, messageId: 'forged' })).rejects.toThrow(
      'identity'
    );
    const another = await restarted.assign(template, { ...event, sequence: 9, roomId: 'another' });
    expect(another.session.sessionId).not.toBe(first.session.sessionId);
    const firstRoot = join(root, first.session.sessionId);
    await mkdir(firstRoot);
    await writeFile(
      join(firstRoot, 'room-inbox.jsonl'),
      JSON.stringify({ type: 'rooms', rooms: ['another'] }) + '\n'
    );
    const returned = await restarted.assign(template, {
      ...event,
      sequence: 10,
      messageId: 'returned',
    });
    expect(returned.session.sessionId).not.toBe(first.session.sessionId);
    expect(returned.roomConnection?.rooms).toEqual(['room']);
    expect(await restarted.assign(template, event)).toEqual(first);
    const returnedRoot = join(root, returned.session.sessionId);
    await mkdir(returnedRoot);
    await writeFile(join(returnedRoot, 'room-inbox.jsonl'), '{');
    await expect(
      restarted.assign(template, { ...event, sequence: 11, messageId: 'after-crash' })
    ).rejects.toThrow('incomplete record');
    expect(restarted.cursor).toBe(10);
  }
);

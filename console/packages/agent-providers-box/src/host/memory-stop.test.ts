import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  announceMemoryStop,
  MEMORY_STOP_MESSAGE,
  MEMORY_STOP_REQUEST_FILE,
  requestMemoryStop,
} from './memory-stop';
import type { SharedHostConfig } from './shared-config';

const identity = {} as never;
const NOW = 1_800_000_000_000;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'memory-stop-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config(sessionId: string): SharedHostConfig {
  return {
    session: { sessionId, hostId: `host-${sessionId}`, epoch: `epoch-${sessionId}` },
    start: { input: { cwd: '/work/scout' } },
  } as unknown as SharedHostConfig;
}

const ROOMS: Record<string, string> = { s1: 'room-1', s2: 'room-2', s3: 'room-3', s4: 'room-1' };

function input(busy: string[], placed: string[], post = vi.fn(async () => {})) {
  return {
    root,
    busy: () => busy,
    placed: () => placed,
    roomOf: (sessionId: string) => ROOMS[sessionId] ?? null,
    sessionConfig: async (sessionId: string) => {
      if (sessionId === 'broken') throw new Error('config unreadable');
      return sessionId === 'deleted' ? null : config(sessionId);
    },
    sessionRoot: (sessionId: string) => `/state/sessions/${sessionId}`,
    identity,
    connectionId: 'controller',
    post,
    now: () => NOW,
  };
}

describe('announceMemoryStop', () => {
  it('tells each room of a session mid-turn once, in the agreed words', async () => {
    await requestMemoryStop(root, NOW - 1_000);
    const post = vi.fn(async () => {});
    // s4 shares room-1 with s1: one line for the room.
    expect(await announceMemoryStop(input(['s1', 's2', 's4'], ['s3'], post))).toBe(2);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        session: { sessionId: 's1', hostId: 'host-s1', epoch: 'epoch-s1' },
        root: '/state/sessions/s1',
        cwd: '/work/scout',
        threadId: null,
        body: MEMORY_STOP_MESSAGE,
      })
    );
    expect(MEMORY_STOP_MESSAGE).toBe(
      "I used more memory than I'm allowed, so I stopped that work. Your other agents are fine. Mention me again when you want me to try again."
    );
  });

  it('tells every room a session attends when none is mid-turn', async () => {
    await requestMemoryStop(root, NOW);
    const post = vi.fn(async () => {});
    expect(await announceMemoryStop(input([], ['s3', 'deleted'], post))).toBe(1);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ sessionId: 's3' }) })
    );
  });

  it('skips a room it cannot tell, or a session it cannot read, and counts the rest', async () => {
    await requestMemoryStop(root, NOW);
    const post = vi.fn(async (posted: { session: { sessionId: string } }) => {
      if (posted.session.sessionId === 's1') throw new Error('Switch refused post_message');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await announceMemoryStop(input(['s1', 'broken', 's2'], [], post as never))).toBe(1);
    expect(errors).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  it('tells no room without a fresh request from the controller', async () => {
    const post = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await announceMemoryStop(input(['s1'], [], post))).toBe(0);
    await requestMemoryStop(root, NOW - 31_000);
    expect(await announceMemoryStop(input(['s1'], [], post))).toBe(0);
    // A link in its place is not read.
    await rm(join(root, MEMORY_STOP_REQUEST_FILE), { force: true });
    await writeFile(join(root, 'elsewhere.json'), JSON.stringify({ at: NOW }));
    await symlink(join(root, 'elsewhere.json'), join(root, MEMORY_STOP_REQUEST_FILE));
    expect(await announceMemoryStop(input(['s1'], [], post))).toBe(0);
    expect(post).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.skipIf(process.platform === 'win32')(
    'does not wait on a pipe planted at the request name',
    async () => {
      execFileSync('mkfifo', [join(root, MEMORY_STOP_REQUEST_FILE)]);
      const post = vi.fn(async () => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await announceMemoryStop(input(['s1'], [], post))).toBe(0);
      expect(post).not.toHaveBeenCalled();
      warn.mockRestore();
    },
    5_000
  );
});

describe('the request from the controller to the host', () => {
  it('is honoured once, through the real roots, and a repeat ask tells no room', async () => {
    const post = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await requestMemoryStop(root);
    expect(await announceMemoryStop({ ...input(['s1'], [], post), now: Date.now })).toBe(1);
    expect(await announceMemoryStop({ ...input(['s1'], [], post), now: Date.now })).toBe(0);
    expect(post).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('starts no new room after 2.5 s, and answers with what it did post', async () => {
    await requestMemoryStop(root, NOW);
    let clock = NOW;
    const post = vi.fn(async () => {
      clock += 2_000; // a slow room
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      await announceMemoryStop({ ...input(['s1', 's2', 's3'], [], post), now: () => clock })
    ).toBe(2);
    expect(post).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

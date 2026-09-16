import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runResidentRoomSession } from './resident-host';
import type * as SharedConfigModule from './shared-config';
import { sharedConfigSchema, type SharedHostConfig } from './shared-config';

/**
 * `prepareSharedConfig` is the first slow step of a room session and the provider
 * probe follows it. Both run here as a checkpoint: whatever ownership the session
 * has taken must already be on disk by the time they are reached.
 */
const { seen } = vi.hoisted(() => ({ seen: { owner: '', config: '', failure: '' } }));
vi.mock('./shared-config', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedConfigModule>();
  const { readFile: read } = await import('node:fs/promises');
  const at = async (path: string) => {
    try {
      return await read(path, 'utf8');
    } catch {
      return '';
    }
  };
  return {
    ...actual,
    prepareSharedConfig: vi.fn(async (root: string) => {
      seen.owner = await at(join(root, 'supervisor', 'owner.json'));
      seen.config = await at(join(root, 'config.json'));
      seen.failure = await at(join(root, 'supervisor', 'failure.json'));
      throw new Error('stop before the provider probe');
    }),
  };
});

const roots: string[] = [];
afterEach(async () => {
  seen.owner = '';
  seen.config = '';
  seen.failure = '';
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function configFor(cwd: string): SharedHostConfig {
  return sharedConfigSchema.parse({
    session: {
      sessionId: 'session-a',
      agentId: 'agent',
      hostId: 'host',
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
        reset: false,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
    },
    start: {
      provider: 'claude',
      input: {
        sessionId: 'session-a',
        cwd,
        runtimeMode: 'approval-required',
        env: { SWITCH_CONNECTION_ID: 'a' },
        mcpServers: {},
      },
    },
    roomConnection: { connectionId: 'a', rooms: ['room-a'], startCursor: 0 },
  });
}

it('owns its state directory before the provider probe, and clears a recovered failure', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'resident-session-test-'));
  roots.push(workspace);
  const root = join(workspace, 'session');
  await mkdir(join(root, 'supervisor'), { recursive: true });
  await writeFile(
    join(root, 'supervisor', 'failure.json'),
    JSON.stringify({ message: 'a fault this run has recovered from' })
  );
  const config = configFor(workspace);

  await expect(
    runResidentRoomSession(
      {
        context: { roomId: 'room-a', sessionId: 'session-a', connectionId: 'a' },
        root,
        config,
        signal: new AbortController().signal,
      },
      new Map()
    )
  ).rejects.toThrow('stop before the provider probe');

  // `ensureSharedProcess` reads both of these to decide whether to spawn a
  // competing supervisor; neither may be missing while the probe runs.
  expect(JSON.parse(seen.owner)).toEqual({ pid: process.pid, resident: true });
  expect(JSON.parse(seen.config).session.sessionId).toBe('session-a');
  expect(seen.failure).toBe('');

  // The session released its own ownership on the way out.
  await expect(readFile(join(root, 'supervisor', 'owner.json'), 'utf8')).rejects.toThrow('ENOENT');
  // The saved config stays: it is what identifies the session to a reopen.
  expect(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).session.sessionId).toBe(
    'session-a'
  );
});

it('leaves a live foreign owner of the state directory untouched', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'resident-owner-test-'));
  roots.push(workspace);
  const root = join(workspace, 'session');
  await mkdir(join(root, 'supervisor'), { recursive: true });
  // A per-room worker from the previous launch path can outlive the watcher
  // that started it. Its marker is how anything else knows not to compete.
  const owner = { pid: process.ppid, token: 'existing-supervisor' };
  process.kill(owner.pid, 0);
  await writeFile(join(root, 'supervisor', 'owner.json'), JSON.stringify(owner));
  await writeFile(join(root, 'config.json'), JSON.stringify({ saved: 'by the live owner' }));
  await writeFile(join(root, 'supervisor', 'failure.json'), JSON.stringify({ message: 'theirs' }));

  await expect(
    runResidentRoomSession(
      {
        context: { roomId: 'room-a', sessionId: 'session-a', connectionId: 'a' },
        root,
        config: configFor(workspace),
        signal: new AbortController().signal,
      },
      new Map()
    )
  ).rejects.toThrow(`owned by a live process (pid ${owner.pid})`);

  expect(JSON.parse(await readFile(join(root, 'supervisor', 'owner.json'), 'utf8'))).toEqual(owner);
  expect(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))).toEqual({
    saved: 'by the live owner',
  });
  expect(JSON.parse(await readFile(join(root, 'supervisor', 'failure.json'), 'utf8'))).toEqual({
    message: 'theirs',
  });
  // It never reached the work, so nothing of this session's was prepared.
  expect(seen.owner).toBe('');
});

it('sweeps provider groups a dead host left running before claiming the session', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'resident-groups-test-'));
  roots.push(workspace);
  const root = join(workspace, 'session');
  await mkdir(join(root, 'supervisor'), { recursive: true });

  // A provider group the previous host left behind: detached, so it survived
  // that host's own fence exactly as a real one would.
  const leftover = spawn('sleep', ['1000'], { detached: true, stdio: 'ignore' });
  leftover.unref();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(() => process.kill(leftover.pid!, 0)).not.toThrow();
  await writeFile(
    join(root, 'supervisor', 'groups.json'),
    JSON.stringify({ pid: leftover.pid! + 100000, groups: [leftover.pid] })
  );

  await expect(
    runResidentRoomSession(
      {
        context: { roomId: 'room-a', sessionId: 'session-a', connectionId: 'a' },
        root,
        config: configFor(workspace),
        signal: new AbortController().signal,
      },
      new Map()
    )
  ).rejects.toThrow('stop before the provider probe');

  // Gone before the claim proceeded, and the record with it.
  expect(() => process.kill(leftover.pid!, 0)).toThrow();
  await expect(readFile(join(root, 'supervisor', 'groups.json'), 'utf8')).rejects.toThrow('ENOENT');
  // The claim did reach the work: sweeping is a precondition, not a refusal.
  expect(JSON.parse(seen.owner)).toEqual({ pid: process.pid, resident: true });
}, 20_000);

it('refuses to act on a recorded group it cannot have spawned', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'resident-groups-refused-'));
  roots.push(workspace);
  const root = join(workspace, 'session');
  await mkdir(join(root, 'supervisor'), { recursive: true });
  // `kill(-1, ...)` is every process this user owns, not "no group". A record
  // naming it is corrupt, and acting on it would take the session down.
  await writeFile(
    join(root, 'supervisor', 'groups.json'),
    JSON.stringify({ pid: 999999, groups: [1] })
  );

  await expect(
    runResidentRoomSession(
      {
        context: { roomId: 'room-a', sessionId: 'session-a', connectionId: 'a' },
        root,
        config: configFor(workspace),
        signal: new AbortController().signal,
      },
      new Map()
    )
  ).rejects.toThrow('refusing to signal process group 1');
  // It never reached the work, and the record was left for a human to look at.
  expect(seen.owner).toBe('');
  expect(
    JSON.parse(await readFile(join(root, 'supervisor', 'groups.json'), 'utf8')).groups
  ).toEqual([1]);
});

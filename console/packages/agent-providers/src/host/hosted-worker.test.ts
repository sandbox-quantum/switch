import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerCallError } from '@sandboxaq/switch-agent-runtime';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AttachmentTransfers } from './attachment-transfers';
import type { ControlContext } from './control';
import { unconfirmedCutoverManifest, writeCutoverManifest } from './cutover-manifest';
import {
  CONSOLE_RECENT_MS,
  type HostedPort,
  HostedWorker,
  PAGE_BYTES,
  PAGE_IDLE_MS,
  RELAY_STALE_MS,
  RelayJournal,
  RelayPages,
} from './hosted-worker';
import { SessionLinks } from './session-channel';
import { WatcherControl } from './watcher-tools';

const paths = vi.hoisted(() => ({ base: '' }));
const supervisors = vi.hoisted(() => new Set<string>());
vi.mock('./launch', () => ({
  sharedSessionRoot: (id: string) => join(paths.base, id),
  sharedSessionsBase: () => paths.base,
  liveSupervisor: (root: string) => Promise.resolve(supervisors.has(root) ? { build: 'b' } : null),
}));

let root: string;
beforeEach(async () => {
  paths.base = await mkdtemp(join(tmpdir(), 'hosted-worker-'));
  root = join(paths.base, 'watcher');
});
afterEach(async () => {
  supervisors.clear();
  vi.restoreAllMocks();
  await rm(paths.base, { recursive: true, force: true });
});

type Child = EventEmitter & {
  connected: boolean;
  sent: { kind: string; id: number; request?: unknown }[];
  send: (message: unknown, callback: (error: Error | null) => void) => boolean;
};

/** A session host over IPC that records what it is sent and answers only when told to. */
function child(links: SessionLinks, sessionRoot: string): Child {
  const host = new EventEmitter() as Child;
  host.connected = true;
  host.sent = [];
  host.send = (message, callback) => {
    host.sent.push(message as Child['sent'][number]);
    callback(null);
    return true;
  };
  links.attach(sessionRoot, host as unknown as ChildProcess);
  return host;
}

async function eventually(reached: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await reached()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Never reached the state this test was waiting for.');
}

const attached = (overrides: Record<string, unknown> = {}) => ({
  launch_revision: 1,
  limits: { sessions_per_agent: 8 },
  idle: { report_every_s: 30, fresh_for_s: 75 },
  credential_revision: 'r1',
  queued_operations: [],
  relay_fence: 0,
  cancelled: [],
  ...overrides,
});

/** A bound worker with a fake stream and port, recording every up-call. */
async function worker(
  answer: (path: string, body: Record<string, unknown>) => unknown = () => ({})
) {
  const links = new SessionLinks();
  const control = new WatcherControl();
  const placed: [string, string][] = [];
  control.bind({
    forget: async () => {},
    place: async (sessionId, roomId) => {
      placed.push([sessionId, roomId]);
      return { sessionId, roomId, displaced: null, previous: null };
    },
  });
  const context: ControlContext = {
    agentId: 'agent',
    links,
    ensure: async () => ({ created: false }),
    watcher: control,
    transfers: new AttachmentTransfers(root),
  };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const operated: string[] = [];
  const port: HostedPort = {
    serial: (work) => work(),
    reasons: () => [],
    sessions: async () => ({ total: 0, live: 0, parked: 0, failed: 0, active: 0 }),
    wake: async () => {},
    cancel: async () => {},
    operate: async (operation) => {
      operated.push(`${operation.action}:${operation.sessionId}`);
    },
    revoke: async () => {},
    restart: async () => {},
    acks: {
      recordAck: async () => {},
      unconfirmedAcks: () => [],
      confirmAcks: async () => {},
    },
    fail: (error) => {
      throw error;
    },
  };
  const hosted = new HostedWorker(
    root,
    {
      capability: 'capability-placeholder',
      bootId: 'boot',
      instanceId: 'instance',
      stateVersion: 1,
    },
    context,
    { fetch: async () => ({ revoked: false, revision: 'r1', apply: async () => {} }) }
  );
  await hosted.open();
  const unbind = hosted.bind(
    {
      workerCall: async (path, body) => {
        calls.push({ path, body });
        if (path.endsWith('/connection/idle'))
          return { queued_operations: [], credential_revision: 'r1' };
        return answer(path, body);
      },
    },
    port
  );
  return { hosted, links, calls, placed, operated, port, unbind };
}

const idles = (calls: { path: string; body: Record<string, unknown> }[]) =>
  calls.filter((call) => call.path.endsWith('/connection/idle')).map((call) => call.body);

/** Attaches, and waits for the report that closes the attach's catch-up. */
async function attach(
  hosted: HostedWorker,
  calls: { path: string; body: Record<string, unknown> }[],
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const before = idles(calls).length;
  await hosted.frame('worker_attached', attached(overrides));
  await eventually(() => idles(calls).length > before);
}

const replies = (calls: { path: string; body: Record<string, unknown> }[], id: string) =>
  calls.filter((call) => call.path === `/agents/agent/connection/relay/${id}`).map((c) => c.body);

it('advances the relay watermark only over contiguous resolved numbers, fenced gaps included', async () => {
  const relays = await RelayJournal.open(root);
  await relays.receive(2, 'b');
  await relays.resolve(2, 'taken');
  expect(relays.through).toBe(0);
  await relays.receive(1, 'a');
  expect(relays.through).toBe(0);
  await relays.resolve(1, 'refused');
  expect(relays.through).toBe(2);
  await relays.receive(5, 'e');
  // 3 and 4 never arrived; the fence says they never will.
  await relays.fence(4);
  expect(relays.through).toBe(4);
  // Received and unresolved: the watermark stops before it, fence or not.
  await relays.fence(6);
  expect(relays.through).toBe(4);
});

it('resolves what the last process received and never resolved as interrupted', async () => {
  const first = await RelayJournal.open(root);
  await first.receive(1, 'a');
  const reopened = await RelayJournal.open(root);
  expect(reopened.isResolved(1)).toBe(true);
  expect(reopened.through).toBe(1);
  expect(await readFile(join(root, 'relays.jsonl'), 'utf8')).toContain('"interrupted"');
});

it('pages a large answer from one pinned copy and expires it when idle', async () => {
  const pages = new RelayPages(root, () => null);
  const value = { rows: 'x'.repeat(PAGE_BYTES * 2) };
  const first = (await pages.pin(value, null)) as {
    snapshotId: string;
    pageCount: number;
    sha256: string;
    page: { data: string };
  };
  expect(first.pageCount).toBe(3);
  const parts = [Buffer.from(first.page.data, 'base64')];
  for (const index of [1, 2]) {
    const next = (await pages.page(first.snapshotId, index)) as { page: { data: string } };
    parts.push(Buffer.from(next.page.data, 'base64'));
  }
  const whole = Buffer.concat(parts);
  expect(createHash('sha256').update(whole).digest('hex')).toBe(first.sha256);
  expect(JSON.parse(whole.toString())).toEqual(value);
  await expect(pages.page(first.snapshotId, 3)).rejects.toMatchObject({ code: 'invalid_page' });
  await pages.sweep(Date.now() + PAGE_IDLE_MS);
  await expect(pages.page(first.snapshotId, 1)).rejects.toMatchObject({
    code: 'snapshot_expired',
  });
});

it('refuses a fifth pinned answer, and a page of a session reset since', async () => {
  let epoch = 'one';
  const pages = new RelayPages(root, () => epoch);
  const large = 'x'.repeat(PAGE_BYTES + 1);
  const snapshot = (await pages.pin(
    { throughSequence: 3, session: { epoch: 'one' }, events: large },
    'session'
  )) as { snapshotId: string; epoch: string; throughSequence: number };
  expect(snapshot).toMatchObject({ epoch: 'one', throughSequence: 3 });
  for (let pinned = 1; pinned < 4; pinned++) await pages.pin({ large }, null);
  await expect(pages.pin({ large }, null)).rejects.toMatchObject({ code: 'snapshot_busy' });
  // A one-page answer pins nothing, so it is never refused.
  await expect(pages.pin({ small: true }, null)).resolves.toMatchObject({ pageCount: 1 });
  epoch = 'two';
  await expect(pages.page(snapshot.snapshotId, 1)).rejects.toMatchObject({
    code: 'snapshot_superseded',
  });
});

it('answers a relayed mutating message, journals it and reports it in the watermark', async () => {
  const { hosted, calls, placed } = await worker();
  await attach(hosted, calls);
  await hosted.frame('relay', {
    id: 'r1',
    deadline_ms: 30000,
    relay_seq: 1,
    message: { place: { sessionId: 's', roomId: 'room' } },
  });
  await eventually(() => replies(calls, 'r1').length === 1);
  expect(placed).toEqual([['s', 'room']]);
  expect(replies(calls, 'r1')[0]).toMatchObject({ ok: true, value: { sessionId: 's' } });
  await eventually(() => idles(calls).at(-1)!.relays_through === 1);
  expect(idles(calls).at(-1)).toMatchObject({
    busy: true,
    reasons: [{ kind: 'console_recent', session_id: null, count: 1 }],
  });
  const reported = idles(calls).length;
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CONSOLE_RECENT_MS);
  hosted.report(true);
  await eventually(() => idles(calls).length > reported);
  expect(idles(calls).at(-1)).toMatchObject({ busy: false, reasons: [] });
  const seqs = idles(calls).map((report) => report.report_seq as number);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
});

it('refuses what only the watcher sends, and an unreadable message', async () => {
  const { hosted, calls } = await worker();
  await attach(hosted, calls);
  await hosted.frame('relay', {
    id: 'ensure',
    deadline_ms: 30000,
    relay_seq: null,
    message: { ensure: { config: {}, resuming: false, restart: false } },
  });
  await hosted.frame('relay', {
    id: 'room',
    deadline_ms: 30000,
    relay_seq: null,
    message: { sessionId: 's', request: { type: 'approvals' } },
  });
  await hosted.frame('relay', { id: 'junk', deadline_ms: 30000, relay_seq: null, message: 7 });
  await eventually(() => ['ensure', 'room', 'junk'].every((id) => replies(calls, id).length));
  for (const id of ['ensure', 'room', 'junk'])
    expect(replies(calls, id)[0]).toMatchObject({ ok: false, error: { code: 'refused_message' } });
});

it('abandons a relay still waiting for its host, which then never receives it', async () => {
  const { hosted, links, calls } = await worker();
  await attach(hosted, calls);
  const sessionRoot = join(paths.base, 's');
  supervisors.add(sessionRoot);
  await hosted.frame('relay', {
    id: 'r1',
    deadline_ms: 30000,
    relay_seq: 1,
    message: { sessionId: 's', request: { type: 'command', command: {}, requesterName: null } },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await hosted.sweep(Date.now() + RELAY_STALE_MS);
  const host = child(links, sessionRoot);
  host.emit('message', { kind: 'ready' });
  await eventually(() => replies(calls, 'r1').length === 1);
  expect(replies(calls, 'r1')[0]).toMatchObject({ ok: false, error: { code: 'relay_abandoned' } });
  expect(host.sent).toEqual([]);
  expect(await readFile(join(root, 'relays.jsonl'), 'utf8')).toContain('"abandoned"');
});

it('closes a dispatched relay its host never answered with a busy barrier', async () => {
  const { hosted, links, calls } = await worker();
  await attach(hosted, calls);
  const sessionRoot = join(paths.base, 's');
  const host = child(links, sessionRoot);
  host.emit('message', { kind: 'ready' });
  supervisors.add(sessionRoot);
  await hosted.frame('relay', {
    id: 'r1',
    deadline_ms: 30000,
    relay_seq: 1,
    message: { sessionId: 's', request: { type: 'command', command: {}, requesterName: null } },
  });
  await eventually(() => host.sent.length === 1);
  const sweeping = hosted.sweep(Date.now() + RELAY_STALE_MS);
  await eventually(() => host.sent.some((message) => message.kind === 'busyBarrier'));
  const barrier = host.sent.find((message) => message.kind === 'busyBarrier')!;
  host.emit('message', { kind: 'busy', busy: false, reasons: [], barrier: barrier.id });
  await sweeping;
  expect(await readFile(join(root, 'relays.jsonl'), 'utf8')).toContain('"barrier"');
});

it('counts a running host that has not said whether it is busy as busy', async () => {
  const { hosted, links, calls } = await worker();
  await attach(hosted, calls);
  const host = child(links, join(paths.base, 's'));
  host.emit('message', {
    kind: 'identity',
    identity: { agentId: 'agent', sessionId: 's', hostId: 'h', epoch: 'e' },
  });
  hosted.report(true);
  await eventually(
    () =>
      JSON.stringify(idles(calls).at(-1)!.reasons) ===
      JSON.stringify([{ kind: 'host_unknown', session_id: 's', count: 1 }])
  );
  host.emit('message', {
    kind: 'busy',
    busy: true,
    reasons: [{ kind: 'turn_running', count: 1 }],
  });
  await eventually(
    () =>
      JSON.stringify(idles(calls).at(-1)!.reasons) ===
      JSON.stringify([{ kind: 'turn_running', session_id: 's', count: 1 }])
  );
});

it('claims a rung operation once, runs it and posts its result', async () => {
  const { hosted, calls, operated } = await worker((path) =>
    path.endsWith('/claim')
      ? { id: 'op', session_id: 's', action: 'start', state: 'claimed', error: null }
      : {}
  );
  await attach(hosted, calls);
  await hosted.claim('op');
  await hosted.claim('op');
  expect(operated).toEqual(['start:s']);
  expect(calls.filter((call) => call.path === '/hosted/operations/op/claim')).toHaveLength(1);
  expect(calls.find((call) => call.path === '/hosted/operations/op/result')!.body).toMatchObject({
    state: 'applied',
    error: null,
  });
});

it('posts an operation interrupted by a restart as unknown, and stops re-posting on a 409', async () => {
  const first = await worker((path) =>
    path.endsWith('/claim')
      ? { id: 'op', session_id: 's', action: 'restart', state: 'claimed', error: null }
      : {}
  );
  first.port.operate = () => new Promise(() => {});
  await attach(first.hosted, first.calls);
  void first.hosted.claim('op');
  await eventually(async () =>
    (await readFile(join(root, 'operations.jsonl'), 'utf8')).includes('claimed')
  );
  first.unbind();
  const second = await worker((path) => {
    if (path.endsWith('/result')) throw new WorkerCallError(409, 'operation_not_claimable', path);
    return {};
  });
  await second.hosted.frame('worker_attached', attached());
  await eventually(async () =>
    (await readFile(join(root, 'operations.jsonl'), 'utf8')).includes('"posted"')
  );
  expect(
    second.calls.find((call) => call.path === '/hosted/operations/op/result')!.body
  ).toMatchObject({ state: 'unknown' });
  const third = await worker();
  await attach(third.hosted, third.calls);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(third.calls.some((call) => call.path.endsWith('/result'))).toBe(false);
});

it('posts each notice once, keeps an unsent one for the next attach and drops a 404', async () => {
  let refuse: 'down' | 'missing' | null = 'down';
  const { hosted, calls } = await worker((path) => {
    if (path.endsWith('/room-notices') && refuse === 'down')
      throw new WorkerCallError(503, null, path);
    if (path.endsWith('/room-notices') && refuse === 'missing')
      throw new WorkerCallError(404, null, path);
    return {};
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await attach(hosted, calls);
  const notice = { roomId: 'room', messageId: 'm', threadId: null, reason: 'startup' as const };
  await hosted.notice(notice);
  await hosted.notice(notice);
  const posted = () => calls.filter((call) => call.path === '/agents/agent/room-notices');
  expect(posted()).toHaveLength(1);
  refuse = null;
  await attach(hosted, calls);
  await eventually(() => posted().length === 2);
  expect(posted()[1]!.body).toMatchObject({ room_id: 'room', message_id: 'm', reason: 'startup' });
  refuse = 'missing';
  await hosted.notice({ ...notice, reason: 'capacity' });
  await attach(hosted, calls);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(posted()).toHaveLength(3);
});

it('uploads the cutover manifest on attach until Switch confirms it, then never again', async () => {
  let refuse = true;
  const { hosted, calls } = await worker((path) => {
    if (path.endsWith('/cutover-manifest') && refuse) throw new WorkerCallError(503, null, path);
    return {};
  });
  const manifest = {
    manifest_sha256: 'a'.repeat(64),
    items: [{ kind: 'reset_pending' as const, session_id: 'session-placeholder' }],
  };
  await writeCutoverManifest(root, manifest);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const uploads = () => calls.filter((call) => call.path.endsWith('/connection/cutover-manifest'));
  await attach(hosted, calls);
  expect(uploads()).toHaveLength(1);
  expect(await unconfirmedCutoverManifest(root)).toEqual(manifest);
  refuse = false;
  await attach(hosted, calls);
  expect(uploads()).toHaveLength(2);
  expect(uploads()[1]!.body).toEqual(manifest);
  expect(await unconfirmedCutoverManifest(root)).toBeNull();
  await attach(hosted, calls);
  expect(uploads()).toHaveLength(2);
});

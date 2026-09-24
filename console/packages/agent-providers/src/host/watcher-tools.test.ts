import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionPlacements } from './placements';
import type { Caller } from './session-channel';
import { sessionToolAnswerer, WatcherControl, type WatcherHealth } from './watcher-tools';

const calls = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('@sandboxaq/switch-agent-runtime/hosted', () => ({
  SESSION_SELECTOR_HEADERS: {
    sessionId: 'X-Switch-Session-Id',
    hostId: 'X-Switch-Session-Host-Id',
    epoch: 'X-Switch-Session-Epoch',
  },
  loadOperations: async () => [],
  SwitchToolCatalog: class {
    tools() {
      return [];
    }
    call(ctx: { selector: Record<string, string> }, name: string, args: unknown) {
      return calls.connect(ctx.selector['X-Switch-Session-Id'], name, args);
    }
  },
}));
vi.mock('./shared-config', () => ({ sharedConfigSchema: { parse: (value: unknown) => value } }));

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function caller(base: string, sessionId: string): Promise<Caller> {
  const root = join(base, sessionId);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({ start: { input: { cwd: root } } }));
  return { agentId: 'agent', sessionId, hostId: 'host', epoch: 'epoch', root };
}

it('moves rooms one at a time, so a refused move puts back only what it replaced', async () => {
  const base = await mkdtemp(join(tmpdir(), 'watcher-tools-'));
  roots.push(base);
  const placements = await SessionPlacements.open(base, () => []);
  const answer = sessionToolAnswerer({
    identity: { agentId: 'agent', apiEndpoint: 'http://127.0.0.1', token: 't' } as never,
    connectionId: 'connection',
    placements,
    publish: async () => {},
  });
  let refuseFirst!: () => void;
  calls.connect.mockImplementation((sessionId: string) =>
    sessionId === 'first'
      ? new Promise((resolve) => {
          refuseFirst = () =>
            resolve({ isError: true, content: [{ type: 'text', text: 'refused' }] });
        })
      : Promise.resolve({ content: [{ type: 'text', text: 'connected' }] })
  );
  const first = answer(await caller(base, 'first'), {
    type: 'tool',
    name: 'connect_to_room',
    arguments: { room_id: 'room' },
  });
  const second = answer(await caller(base, 'second'), {
    type: 'tool',
    name: 'connect_to_room',
    arguments: { room_id: 'room' },
  });
  await vi.waitFor(() => expect(calls.connect).toHaveBeenCalledTimes(1));
  refuseFirst();
  await first;
  await second;
  expect(calls.connect.mock.calls.map(([sessionId]) => sessionId)).toEqual(['first', 'second']);
  expect(placements.sessionIn('room')).toBe('second');
});

it('keeps the watcher health, telling listeners only when something changed', () => {
  const control = new WatcherControl();
  expect(control.health()).toMatchObject({ state: 'not-running', detail: null, placements: {} });
  const heard: WatcherHealth[] = [];
  const stop = control.onHealth((health) => heard.push(health));

  control.report({ state: 'connecting', placements: { one: 'room' } });
  const connecting = control.health().since;
  control.report({ state: 'disconnected', detail: 'refused' });
  control.report({ state: 'disconnected', detail: 'refused' });
  // A new detail on the same state keeps when the state began.
  control.report({ detail: 'refused again' });
  expect(control.health().since).toBe(heard[1]!.since);
  // A new state clears the old detail.
  control.report({ state: 'connected' });
  control.report({ placements: { one: 'room' } });
  control.report({ placements: {} });
  stop();
  control.report({ state: 'not-running', placements: {} });

  expect(heard.map(({ state, detail, placements }) => ({ state, detail, placements }))).toEqual([
    { state: 'connecting', detail: null, placements: { one: 'room' } },
    { state: 'disconnected', detail: 'refused', placements: { one: 'room' } },
    { state: 'disconnected', detail: 'refused again', placements: { one: 'room' } },
    { state: 'connected', detail: null, placements: { one: 'room' } },
    { state: 'connected', detail: null, placements: {} },
  ]);
  expect(heard[0]!.since).toBe(connecting);
  expect(control.health().state).toBe('not-running');
});

it('keeps telling the other listeners when one of them throws', () => {
  const control = new WatcherControl();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const heard: string[] = [];
  control.onHealth(() => {
    throw new Error('broken listener');
  });
  control.onHealth((health) => heard.push(health.state));
  control.report({ state: 'connected' });
  expect(heard).toEqual(['connected']);
  expect(error.mock.calls[0]?.[0]).toContain('broken listener');
  error.mockRestore();
});

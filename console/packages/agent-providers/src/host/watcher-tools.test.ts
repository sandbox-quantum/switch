import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionPlacements } from './placements';
import type { Caller } from './session-channel';
import { sessionToolAnswerer } from './watcher-tools';

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

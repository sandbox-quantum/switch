import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { openSwitchStream, runAgentHost } from './agent-host';
import type { Supervision } from './launch';
import type * as OwnershipLock from './ownership-lock';
import { withOwnershipLock } from './ownership-lock';
import type { SharedHostConfig } from './shared-config';
import type { SharedHostOptions } from './shared-host';
import { SharedState } from './shared-state';
import { superviseSharedHost } from './supervisor';
import { WatcherControl } from './watcher-tools';

const written = vi.hoisted(() => [] as Array<{ path: string; value: unknown }>);

vi.mock('./ownership-lock', async (original) => {
  const actual = await original<typeof OwnershipLock>();
  return {
    ...actual,
    replaceOwner: async (path: string, value: unknown) => {
      written.push({ path, value: structuredClone(value) });
      await actual.replaceOwner(path, value);
    },
  };
});

/**
 * The supervisor quarantines these records after a reboot and refuses any
 * other shape, so its fixture has to match what this code writes.
 */
const OWNER_RECORDS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../deploy/hosted/worker/testdata/owner-records.json'
);

const roots: string[] = [];
afterEach(async () => {
  written.splice(0);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hosted-owner-records-'));
  roots.push(root);
  return root;
}

function shape(value: unknown, nullable: ReadonlySet<string>): Record<string, string> {
  expect(value).toBeTypeOf('object');
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, field]): [string, string] => [
        key,
        field === null && nullable.has(key) ? 'number' : typeof field,
      ])
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

async function fixtureRecords(): Promise<Array<[string, unknown]>> {
  return Object.entries(JSON.parse(await readFile(OWNER_RECORDS, 'utf8')));
}

it('writes owner records in the shapes the supervisor quarantines after a reboot', async () => {
  const root = await temporary();

  const tickets = await withOwnershipLock(root, async () => {
    const directory = join(root, 'ownership');
    return Promise.all(
      (await readdir(directory)).map(
        async (name) => JSON.parse(await readFile(join(directory, name), 'utf8')) as unknown
      )
    );
  });
  expect(tickets).toHaveLength(1);

  await expect(
    runAgentHost(
      join(root, 'watcher'),
      {} as SharedHostConfig,
      new AbortController().signal,
      {} as Supervision,
      new WatcherControl(),
      null,
      openSwitchStream
    )
  ).rejects.toThrow('execution credentials');

  await superviseSharedHost({
    root: join(root, 'session'),
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: process.env,
    signal: new AbortController().signal,
    build: '/opt/switch/agent-providers/shared-host-daemon.mjs',
    links: null,
    logRedactions: [],
  });

  const state = await SharedState.open({
    root: join(root, 'host'),
    agentApiUrl: 'https://switch.example.test/agent-api',
    input: { cwd: root },
    session: {
      sessionId: 'session-id',
      agentId: 'agent-id',
      hostId: 'host-id',
      epoch: 'epoch',
      provider: 'claude',
    },
  } as unknown as SharedHostOptions);
  await state.unlock();

  const produced = (path: string) => written.filter((entry) => entry.path === path);
  const [watcher] = produced(join(root, 'watcher', 'shared-owner.lock'));
  const [supervisor] = produced(join(root, 'session', 'supervisor', 'owner.json'));
  const [host] = produced(join(root, 'host', 'shared-owner.lock'));
  expect(watcher && supervisor && host).toBeTruthy();

  const nullable = new Set(['group']);
  const actual = {
    watcher: shape(watcher!.value, nullable),
    host: shape(host!.value, nullable),
    supervisor: shape(supervisor!.value, nullable),
    ticket: shape(tickets[0], nullable),
  };
  const records = await fixtureRecords();
  expect(records.length).toBeGreaterThan(0);
  for (const [relative, record] of records) {
    const expected = shape(record, nullable);
    if (basename(relative) === 'shared-owner.lock')
      expect([actual.watcher, actual.host]).toContainEqual(expected);
    else if (basename(relative) === 'owner.json') expect(expected).toEqual(actual.supervisor);
    else if (basename(dirname(relative)) === 'ownership') expect(expected).toEqual(actual.ticket);
    else throw new Error(`Unexpected owner record in the fixture: ${relative}`);
  }
  const lockShapes = records
    .filter(([relative]) => basename(relative) === 'shared-owner.lock')
    .map(([, record]) => shape(record, nullable));
  expect(lockShapes).toContainEqual(actual.watcher);
  expect(lockShapes).toContainEqual(actual.host);
});

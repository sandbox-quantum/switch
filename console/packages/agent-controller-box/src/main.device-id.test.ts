import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ControllerModule from './controller';
import type { ControllerDeps } from './controller';
import { EXIT_OK } from './exit-codes';
import { main } from './main';
import { dataLayout } from './paths';
import { CONTROLLER_CREDENTIAL, FileSecretStore } from './secrets';
import { ControllerStore } from './store';

/** As if the image carried a machine id: upstream's reader would name a device. */
const PRESENT = 'a'.repeat(64);
const read = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./device-id', () => ({
  SYSTEM_SOURCES: {},
  readDeviceId: async () => {
    read.calls++;
    return 'a'.repeat(64);
  },
}));

/** `run` up to the controller loop: the deps it is given, then a clean stop. */
const given = vi.hoisted(() => ({ deps: null as ControllerDeps | null }));
vi.mock('./controller', async (importOriginal) => {
  const actual = await importOriginal<typeof ControllerModule>();
  return {
    ...actual,
    runController: async (deps: ControllerDeps) => {
      given.deps = deps;
      return 'stopped' as const;
    },
  };
});

let dir: string;
let bundle: string;
const PROCESS_EVENTS = ['message', 'SIGINT', 'SIGTERM'] as const;
const emitter: NodeJS.EventEmitter = process;
let listenersBefore: Map<string, unknown[]>;

beforeEach(() => {
  read.calls = 0;
  given.deps = null;
  // As in main.test.ts: `run` unrefs the IPC channel, which is the test worker's own.
  if (process.channel)
    vi.spyOn(process.channel, 'unref').mockImplementation(() => process.channel!);
  listenersBefore = new Map(PROCESS_EVENTS.map((event) => [event, emitter.listeners(event)]));
  dir = mkdtempSync(join(tmpdir(), 'controller-device-id-'));
  bundle = join(dir, 'shared-host.mjs');
  writeFileSync(bundle, '');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  for (const event of PROCESS_EVENTS) {
    const before = listenersBefore.get(event) ?? [];
    for (const listener of emitter.listeners(event))
      if (!before.includes(listener))
        emitter.removeListener(event, listener as (...args: unknown[]) => void);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('a box sends no device id', () => {
  it('enrolls without one, even where the machine has an id', async () => {
    const bodies: { controller: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ controller_id: 'controller-1', credential: 'swcc_test' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    const code = await main([
      'enroll',
      '--server',
      'https://switch.example.com',
      '--code',
      'swce_test',
      '--name',
      'box',
      '--data-dir',
      dir,
      '--secret-store',
      'file',
    ]);
    expect(code).toBe(EXIT_OK);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.controller).not.toHaveProperty('device_id');
    expect(read.calls).toBe(0);
  });

  it('runs with none, so its status reports never carry one', async () => {
    const store = ControllerStore.open(join(dir, 'controller.db'));
    store.saveIdentity({
      controllerId: 'controller-1',
      server: 'https://switch.example.com',
      name: 'box',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    });
    store.close();
    await new FileSecretStore(dataLayout(dir).secrets).set(CONTROLLER_CREDENTIAL, 'swcc_test');
    const code = await main([
      'run',
      '--data-dir',
      dir,
      '--shared-host-bundle',
      bundle,
      '--updated-by-console',
      '--device-root',
      dir,
    ]);
    expect(code).toBe(EXIT_OK);
    expect(given.deps).not.toBeNull();
    expect(given.deps!.deviceId).toBeNull();
    expect(read.calls).toBe(0);
  });

  it('prints an empty device id when asked for one', async () => {
    const written: string[] = [];
    vi.mocked(process.stdout.write).mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    expect(await main(['--device-id', '--device-root', dir])).toBe(EXIT_OK);
    expect(written.join('')).toBe('\n');
    expect(written.join('')).not.toContain(PRESENT);
  });
});

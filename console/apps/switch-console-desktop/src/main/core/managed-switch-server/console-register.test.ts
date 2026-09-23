import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StackStateHost } from './stack-state';
import type * as StackState from './stack-state';

const getConsoleIdentity = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ id: '3f2a9c1e-5b7d-4e8f-a1b2-c3d4e5f6a7b8', name: 'alice@laptop' }))
);
const listProjectResources = vi.hoisted(() => vi.fn());
const readStateVolume = vi.hoisted(() => vi.fn());
const writeStateVolume = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const logWarn = vi.hoisted(() => vi.fn());

vi.mock('@main/core/switch-servers/console-identity', () => ({ getConsoleIdentity }));
vi.mock('@main/core/app/utils', () => ({ resolveAppVersion: () => Promise.resolve('0.36.0') }));
vi.mock('@main/lib/logger', () => ({ log: { warn: logWarn } }));
vi.mock('./stack-state', async (importOriginal) => ({
  ...(await importOriginal<typeof StackState>()),
  listProjectResources,
  readStateVolume,
  writeStateVolume,
}));

const { readRegister, recordOnHost, writeRecord } = await import('./console-register');

const SELF = '3f2a9c1e-5b7d-4e8f-a1b2-c3d4e5f6a7b8';

function host(account = 'alice') {
  const exec = vi.fn(async () => ({ stdout: `${account}\n`, stderr: '' }));
  return {
    host: { label: 'vm-1', ctx: { exec } } as unknown as StackStateHost,
    exec,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: new Date('2026-09-23T15:00:00.000Z'), toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('recording a Console on the host', () => {
  it('writes its register entry and a line of activity, both on stdin', async () => {
    const { host: h, exec } = host();

    await writeRecord(h, 'stopped');

    expect(exec).toHaveBeenCalledWith('id', ['-un'], expect.anything());
    const [, script, input, args] = writeStateVolume.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
      string[],
    ];
    expect(args).toEqual([SELF, '1']);
    const [entry, activity, rest] = input.split('\n');
    expect(JSON.parse(entry!)).toEqual({
      consoleId: SELF,
      name: 'alice@laptop',
      hostAccount: 'alice',
      appVersion: '0.36.0',
      lastSeenAt: '2026-09-23T15:00:00.000Z',
    });
    expect(JSON.parse(activity!)).toEqual({
      at: '2026-09-23T15:00:00.000Z',
      action: 'stopped',
      consoleId: SELF,
      name: 'alice@laptop',
      hostAccount: 'alice',
    });
    expect(rest).toBe('');
    // No value is spliced into the script; each arrives as data.
    expect(script).not.toContain('alice');
    expect(script).toContain('read -r entry');
  });

  it('refreshes only the register for a quiet sighting', async () => {
    const { host: h } = host();

    await writeRecord(h, null);

    const [, , input, args] = writeStateVolume.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
      string[],
    ];
    expect(args).toEqual([SELF, '0']);
    expect(input.trim().split('\n')).toHaveLength(1);
  });

  it('refuses to use an id that is not one as a file name', async () => {
    getConsoleIdentity.mockResolvedValueOnce({ id: '../../etc/passwd', name: 'x' });
    const { host: h } = host();

    await expect(writeRecord(h, 'started')).rejects.toThrow(/not one/);
    expect(writeStateVolume).not.toHaveBeenCalled();
  });

  it('does not fail the operation it describes when the record cannot be written', async () => {
    writeStateVolume.mockRejectedValueOnce(new Error('volume busy'));
    const { host: h } = host();

    await expect(recordOnHost(h, 'reset')).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('could not record reset on vm-1'),
      expect.anything()
    );
  });
});

describe('reading the register', () => {
  const alice = {
    consoleId: SELF,
    name: 'alice@laptop',
    hostAccount: 'alice',
    appVersion: '0.36.0',
    lastSeenAt: '2026-09-23T10:00:00.000Z',
  };
  const bob = {
    consoleId: 'b0b0b0b0-0000-4000-8000-000000000000',
    name: 'bob@desk',
    hostAccount: 'bob',
    appVersion: '0.36.0',
    lastSeenAt: '2026-09-23T12:00:00.000Z',
  };
  const started = {
    at: '2026-09-23T09:00:00.000Z',
    action: 'started',
    consoleId: SELF,
    name: 'alice@laptop',
    hostAccount: 'alice',
  };
  const stopped = {
    ...started,
    at: '2026-09-23T11:00:00.000Z',
    action: 'stopped',
    consoleId: bob.consoleId,
    name: 'bob@desk',
    hostAccount: 'bob',
  };

  it('lists the Consoles most recently seen first, and the activity newest first', async () => {
    listProjectResources.mockResolvedValue({ containers: [], dataVolumes: [], stateVolume: true });
    readStateVolume.mockResolvedValue(
      [
        JSON.stringify(alice),
        JSON.stringify(bob),
        '---switch-console-activity---',
        JSON.stringify(started),
        JSON.stringify(stopped),
        '',
      ].join('\n')
    );
    const { host: h } = host();

    expect(await readRegister(h)).toEqual({
      self: SELF,
      consoles: [bob, alice],
      activity: [stopped, started],
    });
  });

  it('skips a line it cannot read rather than hiding everyone else', async () => {
    listProjectResources.mockResolvedValue({ containers: [], dataVolumes: [], stateVolume: true });
    readStateVolume.mockResolvedValue(
      [
        JSON.stringify(alice),
        '{"consoleId":',
        JSON.stringify({ ...bob, lastSeenAt: 7 }),
        '---switch-console-activity---',
        JSON.stringify({ ...started, action: 'exploded' }),
        JSON.stringify(stopped),
      ].join('\n')
    );
    const { host: h } = host();

    const register = await readRegister(h);

    expect(register.consoles).toEqual([alice]);
    expect(register.activity).toEqual([stopped]);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('skipped unreadable'), {
      consoles: 2,
      activity: 1,
    });
  });

  it('is empty, not an error, before anything has been recorded', async () => {
    listProjectResources.mockResolvedValue({ containers: [], dataVolumes: [], stateVolume: false });
    const { host: h } = host();

    expect(await readRegister(h)).toEqual({ self: SELF, consoles: [], activity: [] });
    expect(readStateVolume).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store } = vi.hoisted(() => ({
  store: { get: vi.fn(), setOrThrow: vi.fn() },
}));
const os = vi.hoisted(() => ({
  hostname: vi.fn(() => 'alice-laptop.local'),
  userInfo: vi.fn(() => ({ username: 'alice' })),
}));
const logWarn = vi.hoisted(() => vi.fn());

vi.mock('@main/db/kv', () => ({
  KV: class {
    get = store.get;
    setOrThrow = store.setOrThrow;
  },
}));
vi.mock('node:os', () => os);
vi.mock('@main/lib/logger', () => ({ log: { warn: logWarn } }));

const CANONICAL_UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The id is memoised, so each case needs its own instance of the module. */
async function loadModule() {
  vi.resetModules();
  return import('./console-identity');
}

beforeEach(() => {
  vi.clearAllMocks();
  store.get.mockResolvedValue(null);
  store.setOrThrow.mockResolvedValue(undefined);
  os.hostname.mockReturnValue('alice-laptop.local');
  os.userInfo.mockReturnValue({ username: 'alice' });
});

describe('the console id', () => {
  it('is a random UUID created and stored the first time it is needed', async () => {
    const { getConsoleIdentity } = await loadModule();

    const { id } = await getConsoleIdentity();

    expect(id).toMatch(CANONICAL_UUID);
    expect(store.setOrThrow).toHaveBeenCalledWith('consoleId', id);
  });

  it('is the stored one when there is one, and is not rewritten', async () => {
    store.get.mockResolvedValue('stored-console-id');
    const { getConsoleIdentity } = await loadModule();

    await expect(getConsoleIdentity()).resolves.toMatchObject({ id: 'stored-console-id' });
    expect(store.setOrThrow).not.toHaveBeenCalled();
  });

  it('is created once however many callers ask at the same time', async () => {
    const { getConsoleIdentity } = await loadModule();

    const ids = await Promise.all([getConsoleIdentity(), getConsoleIdentity()]);

    expect(ids[0]!.id).toBe(ids[1]!.id);
    expect(store.setOrThrow).toHaveBeenCalledOnce();
  });

  it('is retried after a failed write rather than failing forever', async () => {
    store.setOrThrow.mockRejectedValueOnce(new Error('disk full'));
    const { getConsoleIdentity } = await loadModule();

    await expect(getConsoleIdentity()).rejects.toThrow('disk full');
    await expect(getConsoleIdentity()).resolves.toMatchObject({ id: expect.any(String) });
  });
});

describe('the console name', () => {
  it('is user@host of the desktop', async () => {
    const { consoleName } = await loadModule();

    expect(consoleName()).toBe('alice@alice-laptop.local');
  });

  it('is reduced to what the server will keep, so both show the same name', async () => {
    os.userInfo.mockReturnValue({ username: 'Ada Lovelace' });
    os.hostname.mockReturnValue('lab machine;rm -rf');
    const { consoleName } = await loadModule();

    expect(consoleName()).toBe('Ada-Lovelace@lab-machinerm--rf');
  });

  it('is capped at the length the server keeps', async () => {
    os.hostname.mockReturnValue('h'.repeat(200));
    const { consoleName } = await loadModule();

    expect(consoleName()).toHaveLength(64);
  });

  it('says unknown, and warns, when the desktop user cannot be read', async () => {
    os.userInfo.mockImplementation(() => {
      throw new Error('no passwd entry');
    });
    const { consoleName } = await loadModule();

    expect(consoleName()).toBe('unknown@alice-laptop.local');
    expect(logWarn).toHaveBeenCalledOnce();
  });
});

describe('consoleIdentityHeaders', () => {
  it('identifies the Console to a server it manages', async () => {
    store.get.mockResolvedValue('stored-console-id');
    const { consoleIdentityHeaders } = await loadModule();

    await expect(consoleIdentityHeaders({ managed: true })).resolves.toEqual({
      'X-Switch-Console-Id': 'stored-console-id',
      'X-Switch-Console-Name': 'alice@alice-laptop.local',
    });
  });

  it('tells a server someone else runs nothing, and creates no id for it', async () => {
    const { consoleIdentityHeaders } = await loadModule();

    await expect(consoleIdentityHeaders({ managed: false })).resolves.toEqual({});
    expect(store.get).not.toHaveBeenCalled();
    expect(store.setOrThrow).not.toHaveBeenCalled();
  });
});

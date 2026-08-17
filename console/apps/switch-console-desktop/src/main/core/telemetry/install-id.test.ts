import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store } = vi.hoisted(() => ({
  store: { get: vi.fn(), setOrThrow: vi.fn() },
}));

vi.mock('@main/db/kv', () => ({
  KV: class {
    get = store.get;
    setOrThrow = store.setOrThrow;
  },
}));

/** The module memoises, so each case needs its own instance of it. */
async function loadModule() {
  vi.resetModules();
  return import('./install-id');
}

beforeEach(() => {
  vi.clearAllMocks();
  store.get.mockResolvedValue(null);
  store.setOrThrow.mockResolvedValue(undefined);
});

describe('the install id', () => {
  it('is created and stored the first time it is needed', async () => {
    const { getInstallId } = await loadModule();

    const id = await getInstallId();

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.setOrThrow).toHaveBeenCalledWith('installId', id);
  });

  it('is the one already stored, when there is one', async () => {
    store.get.mockResolvedValue('stored-id');
    const { getInstallId } = await loadModule();

    await expect(getInstallId()).resolves.toBe('stored-id');
    expect(store.setOrThrow).not.toHaveBeenCalled();
  });

  it('is not the id the removed telemetry stack left behind', async () => {
    // That value lives under `telemetry:instanceId` in databases predating its
    // removal. Reading the same key would carry an identifier forward out of a
    // system users were told had been taken out.
    const { getInstallId } = await loadModule();

    await getInstallId();

    expect(store.get).toHaveBeenCalledWith('installId');
    expect(store.get).not.toHaveBeenCalledWith('instanceId');
  });

  it('is minted once, however many callers ask at the same moment', async () => {
    const { getInstallId } = await loadModule();

    const ids = await Promise.all([getInstallId(), getInstallId(), getInstallId()]);

    expect(new Set(ids).size).toBe(1);
    expect(store.setOrThrow).toHaveBeenCalledTimes(1);
  });

  it('is read once and reused, not fetched per event', async () => {
    store.get.mockResolvedValue('stored-id');
    const { getInstallId } = await loadModule();

    await getInstallId();
    await getInstallId();

    expect(store.get).toHaveBeenCalledTimes(1);
  });

  it('reports a failed write rather than returning an id nothing remembers', async () => {
    store.setOrThrow.mockRejectedValue(new Error('database is locked'));
    const { getInstallId } = await loadModule();

    await expect(getInstallId()).rejects.toThrow('database is locked');
  });

  it('can still be obtained after a failed write, rather than failing forever', async () => {
    // The memoised promise must not keep a rejection: every later event would
    // fail on a write that has long since stopped failing.
    store.setOrThrow.mockRejectedValueOnce(new Error('database is locked'));
    const { getInstallId } = await loadModule();

    await expect(getInstallId()).rejects.toThrow('database is locked');

    await expect(getInstallId()).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });
});

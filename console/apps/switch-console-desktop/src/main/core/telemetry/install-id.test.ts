import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { store } = vi.hoisted(() => ({
  store: { get: vi.fn(), setOrThrow: vi.fn(), delOrThrow: vi.fn() },
}));

vi.mock('@main/db/kv', () => ({
  KV: class {
    get = store.get;
    setOrThrow = store.setOrThrow;
    delOrThrow = store.delOrThrow;
  },
}));

/** The module memoises, so each case needs its own instance of it. */
async function loadModule() {
  vi.resetModules();
  return import('./install-id');
}

const NOW = Date.UTC(2026, 10, 12);
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  store.get.mockResolvedValue(null);
  store.setOrThrow.mockResolvedValue(undefined);
  store.delOrThrow.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The relay's guard, verbatim from its `filter/guard` processor. A payload
 * whose client id does not match is dropped — and answered with a 200, so
 * nothing downstream would ever tell us. This id is that client id.
 */
const CANONICAL_UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const STORED_ID = '3f2a9c41-8d7e-4b16-9a55-c0e1d2f47b83';

describe('the install id', () => {
  it('is created and stored, with when it was created, the first time it is needed', async () => {
    const { getInstallId } = await loadModule();

    const id = await getInstallId();

    expect(id).toMatch(CANONICAL_UUID);
    expect(store.setOrThrow).toHaveBeenCalledWith('installId', { id, createdAt: NOW });
  });

  it('is a shape the relay will accept, since it is silent when it will not', async () => {
    const { getInstallId } = await loadModule();

    const id = await getInstallId();

    expect(id).toMatch(CANONICAL_UUID);
    expect(id).not.toBe(NIL_UUID);
  });

  it('is the one already stored, while it is younger than 30 days', async () => {
    store.get.mockResolvedValue({ id: STORED_ID, createdAt: NOW - 29 * DAY_MS });
    const { getInstallId } = await loadModule();

    await expect(getInstallId()).resolves.toBe(STORED_ID);
    expect(store.setOrThrow).not.toHaveBeenCalled();
  });

  it('is replaced once it is 30 days old', async () => {
    store.get.mockResolvedValue({ id: STORED_ID, createdAt: NOW - 30 * DAY_MS });
    const { getInstallId } = await loadModule();

    const id = await getInstallId();

    expect(id).not.toBe(STORED_ID);
    expect(id).toMatch(CANONICAL_UUID);
    expect(store.setOrThrow).toHaveBeenCalledWith('installId', { id, createdAt: NOW });
  });

  it('is replaced when it expires while the app is running, not only at launch', async () => {
    const { getInstallId } = await loadModule();
    const first = await getInstallId();

    vi.setSystemTime(NOW + 30 * DAY_MS - 1);
    await expect(getInstallId()).resolves.toBe(first);

    vi.setSystemTime(NOW + 30 * DAY_MS);
    const second = await getInstallId();

    expect(second).not.toBe(first);
    expect(store.setOrThrow).toHaveBeenLastCalledWith('installId', {
      id: second,
      createdAt: NOW + 30 * DAY_MS,
    });
  });

  it('replaces an id stored before ids carried a creation time', async () => {
    store.get.mockResolvedValue(STORED_ID);
    const { getInstallId } = await loadModule();

    const id = await getInstallId();

    expect(id).not.toBe(STORED_ID);
    expect(store.setOrThrow).toHaveBeenCalledWith('installId', { id, createdAt: NOW });
  });

  it('replaces an id created in the future, whose age cannot be known', async () => {
    store.get.mockResolvedValue({ id: STORED_ID, createdAt: NOW + DAY_MS });
    const { getInstallId } = await loadModule();

    await expect(getInstallId()).resolves.not.toBe(STORED_ID);
  });

  it('replaces a stored value it cannot read as an id', async () => {
    store.get.mockResolvedValue({ id: STORED_ID });
    const { getInstallId } = await loadModule();

    await expect(getInstallId()).resolves.not.toBe(STORED_ID);
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

  it('is replaced once, however many callers find it expired at the same moment', async () => {
    store.get.mockResolvedValue({ id: STORED_ID, createdAt: NOW - 31 * DAY_MS });
    const { getInstallId } = await loadModule();

    const ids = await Promise.all([getInstallId(), getInstallId(), getInstallId()]);

    expect(new Set(ids).size).toBe(1);
    expect(store.setOrThrow).toHaveBeenCalledTimes(1);
  });

  it('is read once and reused, not fetched per event', async () => {
    store.get.mockResolvedValue({ id: STORED_ID, createdAt: NOW });
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
    store.setOrThrow.mockRejectedValueOnce(new Error('database is locked'));
    const { getInstallId } = await loadModule();

    await expect(getInstallId()).rejects.toThrow('database is locked');

    await expect(getInstallId()).resolves.toMatch(CANONICAL_UUID);
  });
});

describe('forgetting the install id', () => {
  it('deletes it from the store', async () => {
    const { forgetInstallId } = await loadModule();

    await forgetInstallId();

    expect(store.delOrThrow).toHaveBeenCalledWith('installId');
  });

  it('means the next id is a new one, not the one held in memory', async () => {
    const { forgetInstallId, getInstallId } = await loadModule();
    const before = await getInstallId();

    await forgetInstallId();
    const after = await getInstallId();

    expect(after).not.toBe(before);
    expect(store.setOrThrow).toHaveBeenCalledTimes(2);
  });

  it('runs after a mint asked for first, rather than racing it', async () => {
    const { forgetInstallId, getInstallId } = await loadModule();

    await Promise.all([getInstallId(), forgetInstallId()]);

    expect(store.setOrThrow).toHaveBeenCalledTimes(1);
    expect(store.delOrThrow).toHaveBeenCalledTimes(1);
    expect(store.setOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      store.delOrThrow.mock.invocationCallOrder[0]
    );
  });

  it('reports a failed delete rather than claiming the id is gone', async () => {
    store.delOrThrow.mockRejectedValue(new Error('database is locked'));
    const { forgetInstallId } = await loadModule();

    await expect(forgetInstallId()).rejects.toThrow('database is locked');
  });

  it('re-reads the store after a failed delete, rather than trusting memory', async () => {
    store.get.mockResolvedValue({ id: STORED_ID, createdAt: NOW });
    store.delOrThrow.mockRejectedValueOnce(new Error('database is locked'));
    const { forgetInstallId, getInstallId } = await loadModule();
    await getInstallId();

    await expect(forgetInstallId()).rejects.toThrow();
    await getInstallId();

    expect(store.get).toHaveBeenCalledTimes(2);
  });
});

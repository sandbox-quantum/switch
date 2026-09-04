import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkForUpdates = vi.fn();
const update = vi.fn();
const listPlugins = vi.fn();
const kvGet = vi.fn();
const kvSet = vi.fn();

vi.mock('@main/db/kv', () => ({
  KV: class {
    get = (...a: unknown[]) => kvGet(...a);
    set = (...a: unknown[]) => kvSet(...a);
  },
}));

vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../providers/plugin-registry', () => ({ listPlugins: () => listPlugins() }));

vi.mock('./switch-setup-service', () => ({
  switchSetupService: {
    checkForUpdates: (...a: unknown[]) => checkForUpdates(...a),
    update: (...a: unknown[]) => update(...a),
  },
}));

const { catchUpConnectorsToCurrentVersion } = await import('./catch-up-connectors');

const GENERATION = 1;

function plugin(id: string, kind = 'cli') {
  return { metadata: { id }, capabilities: { switchSetup: { kind } } };
}

/** Installed, one version behind, catalog readable. */
function behind(agentId: string) {
  return {
    agentId,
    supported: true,
    installed: true,
    installedVersion: '0.9.9',
    latestVersion: '0.9.10',
    updateAvailable: true,
    refreshError: null,
  };
}

function upToDate(agentId: string) {
  return { ...behind(agentId), installedVersion: '0.9.10', updateAvailable: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  kvGet.mockResolvedValue(null);
  listPlugins.mockReturnValue([plugin('claude'), plugin('codex')]);
  checkForUpdates.mockImplementation((id: string) => Promise.resolve(upToDate(id)));
  update.mockResolvedValue({ success: true });
});

describe('the connector catch-up', () => {
  it('updates every installed connector that is behind', async () => {
    checkForUpdates.mockImplementation((id: string) => Promise.resolve(behind(id)));
    await catchUpConnectorsToCurrentVersion();

    expect(update.mock.calls.map((call) => call[0])).toEqual(['claude', 'codex']);
  });

  it('leaves an up-to-date connector alone', async () => {
    await catchUpConnectorsToCurrentVersion();
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * A version catch-up, not an installer. Which agents have a Switch connector
   * is the user's decision, and taking it for them would put a plugin on a
   * machine that never asked for one.
   */
  it('never installs a connector that is not installed', async () => {
    checkForUpdates.mockImplementation((id: string) =>
      Promise.resolve({ ...behind(id), installed: false })
    );
    await catchUpConnectorsToCurrentVersion();
    expect(update).not.toHaveBeenCalled();
  });

  it('skips an agent type with no Switch setup at all', async () => {
    listPlugins.mockReturnValue([plugin('claude'), plugin('cursor', 'none')]);
    checkForUpdates.mockImplementation((id: string) => Promise.resolve(behind(id)));
    await catchUpConnectorsToCurrentVersion();

    expect(checkForUpdates.mock.calls.map((call) => call[0])).toEqual(['claude']);
  });
});

describe('latching — the difference between a one-shot and a standing job', () => {
  it('latches the generation once every connector is settled', async () => {
    await catchUpConnectorsToCurrentVersion();
    expect(kvSet).toHaveBeenCalledWith('state', { generation: GENERATION, attempts: 0 });
  });

  it('does nothing at all once latched', async () => {
    kvGet.mockResolvedValue({ generation: GENERATION, attempts: 0 });
    await catchUpConnectorsToCurrentVersion();

    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('does not latch when an update failed, so the next launch retries', async () => {
    checkForUpdates.mockImplementation((id: string) => Promise.resolve(behind(id)));
    update.mockResolvedValue({ success: false, message: 'network down' });
    await catchUpConnectorsToCurrentVersion();

    expect(kvSet).toHaveBeenCalledWith('state', { generation: 0, attempts: 1 });
  });

  /**
   * `updateAvailable` is false both when there is no update and when the
   * catalog could not be read. Latching on the second spends the single shot on
   * an answer that was never received.
   */
  it('does not latch when the catalog could not be refreshed', async () => {
    checkForUpdates.mockImplementation((id: string) =>
      Promise.resolve({ ...upToDate(id), refreshError: 'could not reach the marketplace' })
    );
    await catchUpConnectorsToCurrentVersion();

    expect(update).not.toHaveBeenCalled();
    expect(kvSet).toHaveBeenCalledWith('state', { generation: 0, attempts: 1 });
  });

  it('gives up after three attempts rather than retrying every launch forever', async () => {
    kvGet.mockResolvedValue({ generation: 0, attempts: 3 });
    await catchUpConnectorsToCurrentVersion();

    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('still latches when one connector updated and the rest were current', async () => {
    checkForUpdates.mockImplementation((id: string) =>
      Promise.resolve(id === 'claude' ? behind(id) : upToDate(id))
    );
    await catchUpConnectorsToCurrentVersion();

    expect(update).toHaveBeenCalledTimes(1);
    expect(kvSet).toHaveBeenCalledWith('state', { generation: GENERATION, attempts: 0 });
  });

  // One agent type's CLI being missing says nothing about the others, and must
  // not abandon them halfway.
  it('carries on past a connector that throws, and counts it as a failure', async () => {
    checkForUpdates.mockImplementation((id: string) => {
      if (id === 'claude') return Promise.reject(new Error('claude binary missing'));
      return Promise.resolve(behind(id));
    });
    await catchUpConnectorsToCurrentVersion();

    expect(update).toHaveBeenCalledWith('codex');
    expect(kvSet).toHaveBeenCalledWith('state', { generation: 0, attempts: 1 });
  });
});

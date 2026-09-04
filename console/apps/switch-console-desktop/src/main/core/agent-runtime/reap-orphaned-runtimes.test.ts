import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sweep = vi.fn();
const logInfo = vi.fn();
const logWarn = vi.fn();

vi.mock('@sandboxaq/switch-agent-runtime', () => ({
  reapOrphanedRuntimes: (...args: unknown[]) => sweep(...args),
}));

vi.mock('@main/lib/logger', () => ({
  log: { info: (...a: unknown[]) => logInfo(...a), warn: (...a: unknown[]) => logWarn(...a) },
}));

const { reapOrphanedAgentRuntimes } = await import('./reap-orphaned-runtimes');

const NOTHING = { reaped: 0, removedSessionDirs: 0, failures: [] };

beforeEach(() => {
  sweep.mockReset();
  logInfo.mockReset();
  logWarn.mockReset();
  sweep.mockResolvedValue(NOTHING);
});

afterEach(() => vi.restoreAllMocks());

describe('reapOrphanedAgentRuntimes', () => {
  it('sweeps the shared session root', async () => {
    await reapOrphanedAgentRuntimes();
    expect(sweep).toHaveBeenCalledWith({
      sessionsRoot: path.join(os.homedir(), '.switch', 'sessions'),
      keepSessionDir: null,
    });
  });

  /**
   * The app owns no session directory. Passing one of a runtime's — or a
   * plausible-looking guess — would spare a directory that should be swept, and
   * on a pid collision could spare a live one's.
   */
  it('spares no session directory, having none of its own', async () => {
    await reapOrphanedAgentRuntimes();
    expect(sweep.mock.calls[0][0].keepSessionDir).toBeNull();
  });

  it('says nothing when there was nothing to clear', async () => {
    await reapOrphanedAgentRuntimes();
    expect(logInfo).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('reports what it cleared, under one event', async () => {
    sweep.mockResolvedValue({ reaped: 3, removedSessionDirs: 12, failures: [] });
    await reapOrphanedAgentRuntimes();

    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo.mock.calls[0][1]).toMatchObject({
      event: 'agent_runtime_reap',
      reaped: 3,
      removedSessionDirs: 12,
    });
  });

  it('reports a directory sweep even with nothing reaped', async () => {
    sweep.mockResolvedValue({ reaped: 0, removedSessionDirs: 8016, failures: [] });
    await reapOrphanedAgentRuntimes();
    expect(logInfo).toHaveBeenCalledTimes(1);
  });

  it('warns per failed stage, with the stage as a code rather than prose', async () => {
    sweep.mockResolvedValue({
      reaped: 0,
      removedSessionDirs: 0,
      failures: [
        { stage: 'scan', error: new Error('ps missing') },
        { stage: 'sweep', error: new Error('permission denied') },
      ],
    });
    await reapOrphanedAgentRuntimes();

    expect(logWarn).toHaveBeenCalledTimes(2);
    expect(logWarn.mock.calls.map((call) => call[1].stage)).toEqual(['scan', 'sweep']);
    expect(logWarn.mock.calls[0][1]).toMatchObject({ event: 'agent_runtime_reap_failed' });
  });

  // Boot calls this without awaiting it. A rejection that escapes would be an
  // unhandled rejection during startup rather than a warning in the log.
  it('propagates a hard failure for the caller to catch, rather than throwing into boot', async () => {
    sweep.mockRejectedValue(new Error('ps exploded'));
    await expect(reapOrphanedAgentRuntimes()).rejects.toThrow('ps exploded');
  });
});

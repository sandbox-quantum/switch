import { describe, expect, it, vi } from 'vitest';
import {
  providerCheckFailed,
  setUpThisComputer,
  type ThisComputerApi,
} from './this-computer-setup';

function api(overview: Awaited<ReturnType<ThisComputerApi['getOverview']>>) {
  return {
    getOverview: vi.fn(async () => overview),
    enable: vi.fn(async () => {}),
  } satisfies ThisComputerApi;
}

const NOT_ENROLLED = { unsupportedReason: null, enrollment: null };
const ENROLLED = {
  unsupportedReason: null,
  enrollment: {} as NonNullable<Awaited<ReturnType<ThisComputerApi['getOverview']>>['enrollment']>,
};

// B38: opening Meet switch-buddy (or its provider setup) enrolled this
// computer as a machine of the workspace before the person had said yes.
describe('setting this computer up for switch-buddy', () => {
  it('only reads when a page opens: a computer not yet enrolled is left as it is', async () => {
    const calls = api(NOT_ENROLLED);
    expect(await setUpThisComputer(calls, 'server', 'workspace', false)).toBe('needs-permission');
    expect(calls.enable).not.toHaveBeenCalled();
  });

  it('enrols it once the person has said yes', async () => {
    const calls = api(NOT_ENROLLED);
    expect(await setUpThisComputer(calls, 'server', 'workspace', true)).toBe('enrolled');
    expect(calls.enable).toHaveBeenCalledOnce();
    expect(calls.enable).toHaveBeenCalledWith({ serverId: 'server', workspaceId: 'workspace' });
  });

  it('carries on with a computer already enrolled, asking nothing and enrolling nothing', async () => {
    const calls = api(ENROLLED);
    expect(await setUpThisComputer(calls, 'server', 'workspace', false)).toBe('enrolled');
    expect(await setUpThisComputer(calls, 'server', 'workspace', true)).toBe('enrolled');
    expect(calls.enable).not.toHaveBeenCalled();
  });

  it('says why when this computer cannot run managed agents here, and enrols nothing', async () => {
    const calls = api({
      unsupportedReason: 'This server does not run managed agents.',
      enrollment: null,
    });
    await expect(setUpThisComputer(calls, 'server', 'workspace', true)).rejects.toThrow(
      'This server does not run managed agents.'
    );
    expect(calls.enable).not.toHaveBeenCalled();
  });
});

// B38 follow-up: a failed provider check left Meet switch-buddy on "Checking
// AI providers…" with no Not now.
describe('a failed provider check', () => {
  it('stops the wait only when the check failed with nothing found and nothing reported', () => {
    expect(providerCheckFailed({ providers: [], failed: true }, false)).toBe(true);
    expect(providerCheckFailed({ providers: null, failed: true }, false)).toBe(true);
    expect(providerCheckFailed({ providers: [], failed: false }, false)).toBe(false); // still checking
    expect(providerCheckFailed(undefined, false)).toBe(false); // not read yet
    expect(providerCheckFailed({ providers: [], failed: true }, true)).toBe(false); // the controller reported
    expect(providerCheckFailed({ providers: [{}], failed: true }, false)).toBe(false); // what it found counts
  });
});

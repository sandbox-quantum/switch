import { describe, expect, it, vi } from 'vitest';
import { openingSetup, setUpThisComputer, type ThisComputerApi } from './this-computer-setup';

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

// The v1/v2 switch: B38's ask-first opening only with hosted agents v2 on.
describe('openingSetup', () => {
  it("waits until the server's flags are known, so a v2 server never enrols on a first guess", () => {
    expect(openingSetup(false, false)).toBe('wait');
    expect(openingSetup(false, true)).toBe('wait');
  });

  it('only reads, asking before enrolling, with hosted_v2 on (B38)', () => {
    expect(openingSetup(true, true)).toBe('read');
  });

  it('enrols straight away with hosted_v2 off, exactly as upstream', () => {
    expect(openingSetup(true, false)).toBe('enrol');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FLAGS_NOT_READ_YET } from '@shared/core/feature-flags/feature-flags';
import {
  FLAGS_NOT_SIGNED_IN,
  flagsAnswered,
  openingSetup,
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

// The v1/v2 switch: enrols by itself only after a good read with hosted agents v2 off.
describe('openingSetup', () => {
  it("waits until the server's flags are known, so a v2 server never enrols on a first guess", () => {
    expect(openingSetup(false, false, null)).toBe('wait');
    expect(openingSetup(false, true, false)).toBe('wait');
    expect(openingSetup(false, true, true)).toBe('wait');
  });

  it('only reads, asking before enrolling, with hosted_v2 on (B38)', () => {
    expect(openingSetup(true, true, true)).toBe('read');
  });

  it('enrols straight away after a good read with hosted_v2 off, exactly as upstream', () => {
    expect(openingSetup(true, true, false)).toBe('enrol');
  });

  it('only reads, asking first, when the read failed (every flag off is no proof v2 is off)', () => {
    expect(openingSetup(true, false, false)).toBe('read');
  });
});

// B38 on a first sign-in: the read made before anyone signed in is no answer.
describe('flagsAnswered', () => {
  it('answers once the flags are read', () => {
    expect(flagsAnswered({ fetchedAt: 1, error: null })).toBe(true);
  });

  it('is no answer before the flags are read', () => {
    expect(flagsAnswered({ fetchedAt: null, error: FLAGS_NOT_READ_YET })).toBe(false);
  });

  it('is no answer when the read was refused because nobody had signed in yet', () => {
    expect(flagsAnswered({ fetchedAt: null, error: FLAGS_NOT_SIGNED_IN })).toBe(false);
    // A v2 server's buddy must wait, not enrol on every flag off.
    expect(
      openingSetup(flagsAnswered({ fetchedAt: null, error: FLAGS_NOT_SIGNED_IN }), false, false)
    ).toBe('wait');
  });

  it('answers when a read fails while signed in, so the page is never held up, but only asks (no enrol)', () => {
    const failed = { fetchedAt: null, error: 'The server did not answer in time.' };
    expect(flagsAnswered(failed)).toBe(true);
    expect(openingSetup(flagsAnswered(failed), false, false)).toBe('read');
  });

  it("matches the gateway client's own not-signed-in refusal word for word", () => {
    const gateway = readFileSync(
      new URL('../../../main/core/switch-servers/gateway-client.ts', import.meta.url),
      'utf8'
    );
    expect(gateway).toContain(`'${FLAGS_NOT_SIGNED_IN}'`);
  });
});

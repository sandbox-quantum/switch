import { expect, it, vi } from 'vitest';
vi.mock('@main/core/switch-servers/gateway-client', () => ({ fetchMe: vi.fn() }));
const { supportsSdkSessions } = await import('./sdk-compatibility');
it('requires an explicit, overlapping SDK contract, not just a release version', () => {
  expect(supportsSdkSessions(null)).toBe(false);
  expect(supportsSdkSessions({ version: '99.0.0', contracts: {} })).toBe(false);
  for (const [accepts, speaks, expected] of [
    [1, 1, true],
    [1, 2, true],
    [2, 2, false],
    [2, 1, false],
    [0, 1, false],
    [1, 1.5, false],
  ] as const) {
    expect(
      supportsSdkSessions({ version: null, contracts: { 'sdk-sessions': { accepts, speaks } } })
    ).toBe(expected);
  }
});

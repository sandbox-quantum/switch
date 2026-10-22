import { describe, expect, it } from 'vitest';
import { cliActionFailure } from '@renderer/lib/stores/cli-action-outcome';

describe('cliActionFailure', () => {
  it('returns null for a successful result', () => {
    expect(cliActionFailure({ success: true, data: { status: 'missing' } })).toBeNull();
  });

  // An uninstall whose command exits 0 but leaves the binary in place comes
  // back as a resolved RPC carrying `still-present`; it must not read as success.
  it('returns an error for a still-present uninstall', () => {
    const failure = cliActionFailure({
      success: false,
      error: { type: 'still-present', id: 'opencode' },
    });
    expect(failure?.message).toBe('Still installed after uninstalling');
  });

  it('names the error type of any other failure', () => {
    expect(
      cliActionFailure({ success: false, error: { type: 'permission-denied' } })?.message
    ).toBe('permission-denied');
  });

  it('treats a response without a success flag as a failure', () => {
    expect(cliActionFailure(undefined)).toBeInstanceOf(Error);
  });
});

import { describe, expect, it } from 'vitest';
import { cliActionFailure } from './cli-action-failure';

describe('cliActionFailure', () => {
  it("carries the command's own reason, such as a full disk", () => {
    expect(
      cliActionFailure({
        type: 'command-failed',
        message: 'Install command failed.',
        output: 'Downloading…\nError: There is not enough space on the disk.\n',
      })
    ).toBe('Install command failed. Error: There is not enough space on the disk.');
  });

  it('says what to do when nothing could be run', () => {
    expect(cliActionFailure({ type: 'no-uninstall-command', id: 'cursor' })).toContain(
      'Remove it the way it was installed'
    );
  });
});

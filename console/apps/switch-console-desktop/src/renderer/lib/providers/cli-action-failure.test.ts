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

  it('says how to run a failed install by hand', () => {
    expect(
      cliActionFailure({
        type: 'command-failed',
        message: 'Install command failed.',
        output: "New-Item : Cannot find path 'C:\\x' because it does not exist.",
        runYourself: {
          command: 'powershell -c "irm https://example.com/install.ps1 | iex"',
          where: 'a PowerShell window',
        },
      })
    ).toBe(
      'Install command failed. New-Item : Cannot find path \'C:\\x\' because it does not exist. To install it yourself, run this in a PowerShell window, then Recheck: powershell -c "irm https://example.com/install.ps1 | iex"'
    );
  });
});

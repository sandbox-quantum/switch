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

  describe('across a release line', () => {
    const cause = { type: 'command-failed' as const, message: 'npm failed', output: 'EACCES' };
    it('gives the reason an upgrade could not start', () => {
      expect(
        cliActionFailure({
          type: 'line-migration-blocked',
          id: 'opencode',
          message: 'OpenCode is running. Nothing was changed.',
        })
      ).toBe('OpenCode is running. Nothing was changed.');
    });
    it('says nothing changed when the earlier version would not uninstall', () => {
      const message = cliActionFailure({
        type: 'line-migration-unremoved',
        id: 'opencode',
        previousVersion: '1.19.5',
        cause,
      });
      expect(message).toContain('nothing changed');
      expect(message).toContain('EACCES');
    });
    it('says the earlier version is back and keeps working', () => {
      const message = cliActionFailure({
        type: 'line-migration-failed',
        id: 'opencode',
        restoredVersion: '1.19.5',
        cause,
      });
      expect(message).toContain('1.19.5 was put back');
      expect(message).toContain('EACCES');
      expect(message).not.toContain('npm failed');
    });
    it('says nothing is installed and how to fix it when the restore failed too', () => {
      const message = cliActionFailure({
        type: 'line-migration-unrestored',
        id: 'opencode',
        previousVersion: '1.19.5',
        cause,
        restoreError: cause,
        installCommand: 'npm install -g @opencode/cli',
        restoreCommand: 'npm install -g opencode-ai@1.19.5',
      });
      expect(message).toContain('1.19.5 back failed too');
      expect(message).toContain('run npm install -g @opencode/cli in a terminal');
    });
  });
});

import { describe, expect, it } from 'vitest';
import { DatabaseFromNewerBuildError } from './initialize';
import { databaseOpenFailureDialog } from './open-failure-dialog';

describe('databaseOpenFailureDialog', () => {
  const newerBuild = new DatabaseFromNewerBuildError([1790300000000], 1790248865722);

  it('names the newer build as the cause, and the build that last used it as the remedy', () => {
    const { title, body } = databaseOpenFailureDialog(
      newerBuild,
      'Switch Console',
      '/logs/main.log'
    );

    expect(title).toBe('Switch Console could not open its database');
    expect(body).toContain('last opened by a newer or different build');
    expect(body).toContain('Open the build that last used it');
    expect(body).toContain('has not changed it');
    expect(body).not.toContain('another copy of the app already running');
  });

  // Canary is ahead of stable, so the newest stable release does not carry
  // Canary's migrations either: telling a stable user to update cannot work.
  it('does not tell the user that updating to the latest release will fix it', () => {
    const { body } = databaseOpenFailureDialog(newerBuild, 'Switch Console', '/logs/main.log');

    expect(body).not.toMatch(/latest release/i);
  });

  it('keeps the generic causes for any other failure', () => {
    const { body } = databaseOpenFailureDialog(
      new Error('SQLITE_BUSY: database is locked'),
      'Switch Console',
      '/logs/main.log'
    );

    expect(body).toContain('another copy of the app already running');
    expect(body).not.toContain('newer or different build');
  });

  it('ends with the log path and the raw error', () => {
    const { body } = databaseOpenFailureDialog(newerBuild, 'Switch Console', '/logs/main.log');

    expect(body).toContain('Full details are in the log: /logs/main.log');
    expect(body.split('\n').at(-1)).toBe(`Error: ${newerBuild.message}`);
  });

  it('leaves out the log line when there is no log file', () => {
    const { body } = databaseOpenFailureDialog('boom', 'Switch Console', undefined);

    expect(body).not.toContain('Full details are in the log');
    expect(body.split('\n').at(-1)).toBe('Error: boom');
  });
});

import { describe, expect, it } from 'vitest';
import { SWITCH_CONSOLE_RELEASES_URL } from '@shared/urls';
import { DatabaseFromNewerBuildError } from './initialize';
import { databaseOpenFailureDialog } from './open-failure-dialog';

const DATA_PATH = '/Users/someone/Library/Application Support/switchdash';
const DB_PATH = `${DATA_PATH}/switchdash.db`;

describe('databaseOpenFailureDialog', () => {
  const newerBuild = new DatabaseFromNewerBuildError([1790300000000], 1790248865722, DB_PATH);

  it('names the newer build as the cause, and the build that last used it as the remedy', () => {
    const { title, body } = databaseOpenFailureDialog(
      newerBuild,
      'Switch Console',
      DATA_PATH,
      '/logs/main.log'
    );

    expect(title).toBe('Switch Console could not open its database');
    expect(body).toContain('last opened by a newer or different build');
    expect(body).toContain('open the build that last used it');
    expect(body).toContain('It has not been changed.');
    expect(body).not.toContain('another copy of the app already running');
  });

  // The reporter of CHOO-3384 had never knowingly run another build, so naming
  // one is not enough on its own: the box has to say where the data is and
  // what moving it aside costs.
  it('names the folder to move aside when there is no build to go back to', () => {
    const { body } = databaseOpenFailureDialog(
      newerBuild,
      'Switch Console',
      DATA_PATH,
      '/logs/main.log'
    );

    expect(body).toContain('To start empty instead, quit and move this folder aside');
    expect(body).toContain('will not carry over');
    expect(body.split('\n')).toContain(DATA_PATH);
  });

  // A database put elsewhere with SWITCHDASH_DB_FILE: moving the data folder
  // aside would leave the refused file exactly where it is.
  it('names the database file instead when it is not in the data folder', () => {
    const elsewhere = '/tmp/scratch/switchdash.db';
    const { body } = databaseOpenFailureDialog(
      new DatabaseFromNewerBuildError([1790300000000], 1790248865722, elsewhere),
      'Switch Console',
      DATA_PATH,
      '/logs/main.log'
    );

    expect(body).toContain('move this database file aside, with the -wal and -shm files');
    expect(body.split('\n')).toContain(elsewhere);
    expect(body).not.toContain(DATA_PATH);
    expect(body).not.toContain('move this folder aside');
  });

  // The updater starts after the database opens, so a build that refuses its
  // database never updates itself; the box has to say where a newer one is.
  it('says where to download a newer release, and that it will not update itself', () => {
    const { body } = databaseOpenFailureDialog(
      newerBuild,
      'Switch Console',
      DATA_PATH,
      '/logs/main.log'
    );

    expect(body).toContain(
      `download a release newer than that build from ${SWITCH_CONSOLE_RELEASES_URL}`
    );
    expect(body).toContain('cannot update itself while it cannot start');
  });

  it('does not blame Canary alone, since a build from source writes the same folder', () => {
    const { body } = databaseOpenFailureDialog(
      newerBuild,
      'Switch Console',
      DATA_PATH,
      '/logs/main.log'
    );

    expect(body).toContain('or one built from source');
  });

  // Canary is ahead of stable, so the newest stable release does not carry
  // Canary's migrations either: telling a stable user to update cannot work.
  it('does not tell the user that updating to the latest release will fix it', () => {
    const { body } = databaseOpenFailureDialog(
      newerBuild,
      'Switch Console',
      DATA_PATH,
      '/logs/main.log'
    );

    expect(body).not.toMatch(/latest release/i);
  });

  it('keeps the generic causes for any other failure', () => {
    const { body } = databaseOpenFailureDialog(
      new Error('SQLITE_BUSY: database is locked'),
      'Switch Console',
      DATA_PATH,
      '/logs/main.log'
    );

    expect(body).toContain('another copy of the app already running');
    expect(body).not.toContain('newer or different build');
    expect(body).not.toContain(DATA_PATH);
  });

  it('ends with the log path and the raw error', () => {
    const { body } = databaseOpenFailureDialog(
      newerBuild,
      'Switch Console',
      DATA_PATH,
      '/logs/main.log'
    );

    expect(body).toContain('Full details are in the log: /logs/main.log');
    expect(body.split('\n').at(-1)).toBe(`Error: ${newerBuild.message}`);
  });

  it('leaves out the log line when there is no log file', () => {
    const { body } = databaseOpenFailureDialog('boom', 'Switch Console', DATA_PATH, undefined);

    expect(body).not.toContain('Full details are in the log');
    expect(body.split('\n').at(-1)).toBe('Error: boom');
  });
});

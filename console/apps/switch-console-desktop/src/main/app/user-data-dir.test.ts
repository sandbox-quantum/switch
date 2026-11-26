import { afterEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ IS_CANARY: false, USER_DATA_DIR_NAME: 'switchdash' }));
vi.mock('@shared/app-identity', () => identity);

const { checkedFolderName, freshReplayDirName, userDataDirName } = await import('./user-data-dir');

afterEach(() => {
  vi.unstubAllEnvs();
  identity.IS_CANARY = false;
});

describe('userDataDirName', () => {
  it('lets Canary start in a data folder of its own', () => {
    vi.stubEnv('DEV', false);
    identity.IS_CANARY = true;
    vi.stubEnv('SWITCH_CONSOLE_USER_DATA_DIR', 'switchdash-qa-1');
    expect(userDataDirName()).toBe('switchdash-qa-1');
  });

  it('keeps stable on the folder it has always used', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('SWITCH_CONSOLE_USER_DATA_DIR', 'switchdash-qa-1');
    expect(userDataDirName()).toBe('switchdash');
  });

  it('uses the usual folder when nothing names another', () => {
    identity.IS_CANARY = true;
    vi.stubEnv('SWITCH_CONSOLE_USER_DATA_DIR', '');
    expect(userDataDirName()).toBe('switchdash');
  });
});

describe('checkedFolderName', () => {
  it('takes a plain folder name', () => {
    expect(checkedFolderName('switchdash-qa_1.2')).toBe('switchdash-qa_1.2');
  });

  it.each(['../elsewhere', '/tmp/x', 'a/b', '..', '.', 'a b'])('refuses %j', (name) => {
    expect(() => checkedFolderName(name)).toThrow(/SWITCH_CONSOLE_USER_DATA_DIR/);
  });
});

describe('freshReplayDirName', () => {
  it('names a new folder after the current one', () => {
    expect(freshReplayDirName('switchdash-canary', 42)).toBe('switchdash-canary-replay-42');
  });

  it('does not nest when already in a replay folder', () => {
    expect(freshReplayDirName('switchdash-canary-replay-42', 99)).toBe(
      'switchdash-canary-replay-99'
    );
  });
});

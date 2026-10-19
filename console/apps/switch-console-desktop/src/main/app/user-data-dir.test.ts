import { afterEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ IS_CANARY: false, USER_DATA_DIR_NAME: 'switchdash' }));
vi.mock('@shared/app-identity', () => identity);

const { checkedFolderName, userDataDirName } = await import('./user-data-dir');

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

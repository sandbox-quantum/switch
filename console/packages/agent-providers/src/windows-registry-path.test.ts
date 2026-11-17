import { describe, expect, it } from 'vitest';
import {
  expandWindowsEnvVars,
  parseRegQueryPath,
  windowsRegistryPath,
  withWindowsPathEntries,
} from './windows-registry-path';

describe("Windows' registry PATH", () => {
  const machine =
    '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n' +
    '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;C:\\Program Files\\nodejs\\\r\n\r\n';
  const user =
    '\r\nHKEY_CURRENT_USER\\Environment\r\n' +
    '    Path    REG_SZ    %USERPROFILE%\\.local\\bin;%APPDATA%\\npm\r\n\r\n';
  const env = {
    SystemRoot: 'C:\\Windows',
    UserProfile: 'C:\\Users\\ada',
    APPDATA: 'C:\\Users\\ada\\AppData\\Roaming',
  };

  it('reads the Path value from reg query output', () => {
    expect(parseRegQueryPath(user)).toBe('%USERPROFILE%\\.local\\bin;%APPDATA%\\npm');
    expect(parseRegQueryPath('\r\nHKEY_CURRENT_USER\\Environment\r\n')).toBeNull();
  });

  it('expands variables without regard to case, and leaves unknown ones', () => {
    expect(expandWindowsEnvVars('%userprofile%\\bin;%NOPE%\\x', env)).toBe(
      'C:\\Users\\ada\\bin;%NOPE%\\x'
    );
  });

  it('gives the machine PATH, then the user one, expanded', async () => {
    const query = async (key: string) => (key.startsWith('HKCU') ? user : machine);
    expect(await windowsRegistryPath(env, query)).toBe(
      'C:\\Windows\\system32;C:\\Program Files\\nodejs\\;' +
        'C:\\Users\\ada\\.local\\bin;C:\\Users\\ada\\AppData\\Roaming\\npm'
    );
  });

  it('is null when neither key can be read', async () => {
    expect(await windowsRegistryPath(env, async () => null)).toBeNull();
  });

  it('adds only the folders the PATH lacks, compared as Windows compares them', () => {
    expect(
      withWindowsPathEntries(
        'C:\\Windows\\System32;C:\\Program Files\\nodejs',
        'c:\\windows\\system32\\;C:\\Users\\ada\\.local\\bin;C:\\Program Files\\nodejs\\'
      )
    ).toBe('C:\\Windows\\System32;C:\\Program Files\\nodejs;C:\\Users\\ada\\.local\\bin');
  });
});

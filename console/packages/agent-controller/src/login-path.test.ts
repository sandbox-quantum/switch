import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  expandWindowsEnvVars,
  loginShellPath,
  parseRegQueryPath,
  windowsRegistryPath,
  withUserBinDirs,
  withWindowsPathEntries,
} from './login-path';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A "shell" that ignores its arguments and runs `script`, as a login shell's init might around the PATH. */
async function fakeShell(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'login-path-'));
  dirs.push(dir);
  const shell = join(dir, 'shell');
  await writeFile(shell, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return shell;
}

describe.skipIf(process.platform === 'win32')("the login shell's PATH", () => {
  it('adds what the shell has after what the controller was given, past whatever the shell prints', async () => {
    const shell = await fakeShell(
      `echo "Welcome back"; printf '\\n__SWITCH_LOGIN_PATH__/opt/homebrew/bin:/usr/bin\\n'`
    );
    expect(await loginShellPath(shell, '/venv/bin:/usr/bin:/bin')).toBe(
      '/venv/bin:/usr/bin:/bin:/opt/homebrew/bin'
    );
  });

  it("puts the shell's PATH first over launchd's bare default, so Homebrew's tools win", async () => {
    const shell = await fakeShell(
      `printf '\\n__SWITCH_LOGIN_PATH__/opt/homebrew/bin:/usr/bin:/bin\\n'`
    );
    expect(await loginShellPath(shell, '/usr/bin:/bin:/usr/sbin:/sbin')).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    );
  });

  it('is null when the shell fails or does not say', async () => {
    expect(await loginShellPath(await fakeShell('exit 1'), '/usr/bin')).toBeNull();
    expect(await loginShellPath(await fakeShell('echo nothing useful'), '/usr/bin')).toBeNull();
    expect(await loginShellPath(join(tmpdir(), 'no-such-shell'), '/usr/bin')).toBeNull();
  });

  it('gives up on a profile that hangs and ignores SIGTERM, without waiting on it', async () => {
    const shell = await fakeShell("trap '' TERM; sleep 30");
    const started = Date.now();
    expect(await loginShellPath(shell, '/usr/bin', 300)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not wait for what the profile leaves running once the PATH is out', async () => {
    const shell = await fakeShell(
      `printf '\\n__SWITCH_LOGIN_PATH__/opt/bin\\n'; trap '' TERM; sleep 30`
    );
    const started = Date.now();
    expect(await loginShellPath(shell, '/usr/bin', 10_000)).toBe('/usr/bin:/opt/bin');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('withUserBinDirs', () => {
  it('adds ~/.local/bin after the PATH when it exists and is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'login-path-home-'));
    dirs.push(home);
    expect(withUserBinDirs('/usr/bin', home)).toBe('/usr/bin');
    await mkdir(join(home, '.local', 'bin'), { recursive: true });
    const bin = join(home, '.local', 'bin');
    expect(withUserBinDirs('/usr/bin', home)).toBe(['/usr/bin', bin].join(delimiter));
    const already = [bin, '/usr/bin'].join(delimiter);
    expect(withUserBinDirs(already, home)).toBe(already);
  });
});

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

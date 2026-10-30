import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loginShellPath,
  mergeWindowsPath,
  parseRegPath,
  pathRefresher,
  windowsRegistryPath,
  withUserBinDirs,
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
    expect(withUserBinDirs('/usr/bin', home, 'linux')).toBe('/usr/bin');
    await mkdir(join(home, '.local', 'bin'), { recursive: true });
    const bin = join(home, '.local', 'bin');
    expect(withUserBinDirs('/usr/bin', home, 'linux')).toBe(['/usr/bin', bin].join(delimiter));
    const already = [bin, '/usr/bin'].join(delimiter);
    expect(withUserBinDirs(already, home, 'linux')).toBe(already);
  });
});

describe('refreshing PATH on Windows', () => {
  const quiet = { warn: () => {} };

  async function windowsHome(): Promise<{ home: string; bin: string }> {
    const home = await mkdtemp(join(tmpdir(), 'login-path-win-'));
    dirs.push(home);
    const bin = join(home, '.local', 'bin');
    await mkdir(bin, { recursive: true });
    return { home, bin };
  }

  it("adds the user's .local\\bin, where Claude Code's installer writes, once it exists", async () => {
    const { home, bin } = await windowsHome();
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\system32' };
    await pathRefresher({
      platform: 'win32',
      env,
      home,
      log: quiet,
      windowsPath: async () => null,
    })();
    expect(env.PATH).toBe(`C:\\Windows\\system32;${bin}`);
  });

  it('adds what an installer wrote to the registry since this process started', async () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\system32;C:\\Tools' };
    await pathRefresher({
      platform: 'win32',
      env,
      home: 'C:\\Users\\nobody-here',
      log: quiet,
      windowsPath: async () => 'c:\\windows\\System32\\;C:\\Users\\me\\AppData\\Local\\Codex',
    })();
    expect(env.PATH).toBe('C:\\Windows\\system32;C:\\Tools;C:\\Users\\me\\AppData\\Local\\Codex');
  });

  it("says so, and keeps this process's PATH, when the registry cannot be read", async () => {
    const warnings: string[] = [];
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\system32' };
    await pathRefresher({
      platform: 'win32',
      env,
      home: 'C:\\Users\\nobody-here',
      log: { warn: (message) => warnings.push(message) },
      windowsPath: async () => null,
    })();
    expect(env.PATH).toBe('C:\\Windows\\system32');
    expect(warnings).toHaveLength(1);
  });

  it("reads the machine's PATH then the user's, expanding variables", async () => {
    const outputs: Record<string, string> = {
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment':
        '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\...\\Environment\r\n    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;C:\\Git\\cmd\r\n\r\n',
      'HKCU\\Environment':
        '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;%UNSET%\\x\r\n\r\n',
    };
    const path = await windowsRegistryPath(
      { SYSTEMROOT: 'C:\\Windows', UserProfile: 'C:\\Users\\me' },
      async (key) => outputs[key]!
    );
    expect(path).toBe('C:\\Windows\\system32;C:\\Git\\cmd;C:\\Users\\me\\.local\\bin;%UNSET%\\x');
  });

  it('uses whichever of the two it can read, and null when it can read neither', async () => {
    const userOnly = await windowsRegistryPath({}, async (key) => {
      if (key.startsWith('HKCU')) return '    Path    REG_SZ    C:\\Users\\me\\bin\r\n';
      throw new Error('ERROR: The system was unable to find the specified registry key or value.');
    });
    expect(userOnly).toBe('C:\\Users\\me\\bin');
    expect(
      await windowsRegistryPath({}, async () => {
        throw new Error('no reg');
      })
    ).toBeNull();
  });

  it('parses nothing from output without a Path value', () => {
    expect(
      parseRegPath('\r\nHKEY_CURRENT_USER\\Environment\r\n    TEMP    REG_SZ    x\r\n')
    ).toBeNull();
  });

  it('keeps the current order and adds only entries it lacks', () => {
    expect(mergeWindowsPath('C:\\B;c:\\a\\;C:\\C', 'C:\\A;C:\\B')).toBe('C:\\A;C:\\B;C:\\C');
  });
});

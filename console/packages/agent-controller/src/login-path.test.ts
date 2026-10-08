import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loginShellPath } from './login-path';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A "shell" that ignores its arguments and prints `output`, as a login shell's init might around the PATH. */
async function fakeShell(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'login-path-'));
  dirs.push(dir);
  const shell = join(dir, 'shell');
  await writeFile(shell, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return shell;
}

describe.skipIf(process.platform === 'win32')("the login shell's PATH", () => {
  it('comes first, past whatever the shell prints, with the entries only launchd gave kept after', async () => {
    const shell = await fakeShell(
      `echo "Welcome back"; printf '\\n__SWITCH_LOGIN_PATH__/opt/homebrew/bin:/usr/bin\\n'`
    );
    expect(loginShellPath(shell, '/usr/bin:/bin:/usr/sbin:/sbin')).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    );
  });

  it('is null when the shell fails or does not say', async () => {
    expect(loginShellPath(await fakeShell('exit 1'), '/usr/bin')).toBeNull();
    expect(loginShellPath(await fakeShell('echo nothing useful'), '/usr/bin')).toBeNull();
    expect(loginShellPath(join(tmpdir(), 'no-such-shell'), '/usr/bin')).toBeNull();
  });
});

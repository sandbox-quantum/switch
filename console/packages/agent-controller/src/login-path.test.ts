import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loginShellPath } from './login-path';

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

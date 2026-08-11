import { describe, expect, it } from 'vitest';
import type { IExecutionContext } from '../../exec/execution-context';
import { resolveAllCommandPaths, resolveCommandPath, resolveRealpath } from './probe';

function makeCtx(
  handler: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
): IExecutionContext {
  return {
    root: undefined,
    supportsLocalSpawn: false,
    exec: handler as IExecutionContext['exec'],
    execStreaming: async () => {},
    dispose: () => {},
  } as unknown as IExecutionContext;
}

// A login shell (`bash -lc`) on a hardened host echoes an MOTD banner to stdout
// ahead of the command output. Note the ASCII-art lines that themselves start
// with `/` — a naive "first line" or "starts with /" parse picks those.
const BANNER = [
  '  _____                 _ _                         ____',
  ' / ____|               | | |                  /\\   / __ \\',
  " \\___ \\ / _` | '_ \\ / _` | '_ \\ / _ \\ \\/ /  / /\\ \\| |  | |",
  '|_____/ \\__,_|_| |_|\\__,_|_.__/ \\___/_/\\_\\/_/    \\_\\___\\_\\',
  'example-host-debian-12-v260624-9131585f',
].join('\n');

describe('resolveCommandPath with login-shell banner noise', () => {
  it('extracts the real binary path, not the banner art', async () => {
    const ctx = makeCtx(async () => ({
      stdout: `${BANNER}\n/home/user/.local/bin/claude\n`,
      stderr: '',
    }));
    await expect(resolveCommandPath('claude', ctx, 'linux')).resolves.toBe(
      '/home/user/.local/bin/claude'
    );
  });

  it('returns null when only banner noise is present (command missing)', async () => {
    const ctx = makeCtx(async () => ({ stdout: `${BANNER}\n`, stderr: '' }));
    await expect(resolveCommandPath('claude', ctx, 'linux')).resolves.toBeNull();
  });

  it('matches on the command basename (windows executable extensions)', async () => {
    const ctx = makeCtx(async () => ({
      stdout: 'C:\\tools\\node\\node.exe\r\n',
      stderr: '',
    }));
    await expect(resolveCommandPath('node', ctx, 'windows')).resolves.toBe(
      'C:\\tools\\node\\node.exe'
    );
  });
});

describe('resolveAllCommandPaths with login-shell banner noise', () => {
  it('keeps every real match in PATH order and drops banner lines', async () => {
    const ctx = makeCtx(async () => ({
      stdout: `${BANNER}\n/home/user/.local/bin/claude\n/usr/local/bin/claude\n`,
      stderr: '',
    }));
    await expect(resolveAllCommandPaths('claude', ctx, 'linux')).resolves.toEqual([
      '/home/user/.local/bin/claude',
      '/usr/local/bin/claude',
    ]);
  });
});

describe('resolveRealpath with login-shell banner noise', () => {
  it('takes the resolved path printed after the banner', async () => {
    const ctx = makeCtx(async () => ({
      stdout: `${BANNER}\n/home/user/.local/share/claude/versions/2.1.202\n`,
      stderr: '',
    }));
    await expect(resolveRealpath('/home/user/.local/bin/claude', ctx, 'linux')).resolves.toBe(
      '/home/user/.local/share/claude/versions/2.1.202'
    );
  });
});

describe('transport failures propagate instead of reading as absence', () => {
  const transportError = Object.assign(new Error('SSH transport failure: channel open timed out'), {
    transportFailure: true,
  });

  it('resolveCommandPath rethrows a transport failure', async () => {
    const ctx = makeCtx(async () => {
      throw transportError;
    });
    await expect(resolveCommandPath('git', ctx, 'linux')).rejects.toBe(transportError);
  });

  it('resolveAllCommandPaths rethrows a transport failure', async () => {
    const ctx = makeCtx(async () => {
      throw transportError;
    });
    await expect(resolveAllCommandPaths('git', ctx, 'linux')).rejects.toBe(transportError);
  });

  it('resolveRealpath rethrows a transport failure', async () => {
    const ctx = makeCtx(async () => {
      throw transportError;
    });
    await expect(resolveRealpath('/usr/bin/git', ctx, 'linux')).rejects.toBe(transportError);
  });

  it('ordinary exec failures still read as absence', async () => {
    const ctx = makeCtx(async () => {
      throw new Error('exit 1');
    });
    await expect(resolveCommandPath('git', ctx, 'linux')).resolves.toBeNull();
    await expect(resolveAllCommandPaths('git', ctx, 'linux')).resolves.toEqual([]);
  });
});

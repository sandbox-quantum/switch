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

describe('resolveCommandPath on Windows', () => {
  function recordingCtx(stdout: string) {
    const calls: string[][] = [];
    const ctx = makeCtx(async (command, args) => {
      calls.push([command, ...args]);
      return { stdout, stderr: '' };
    });
    return { ctx, calls };
  }

  it('asks `where` for a path as dir:name, which it can parse', async () => {
    const path = 'C:\\Users\\KRISHNA ASWANI T\\.local\\bin\\claude.exe';
    const { ctx, calls } = recordingCtx(`${path}\r\n`);
    await expect(resolveCommandPath(path, ctx, 'windows')).resolves.toBe(path);
    expect(calls).toEqual([['where', 'C:\\Users\\KRISHNA ASWANI T\\.local\\bin:claude.exe']]);
  });

  it('keeps the root of a drive a directory', async () => {
    const { ctx, calls } = recordingCtx('C:\\claude.exe\r\n');
    await expect(resolveCommandPath('C:\\claude.exe', ctx, 'windows')).resolves.toBe(
      'C:\\claude.exe'
    );
    expect(calls).toEqual([['where', 'C:\\:claude.exe']]);
  });

  it('passes a bare name through', async () => {
    const { ctx, calls } = recordingCtx('C:\\tools\\claude.exe\r\n');
    await resolveCommandPath('claude', ctx, 'windows');
    expect(calls).toEqual([['where', 'claude']]);
  });

  it('skips npm’s extensionless shell script for the .cmd beside it', async () => {
    const npm = 'C:\\Users\\Phil\\AppData\\Roaming\\npm';
    const { ctx } = recordingCtx(`${npm}\\opencode\r\n${npm}\\opencode.cmd\r\n`);
    await expect(resolveCommandPath('opencode', ctx, 'windows')).resolves.toBe(
      `${npm}\\opencode.cmd`
    );
    await expect(resolveAllCommandPaths('opencode', ctx, 'windows')).resolves.toEqual([
      `${npm}\\opencode.cmd`,
    ]);
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

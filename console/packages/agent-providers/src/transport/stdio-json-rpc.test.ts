import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { StdioJsonRpcClient, noopLogger } from './stdio-json-rpc';
let client: StdioJsonRpcClient | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await client?.dispose();
  client = null;
});
it('times out an unacknowledged startup request without resending it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  client = new StdioJsonRpcClient({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    env: {},
    logger: noopLogger,
    onExit: () => {},
  });
  const pending = client.request('initialize', {});
  const rejected = expect(pending).rejects.toThrow('outcome is unknown and it was not resent');
  await vi.advanceTimersByTimeAsync(60000);
  await rejected;
});
it('rejects requests after the process exits', async () => {
  let exited: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    exited = resolve;
  });
  client = new StdioJsonRpcClient({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    cwd: process.cwd(),
    env: {},
    logger: noopLogger,
    onExit: exited,
  });
  await done;
  await expect(client.request('initialize', {})).rejects.toThrow('process is gone');
});

it('bounds an unterminated native protocol line and interrupts the process', async () => {
  let finish: (reason: string) => void = () => {};
  const exited = new Promise<string>((resolve) => {
    finish = resolve;
  });
  client = new StdioJsonRpcClient({
    command: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(17 * 1024 * 1024));setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: {},
    logger: noopLogger,
    onExit: finish,
  });
  expect(await exited).toContain('exceeds 16 MiB');
});

it.each(['stdout', 'stderr'])(
  'rejects sign-in output on %s and waits for process cleanup',
  async (stream) => {
    const warn = vi.fn();
    client = new StdioJsonRpcClient({
      command: process.execPath,
      args: ['-e', `process.${stream}.write('LOGIN REQUIRED\\n'); setInterval(() => {}, 1000)`],
      cwd: process.cwd(),
      env: {},
      logger: { ...noopLogger, warn },
      onExit: () => {},
      rejectOutputLine: (line) =>
        line.includes('LOGIN REQUIRED') ? 'Sign in explicitly.' : undefined,
    });
    await expect(client.request('authenticate', {})).rejects.toThrow('Sign in explicitly.');
    await client.dispose();
    expect(client.isAlive).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  }
);

// Saves 300 ms after its input closes, as Kimi Code saves its sessions; a
// SIGTERM, which it does not handle, ends it at once.
const SAVES_ON_CLOSED_INPUT = `
const { writeFileSync } = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () =>
  setTimeout(() => {
    writeFileSync(process.argv[1], 'saved');
    process.exit(0);
  }, 300)
);
`;

async function stopAfterSaving(exitsOnClosedInput: boolean): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), 'switch-stdio-'));
  const saved = join(dir, 'saved');
  try {
    client = new StdioJsonRpcClient({
      command: process.execPath,
      args: ['-e', SAVES_ON_CLOSED_INPUT, saved],
      cwd: process.cwd(),
      env: {},
      logger: noopLogger,
      onExit: () => {},
      exitsOnClosedInput,
    });
    await client.dispose();
    return await readFile(saved, 'utf8').catch(() => null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it('stops a process that saves as its input closes by closing its input alone', async () => {
  expect(await stopAfterSaving(true)).toBe('saved');
});

it.skipIf(process.platform === 'win32')(
  'otherwise sends SIGTERM as its input closes, which such a process does not survive',
  async () => {
    expect(await stopAfterSaving(false)).toBeNull();
  }
);

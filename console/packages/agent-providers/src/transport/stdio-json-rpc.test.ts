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

/** A process that saves for a moment once its input closes, and records which stop it got. */
const SAVES_ON_CLOSED_INPUT = `
const { writeFileSync } = require('node:fs');
const out = process.argv[1];
process.on('SIGTERM', () => { writeFileSync(out, 'sigterm'); process.exit(0); });
process.stdin.on('end', () => setTimeout(() => { writeFileSync(out, 'saved'); process.exit(0); }, 200));
process.stdin.resume();
`;

it.skipIf(process.platform === 'win32').each([
  [true, 'saved'],
  [false, 'sigterm'],
])(
  'with exitsOnClosedInput %s, stopping the process ends in %j',
  async (exitsOnClosedInput, outcome) => {
    const dir = await mkdtemp(join(tmpdir(), 'stdio-stop-'));
    const out = join(dir, 'outcome');
    client = new StdioJsonRpcClient({
      command: process.execPath,
      args: ['-e', SAVES_ON_CLOSED_INPUT, out],
      cwd: process.cwd(),
      env: {},
      logger: noopLogger,
      onExit: () => {},
      exitsOnClosedInput,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await client.dispose();
    expect(await readFile(out, 'utf8')).toBe(outcome);
    await rm(dir, { recursive: true, force: true });
  }
);

it('still kills a process that ignores its closed input', async () => {
  client = new StdioJsonRpcClient({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    env: {},
    logger: noopLogger,
    onExit: () => {},
    exitsOnClosedInput: true,
  });
  await client.dispose();
  expect(client.isAlive).toBe(false);
});

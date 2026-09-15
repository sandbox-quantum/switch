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

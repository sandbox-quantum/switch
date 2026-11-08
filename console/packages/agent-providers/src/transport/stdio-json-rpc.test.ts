import { afterEach, expect, it, vi } from 'vitest';
import { StdioJsonRpcClient, noopLogger } from './stdio-json-rpc';
let client: StdioJsonRpcClient | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await client?.dispose();
  client = null;
});

it.each(['result', 'error'])(
  'observes a %s response before a following notification',
  async (kind) => {
    const response =
      kind === 'result'
        ? { jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } }
        : { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'test error' } };
    const line = `${JSON.stringify(response)}\n${JSON.stringify({ jsonrpc: '2.0', method: 'next', params: {} })}\n`;
    client = new StdioJsonRpcClient({
      command: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(line)}); setInterval(() => {}, 1000)`],
      cwd: process.cwd(),
      env: {},
      logger: noopLogger,
      onExit: () => {},
    });
    const order: string[] = [];
    client.onNotification('next', () => order.push('notification'));
    const pending = client.request('session/prompt', {}, () => order.push('response'));
    if (kind === 'result') await expect(pending).resolves.toEqual({ stopReason: 'end_turn' });
    else await expect(pending).rejects.toThrow('test error');
    expect(order).toEqual(['response', 'notification']);
  }
);

it('rejects a request if its response observer fails', async () => {
  const line = `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`;
  client = new StdioJsonRpcClient({
    command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(line)}); setInterval(() => {}, 1000)`],
    cwd: process.cwd(),
    env: {},
    logger: noopLogger,
    onExit: () => {},
  });
  await expect(
    client.request('session/prompt', {}, () => {
      throw new Error('observer failed');
    })
  ).rejects.toThrow('observer failed');
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

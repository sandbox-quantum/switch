import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { processGroupsFor } from '../process-tree';
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
    sessionId: null,
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
    sessionId: null,
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
    sessionId: null,
    command: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(17 * 1024 * 1024));setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: {},
    logger: noopLogger,
    onExit: finish,
  });
  expect(await exited).toContain('exceeds 16 MiB');
});

it('reaps a grandchild the provider left behind, and stops recording the group', async () => {
  const marker = join(tmpdir(), `sdk-grandchild-${randomUUID()}`);
  const sessionId = `session-${randomUUID()}`;
  let exited: () => void = () => {};
  const gone = new Promise<void>((resolve) => {
    exited = resolve;
  });
  client = new StdioJsonRpcClient({
    sessionId,
    command: process.execPath,
    // The provider starts a tool and dies. Its own pid is no handle on the
    // grandchild; only the process group is.
    args: [
      '-e',
      `const {spawn}=require('node:child_process');` +
        `const c=spawn('sleep',['1000'],{stdio:'ignore'});` +
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));` +
        `setTimeout(()=>process.exit(0),50);`,
    ],
    cwd: process.cwd(),
    env: {},
    logger: noopLogger,
    onExit: () => exited(),
  });
  // The group is recorded from the moment it is spawned, so a host that dies
  // before teardown still leaves something to sweep by.
  expect(processGroupsFor(sessionId)).toHaveLength(1);
  await gone;

  const grandchild = Number(await readFile(marker, 'utf8'));
  expect(grandchild).toBeGreaterThan(1);

  // An adapter drops a session whose provider died, so nothing would call
  // `dispose` for it: the group is reaped on the leader's exit or never.
  await vi.waitFor(() => expect(() => process.kill(grandchild, 0)).toThrow());
  // And only then does the record stop naming it, so a later claim does not
  // sweep an id that has since been handed to someone else.
  await vi.waitFor(() => expect(processGroupsFor(sessionId)).toEqual([]));

  await client.dispose();
  await rm(marker, { force: true });
});

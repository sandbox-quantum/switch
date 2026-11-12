import { beforeEach, expect, it, vi } from 'vitest';
import { noopLogger } from '../transport/stdio-json-rpc';
import { FAKE_PI_SESSION_ID, FakePi } from './fake-pi';

const spawned: FakePi[] = [];
vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[], options: { env: Record<string, string> }) => {
    const pi = new FakePi(args, options.env);
    spawned.push(pi);
    return pi;
  },
}));

const { PiCommandError, PiRpcClient } = await import('./rpc-client');

beforeEach(() => {
  spawned.length = 0;
});

function client() {
  const records: Array<Record<string, unknown>> = [];
  const exits: string[] = [];
  const rpc = new PiRpcClient({
    command: 'pi',
    args: ['--mode', 'rpc'],
    cwd: '/work',
    env: {},
    logger: noopLogger,
    onRecord: (record) => records.push(record),
    onExit: (reason) => exits.push(reason),
  });
  return { rpc, records, exits, pi: spawned.at(-1)! };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

it('splits records on LF alone, so a line separator inside a string stays in its record, and reads a CRLF ending', async () => {
  const { pi, records } = client();
  const line = `${JSON.stringify({ type: 'message_update', delta: 'a b c' })}\r\n`;
  const bytes = Buffer.from(
    line + JSON.stringify({ type: 'agent_settled', aborted: false }) + '\n'
  );
  // Split inside the multi-byte character, as a pipe may deliver it.
  const cut = bytes.indexOf(0xe2) + 1;
  pi.stdout.write(bytes.subarray(0, cut));
  pi.stdout.write(bytes.subarray(cut));
  await flush();
  expect(records).toEqual([
    { type: 'message_update', delta: 'a b c' },
    { type: 'agent_settled', aborted: false },
  ]);
});

it("resolves a command with its data, and rejects one Pi refuses with Pi's words", async () => {
  const { rpc, pi } = client();
  expect(await rpc.command('get_state')).toMatchObject({
    sessionId: FAKE_PI_SESSION_ID,
    messageCount: 0,
  });
  pi.answer('set_model', () => ({ error: 'Model not found: mistral/nope' }));
  const refused = rpc.command('set_model', { provider: 'mistral', modelId: 'nope' });
  await expect(refused).rejects.toBeInstanceOf(PiCommandError);
  await expect(refused).rejects.toThrow('Model not found: mistral/nope');
  expect(pi.received).toMatchObject([
    { id: 'switch-1', type: 'get_state' },
    { id: 'switch-2', type: 'set_model', provider: 'mistral', modelId: 'nope' },
  ]);
});

it('rejects what is still waiting when Pi exits, and says so once', async () => {
  const { rpc, pi, exits } = client();
  pi.answer('abort', () => null);
  const aborting = rpc.command('abort');
  pi.exit(1, null);
  await expect(aborting).rejects.toThrow('Pi exited (code 1, signal null) while awaiting abort');
  expect(exits).toEqual(['Pi exited (code 1, signal null)']);
  expect(rpc.isAlive).toBe(false);
  await expect(rpc.command('get_state')).rejects.toThrow('Pi is gone');
});

it("closes Pi's input to stop it, which is all Windows is asked before the kill", async () => {
  const { rpc, pi, exits } = client();
  await rpc.dispose();
  expect(pi.stdin.writableEnded).toBe(true);
  await rpc.dispose();
  await vi.waitFor(() => expect(exits).toHaveLength(1));
});

it('stops Pi when a record grows past 16 MiB', async () => {
  const { pi, exits } = client();
  const kill = vi.spyOn(pi, 'kill');
  pi.stdout.write(`{"type":"message_update","delta":"${'x'.repeat(16 * 1024 * 1024)}`);
  await flush();
  expect(kill).toHaveBeenCalledWith('SIGKILL');
  expect(exits).toEqual(['A Pi record exceeds 16 MiB. Execution was interrupted.']);
});
